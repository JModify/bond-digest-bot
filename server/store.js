import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createHistory } from "./history.js";
import { transaction } from "./sqlite.js";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const automaticRetentionMs = 7 * dayMs;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA secure_delete = ON;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status_key_hash TEXT NOT NULL,
      title_code TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'waiting',
      available_at INTEGER,
      raw BLOB,
      attempts INTEGER NOT NULL DEFAULT 0,
      reason TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state, available_at, created_at);
    CREATE INDEX IF NOT EXISTS jobs_created_at ON jobs (created_at);
    CREATE INDEX IF NOT EXISTS jobs_recipient_created_at ON jobs (recipient, created_at);
  `);
  const history = createHistory(db);
  if (!db.prepare("PRAGMA table_info(jobs)").all().some(({ name }) => name === "history_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN history_id INTEGER");
  }

  // Retain the original column layout so pending jobs and the existing database survive upgrades.
  const accept = db.prepare(`
    INSERT INTO jobs (id, status_key_hash, title_code, recipient, subject, created_at, expires_at, state, available_at, raw)
    SELECT ?, '', '', ?, ?, ?, ?, 'queued', ?, ?
    WHERE (SELECT count(*) FROM jobs WHERE state IN ('queued', 'processing', 'sending')) < 15
      AND (SELECT count(*) FROM jobs WHERE created_at > ?) < 60
      AND (SELECT count(*) FROM jobs WHERE recipient = ? AND created_at > ?) < 8
    ON CONFLICT(id) DO NOTHING
  `);
  const find = db.prepare("SELECT history_id FROM jobs WHERE id = ?");
  const missingHistory = db.prepare("SELECT id, recipient, subject, created_at, state, reason FROM jobs WHERE history_id IS NULL");
  const linkHistory = db.prepare("UPDATE jobs SET history_id = ? WHERE id = ?");
  const enqueueResend = db.prepare(`
    INSERT INTO jobs (id, status_key_hash, title_code, recipient, subject, created_at, expires_at, state, available_at, history_id)
    SELECT ?, '', '', ?, ?, ?, ?, 'queued', ?, ?
    WHERE (SELECT count(*) FROM jobs WHERE state IN ('queued', 'processing', 'sending')) < 15
  `);
  const pendingCount = db.prepare("SELECT count(*) AS count FROM jobs WHERE state IN ('queued', 'processing', 'sending')");
  const claim = db.prepare(`
    UPDATE jobs SET state = 'processing'
    WHERE id = (SELECT id FROM jobs WHERE state = 'queued' AND available_at <= ? ORDER BY created_at, id LIMIT 1)
    RETURNING id, recipient, subject, raw, attempts, created_at AS queuedAt, history_id AS historyId,
      (SELECT original_id FROM digest_history WHERE digest_history.id = jobs.history_id) AS originalId
  `);
  const markSending = db.prepare("UPDATE jobs SET state = 'sending', attempts = attempts + 1 WHERE id = ?");
  const scheduleRetry = db.prepare("UPDATE jobs SET state = 'queued', available_at = ? WHERE id = ?");
  const finishJob = db.prepare("UPDATE jobs SET state = ?, reason = ?, raw = NULL WHERE id = ?");
  const expireWaiting = db.prepare("UPDATE jobs SET state = 'expired' WHERE state = 'waiting' AND expires_at <= ? RETURNING history_id");
  const deleteExpired = db.prepare(`
    DELETE FROM jobs
    WHERE expires_at < ? AND state NOT IN ('queued', 'processing', 'sending')
  `);

  transaction(db, () => {
    for (const old of missingHistory.all()) {
      const id = history.add({ kind: "incoming", source: old.recipient, recipient: old.recipient,
        subject: old.subject, at: old.created_at, state: old.state, eventName: "imported",
        description: "Imported from the existing queue. Earlier events and outgoing content may be unavailable." });
      if (old.reason) history.note(id, old.created_at, old.state, old.reason);
      linkHistory.run(id, old.id);
    }
  });

  return {
    recover(now = Date.now()) {
      transaction(db, () => {
        const queued = db.prepare("UPDATE jobs SET state = 'queued' WHERE state = 'processing' RETURNING history_id");
        for (const row of queued.all()) history.mark(row.history_id, now, "queued", "Returned to the queue after restart.");
        const uncertain = db.prepare(`
          UPDATE jobs SET state = 'uncertain', reason = 'interrupted', raw = NULL WHERE state = 'sending' RETURNING history_id
        `);
        for (const row of uncertain.all()) history.mark(row.history_id, now, "uncertain", "Service restarted during the SES request.");
      });
    },
    enqueueIncoming({ recipient, messageId, subject, sourceSubject = "", method, raw }, now = Date.now()) {
      const id = hash(recipient + "\0" + messageId);
      // Pruning allows one day after expires_at, including for older queue records.
      const expiresAt = now + automaticRetentionMs - dayMs;
      const rateLimitSince = now - hourMs;
      return transaction(db, () => {
        const result = accept.run(id, recipient, subject, now, expiresAt, now, raw, rateLimitSince, recipient, rateLimitSince);
        if (result.changes) {
          const historyId = history.add({ kind: "incoming", source: recipient, recipient, subject: sourceSubject, at: now,
            state: "queued", eventName: "received", description: method ? `Authenticated via ${method.toUpperCase()}.` : "Received by SMTP." });
          history.note(historyId, now, "queued", "Scheduled for formatting and delivery.");
          linkHistory.run(historyId, id);
          return "queued";
        }
        const existing = find.get(id);
        if (!existing) return "busy";
        history.note(existing.history_id, now, "duplicate", "SMTP retry acknowledged. No additional send was queued.");
        return "duplicate";
      });
    },
    recordSmtpAttempt({ source, state, description }, now = Date.now()) {
      return transaction(db, () => history.add({ kind: "smtp_attempt", source, at: now, state, description }));
    },
    queueResend({ originalId, recipient, actor, requestKey }, now = Date.now()) {
      return transaction(db, () => {
        const previous = history.findRequest(requestKey);
        if (previous) return { id: previous, state: "duplicate" };
        const selected = history.get(originalId);
        if (!selected?.can_resend) return { state: "unavailable" };
        if (pendingCount.get().count >= 15) return { state: "busy" };
        const original = selected.original_id ? history.get(selected.original_id) : selected;
        const id = history.add({ kind: "resend", originalId: original.id, requestKey, source: original.source, recipient,
          subject: original.output_subject || original.subject, actor, at: now, state: "queued", description: "Resend requested from the admin panel." });
        const result = enqueueResend.run(hash("resend\0" + requestKey), recipient, original.output_subject || original.subject,
          now, now + automaticRetentionMs - dayMs, now, id);
        if (!result.changes) throw new Error("Resend could not be enqueued");
        return { id, state: "queued" };
      });
    },
    claim(now = Date.now()) {
      return transaction(db, () => {
        const job = claim.get(now);
        if (job) history.mark(job.historyId, now, "processing", job.originalId ? "Preparing the archived email." : "Formatting the digest.");
        return job;
      });
    },
    sending(id, { raw, subject, detail } = {}, now = Date.now()) {
      transaction(db, () => {
        const { history_id: historyId } = find.get(id);
        if (raw) history.archive(historyId, subject, raw);
        markSending.run(id);
        history.mark(historyId, now, "sending", detail);
      });
    },
    retry(id, delay, now = Date.now(), detail = "SES throttled this request.") {
      transaction(db, () => {
        scheduleRetry.run(now + delay, id);
        history.mark(find.get(id).history_id, now, "retry_wait", `${detail} Retrying in ${Math.round(delay / 1000)} seconds.`);
      });
    },
    finish(id, state, reason = null, { detail, messageId } = {}, now = Date.now()) {
      transaction(db, () => {
        finishJob.run(state, reason, id);
        history.mark(find.get(id).history_id, now, state, detail ?? reason ?? "", messageId ?? null);
      });
    },
    prune(now = Date.now()) {
      transaction(db, () => {
        for (const row of expireWaiting.all(now)) history.mark(row.history_id, now, "expired", "The old queue request expired.");
        deleteExpired.run(now - dayMs);
      });
    },
    pending: () => pendingCount.get().count,
    history,
    close() {
      db.close();
    },
  };
}

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const automaticRetentionMs = 7 * dayMs;
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA secure_delete = ON;
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

  // Retain the original column layout so pending jobs and the existing database survive upgrades.
  const accept = db.prepare(`
    INSERT INTO jobs (id, status_key_hash, title_code, recipient, subject, created_at, expires_at, state, available_at, raw)
    SELECT ?, '', '', ?, ?, ?, ?, 'queued', ?, ?
    WHERE (SELECT count(*) FROM jobs WHERE state IN ('queued', 'processing', 'sending')) < 15
      AND (SELECT count(*) FROM jobs WHERE created_at > ?) < 60
      AND (SELECT count(*) FROM jobs WHERE recipient = ? AND created_at > ?) < 8
    ON CONFLICT(id) DO NOTHING
  `);
  const find = db.prepare("SELECT id FROM jobs WHERE id = ?");
  const claim = db.prepare(`
    UPDATE jobs SET state = 'processing'
    WHERE id = (SELECT id FROM jobs WHERE state = 'queued' AND available_at <= ? ORDER BY created_at, id LIMIT 1)
    RETURNING id, recipient, subject, raw, attempts, created_at AS queuedAt
  `);
  const markSending = db.prepare("UPDATE jobs SET state = 'sending', attempts = attempts + 1 WHERE id = ?");
  const scheduleRetry = db.prepare("UPDATE jobs SET state = 'queued', available_at = ? WHERE id = ?");
  const finishJob = db.prepare("UPDATE jobs SET state = ?, reason = ?, raw = NULL WHERE id = ?");
  const expireWaiting = db.prepare("UPDATE jobs SET state = 'expired' WHERE state = 'waiting' AND expires_at <= ?");
  const deleteExpired = db.prepare(`
    DELETE FROM jobs
    WHERE expires_at < ? AND state NOT IN ('queued', 'processing', 'sending')
  `);

  return {
    recover() {
      db.exec(`
        UPDATE jobs SET state = 'queued' WHERE state = 'processing';
        UPDATE jobs SET state = 'uncertain', reason = 'interrupted', raw = NULL WHERE state = 'sending';
      `);
    },
    enqueueIncoming({ recipient, messageId, subject, raw }, now = Date.now()) {
      const id = hash(recipient + "\0" + messageId);
      // Pruning allows one day after expires_at, including for older queue records.
      const expiresAt = now + automaticRetentionMs - dayMs;
      const rateLimitSince = now - hourMs;
      const result = accept.run(id, recipient, subject, now, expiresAt, now, raw, rateLimitSince, recipient, rateLimitSince);
      if (result.changes) return "queued";
      return find.get(id) ? "duplicate" : "busy";
    },
    claim(now = Date.now()) {
      return claim.get(now);
    },
    sending(id) {
      markSending.run(id);
    },
    retry(id, delay, now = Date.now()) {
      scheduleRetry.run(now + delay, id);
    },
    finish(id, state, reason = null) {
      finishJob.run(state, reason, id);
    },
    prune(now = Date.now()) {
      expireWaiting.run(now);
      deleteExpired.run(now - dayMs);
    },
    close() {
      db.close();
    },
  };
}

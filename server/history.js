import { gunzipSync, gzipSync } from "node:zlib";

const pageSize = 25;

export function createHistory(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS digest_history (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      original_id INTEGER REFERENCES digest_history(id),
      request_key TEXT UNIQUE,
      source TEXT NOT NULL,
      recipient TEXT NOT NULL,
      subject TEXT NOT NULL,
      output_subject TEXT,
      created_at INTEGER NOT NULL,
      state TEXT NOT NULL,
      actor TEXT,
      ses_message_id TEXT,
      mime BLOB
    ) STRICT;
    CREATE INDEX IF NOT EXISTS digest_history_state ON digest_history(state, id DESC);
    CREATE TABLE IF NOT EXISTS digest_history_events (
      id INTEGER PRIMARY KEY,
      history_id INTEGER NOT NULL REFERENCES digest_history(id),
      at INTEGER NOT NULL,
      event TEXT NOT NULL,
      detail TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS digest_events_history ON digest_history_events(history_id, id);
  `);

  const insert = db.prepare(`
    INSERT INTO digest_history (kind, original_id, request_key, source, recipient, subject, created_at, state, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const event = db.prepare("INSERT INTO digest_history_events (history_id, at, event, detail) VALUES (?, ?, ?, ?)");
  const status = db.prepare(`
    UPDATE digest_history SET state = ?, ses_message_id = COALESCE(?, ses_message_id) WHERE id = ?
  `);
  const saveMime = db.prepare("UPDATE digest_history SET output_subject = ?, mime = ? WHERE id = ? AND mime IS NULL");
  const fields = `id, kind, original_id, source, recipient, subject, output_subject, created_at, state, actor, ses_message_id,
    EXISTS (SELECT 1 FROM digest_history AS original WHERE original.id = COALESCE(digest_history.original_id, digest_history.id)
      AND original.mime IS NOT NULL) AS can_resend`;
  const detail = db.prepare(`SELECT ${fields} FROM digest_history WHERE id = ?`);
  const events = db.prepare("SELECT at, event, detail FROM digest_history_events WHERE history_id = ? ORDER BY id");
  const count = db.prepare("SELECT count(*) AS total FROM digest_history");
  const countState = db.prepare("SELECT count(*) AS total FROM digest_history WHERE state = ?");
  const list = db.prepare(`SELECT ${fields} FROM digest_history ORDER BY id DESC LIMIT ? OFFSET ?`);
  const listState = db.prepare(`SELECT ${fields} FROM digest_history WHERE state = ? ORDER BY id DESC LIMIT ? OFFSET ?`);
  const readMime = db.prepare("SELECT mime FROM digest_history WHERE id = ?");
  const request = db.prepare("SELECT id FROM digest_history WHERE request_key = ?");

  function note(id, at, name, description = "") {
    event.run(id, at, name, description);
  }

  return {
    add({ kind, originalId = null, requestKey = null, source = "", recipient = "", subject = "", at, state, actor = null,
      eventName = state, description = "" }) {
      const id = Number(insert.run(kind, originalId, requestKey, source, recipient, subject, at, state, actor).lastInsertRowid);
      note(id, at, eventName, description);
      return id;
    },
    note,
    mark(id, at, state, description = "", sesMessageId = null) {
      status.run(state, sesMessageId, id);
      note(id, at, state, description);
    },
    archive(id, subject, raw) {
      saveMime.run(subject, gzipSync(raw, { level: 1 }), id);
    },
    readArchived(id) {
      const bytes = readMime.get(id)?.mime;
      return bytes ? gunzipSync(bytes) : undefined;
    },
    findRequest(key) {
      return request.get(key)?.id;
    },
    get(id) {
      const message = detail.get(id);
      return message ? { ...message, events: events.all(id) } : undefined;
    },
    page(requested, state) {
      const { total } = state ? countState.get(state) : count.get();
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.max(1, Math.min(requested, pages));
      const offset = (page - 1) * pageSize;
      const rows = state ? listState.all(state, pageSize, offset) : list.all(pageSize, offset);
      return { rows, page, pages, total };
    },
  };
}

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { transaction } from "../sqlite.js";

export const ownerName = "jlavagna";
export const sessionSeconds = 8 * 60 * 60;
export const passwordHint = "Use at least 14 characters.";
const deriveKey = promisify(scrypt);
const emptyHash = Buffer.alloc(64);

export function validUsername(value) {
  return /^[a-z0-9][a-z0-9_.-]{2,31}$/.test(value);
}

export function validPassword(value) {
  return value.length >= 14 && value.length <= 128 && Buffer.byteLength(value, "utf8") <= 256;
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const key = await deriveKey(password, salt, 64);
  return `${salt}:${key.toString("base64url")}`;
}

export async function checkPassword(password, hash) {
  if (Buffer.byteLength(password, "utf8") > 256) return false;
  const [salt, encoded] = (hash ?? "unprovisioned-account:").split(":");
  const expected = encoded ? Buffer.from(encoded, "base64url") : emptyHash;
  const key = await deriveKey(password, salt, 64);
  return timingSafeEqual(key, expected) && Boolean(hash);
}

const tokenHash = (token) => createHash("sha256").update(token).digest("hex");

export function openAccounts(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer'))
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS admin_only_one_owner ON admin_users(role) WHERE role = 'owner';
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS admin_activity (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL
    ) STRICT;
  `);

  const owner = db.prepare("SELECT id FROM admin_users WHERE role = 'owner'");
  const byName = db.prepare("SELECT id, username, password_hash, role FROM admin_users WHERE username = ?");
  const byId = db.prepare("SELECT id, username, password_hash, role FROM admin_users WHERE id = ?");
  const users = db.prepare("SELECT id, username, role FROM admin_users ORDER BY role != 'owner', username");
  const insert = db.prepare("INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)");
  const update = db.prepare("UPDATE admin_users SET username = ?, role = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?");
  const updatePassword = db.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?");
  const remove = db.prepare("DELETE FROM admin_users WHERE id = ?");
  const getSession = db.prepare(`
    SELECT id, username, role FROM admin_users JOIN admin_sessions ON admin_users.id = admin_sessions.user_id
    WHERE token = ? AND expires > ?
  `);
  const createSession = db.prepare("INSERT INTO admin_sessions (token, user_id, expires) VALUES (?, ?, ?)");
  const deleteSession = db.prepare("DELETE FROM admin_sessions WHERE token = ?");
  const deleteUserSessions = db.prepare("DELETE FROM admin_sessions WHERE user_id = ?");
  const deleteExpired = db.prepare("DELETE FROM admin_sessions WHERE expires <= ?");
  const getSetting = db.prepare("SELECT value FROM admin_settings WHERE key = ?");
  const setSetting = db.prepare(`
    INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const insertActivity = db.prepare("INSERT INTO admin_activity (at, actor, action, detail) VALUES (?, ?, ?, ?)");
  const activity = db.prepare("SELECT at, actor, action, detail FROM admin_activity ORDER BY id DESC LIMIT 30");
  const lastActivity = db.prepare("SELECT at FROM admin_activity WHERE action = ? ORDER BY id DESC LIMIT 1");

  function record(actor, action, detail, now = Date.now()) {
    insertActivity.run(now, actor, action, detail);
  }

  return {
    byName: (username) => byName.get(username),
    byId: (id) => byId.get(id),
    list: () => users.all(),
    hasOwner: () => Boolean(owner.get()),
    provision(hash, reset) {
      return transaction(db, () => {
        const existing = owner.get();
        if (existing && !reset) return false;
        if (existing) {
          updatePassword.run(hash, existing.id);
          deleteUserSessions.run(existing.id);
        } else insert.run(ownerName, hash, "owner");
        record("EC2 terminal", existing ? "Owner password reset" : "Owner created", ownerName);
        return true;
      });
    },
    addUser(actor, username, role, hash) {
      transaction(db, () => {
        insert.run(username, hash, role);
        record(actor, "User added", `${username} (${role})`);
      });
    },
    updateUser(actor, current, username, role, hash) {
      transaction(db, () => {
        update.run(username, role, hash, current.id);
        if (hash || username !== current.username || role !== current.role) deleteUserSessions.run(current.id);
        record(actor, "User edited", `${current.username} → ${username} (${role})`);
      });
    },
    removeUser(actor, current) {
      transaction(db, () => {
        remove.run(current.id);
        record(actor, "User deleted", current.username);
      });
    },
    changePassword(user, hash) {
      transaction(db, () => {
        updatePassword.run(hash, user.id);
        deleteUserSessions.run(user.id);
        record(user.username, "Password changed", user.username);
      });
    },
    signIn(user, now = Date.now()) {
      const token = randomBytes(32).toString("base64url");
      transaction(db, () => {
        deleteExpired.run(now);
        createSession.run(tokenHash(token), user.id, now + sessionSeconds * 1000);
        record(user.username, "Signed in", "Admin panel", now);
      });
      return token;
    },
    session: (token, now = Date.now()) => getSession.get(tokenHash(token), now),
    signOut: (token) => deleteSession.run(tokenHash(token)),
    outgoingPaused: () => getSetting.get("outgoing_paused")?.value === "true",
    pauseOutgoing(actor, paused) {
      transaction(db, () => {
        setSetting.run("outgoing_paused", String(paused));
        record(actor, paused ? "Mail paused" : "Mail resumed", "Digest Bot outgoing queue");
      });
    },
    record,
    activity: () => activity.all(),
    lastActivity: (action) => lastActivity.get(action)?.at,
    close: () => db.close(),
  };
}

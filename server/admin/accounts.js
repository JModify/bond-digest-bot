import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { defaultCareersDay, weekdays } from "../careers.js";
import { transaction } from "../sqlite.js";
import { defaultRoles } from "./permissions.js";

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
const withPermissions = (row) => row && { ...row, permissions: JSON.parse(row.permissions) };
const siteAction = { update: "Site update", restart: "Site rebuild" };

function createAccountTables(db) {
  transaction(db, () => {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?");
    const needsRoles = !hasTable.get("admin_roles");
    const migrate = hasTable.get("admin_users")
      && !db.prepare("PRAGMA foreign_key_list(admin_users)").all().some(({ table }) => table === "admin_roles");
    if (migrate) {
      db.exec(`
        ALTER TABLE admin_sessions RENAME TO admin_sessions_legacy;
        ALTER TABLE admin_users RENAME TO admin_users_legacy;
      `);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        permissions TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL REFERENCES admin_roles(id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        expires INTEGER NOT NULL
      ) STRICT;
    `);
    if (needsRoles) {
      const insert = db.prepare("INSERT INTO admin_roles (id, name, permissions) VALUES (?, ?, ?)");
      for (const [id, name, permissions] of defaultRoles) insert.run(id, name, JSON.stringify(permissions));
    }
    if (migrate) {
      db.exec(`
        INSERT INTO admin_users SELECT id, username, password_hash, role FROM admin_users_legacy;
        INSERT INTO admin_sessions SELECT token, user_id, expires FROM admin_sessions_legacy;
        DELETE FROM sqlite_sequence WHERE name = 'admin_users';
        UPDATE sqlite_sequence SET name = 'admin_users' WHERE name = 'admin_users_legacy';
        DROP TABLE admin_sessions_legacy;
        DROP TABLE admin_users_legacy;
      `);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS admin_only_one_owner ON admin_users(role) WHERE role = 'owner'`);
  });
}

export function openAccounts(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") chmodSync(path, 0o600);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS admin_activity (
      id INTEGER PRIMARY KEY,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS admin_activity_latest ON admin_activity(at DESC, id DESC);
  `);
  createAccountTables(db);

  const owner = db.prepare("SELECT id FROM admin_users WHERE role = 'owner'");
  const access = "u.id, u.username, u.role, r.name AS role_name, r.permissions";
  const userRoles = "FROM admin_users u JOIN admin_roles r ON r.id = u.role";
  const byName = db.prepare(`SELECT ${access}, u.password_hash ${userRoles} WHERE u.username = ?`);
  const byId = db.prepare(`SELECT ${access}, u.password_hash ${userRoles} WHERE u.id = ?`);
  const users = db.prepare(`SELECT ${access} ${userRoles} ORDER BY u.role != 'owner', u.username`);
  const insert = db.prepare("INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)");
  const update = db.prepare("UPDATE admin_users SET username = ?, role = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?");
  const updatePassword = db.prepare("UPDATE admin_users SET password_hash = ? WHERE id = ?");
  const remove = db.prepare("DELETE FROM admin_users WHERE id = ?");
  const getSession = db.prepare(`
    SELECT ${access} ${userRoles} JOIN admin_sessions s ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?
  `);
  const roles = db.prepare(`
    SELECT r.id, r.name, r.permissions, (SELECT count(*) FROM admin_users u WHERE u.role = r.id) AS user_count
    FROM admin_roles r ORDER BY r.id != 'owner', r.id != 'viewer', r.name
  `);
  const role = db.prepare("SELECT id, name, permissions FROM admin_roles WHERE id = ?");
  const roleByName = db.prepare("SELECT id FROM admin_roles WHERE name = ?");
  const insertRole = db.prepare("INSERT INTO admin_roles (id, name, permissions) VALUES (?, ?, ?)");
  const saveRole = db.prepare("UPDATE admin_roles SET name = ?, permissions = ? WHERE id = ? AND id != 'owner'");
  const removeRole = db.prepare(`
    DELETE FROM admin_roles WHERE id = ? AND id != 'owner' AND NOT EXISTS (SELECT 1 FROM admin_users WHERE role = admin_roles.id)
  `);
  const createSession = db.prepare("INSERT INTO admin_sessions (token, user_id, expires) VALUES (?, ?, ?)");
  const deleteSession = db.prepare("DELETE FROM admin_sessions WHERE token = ?");
  const deleteUserSessions = db.prepare("DELETE FROM admin_sessions WHERE user_id = ?");
  const deleteExpired = db.prepare("DELETE FROM admin_sessions WHERE expires <= ?");
  const getSetting = db.prepare("SELECT value FROM admin_settings WHERE key = ?");
  const setSetting = db.prepare(`
    INSERT INTO admin_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const deleteSetting = db.prepare("DELETE FROM admin_settings WHERE key = ?");
  const insertActivity = db.prepare("INSERT INTO admin_activity (at, actor, action, detail) VALUES (?, ?, ?, ?)");
  const activity = db.prepare("SELECT at, actor, action, detail FROM admin_activity ORDER BY at DESC, id DESC LIMIT 20");
  const lastActivity = db.prepare("SELECT at FROM admin_activity WHERE action = ? ORDER BY id DESC LIMIT 1");

  function record(actor, action, detail, now = Date.now()) {
    return Number(insertActivity.run(now, actor, action, detail).lastInsertRowid);
  }

  function pendingSiteUpdate() {
    const value = getSetting.get("site_update")?.value;
    return value ? JSON.parse(value) : undefined;
  }

  function careersDay() {
    const saved = getSetting.get("careers_day")?.value;
    return weekdays.includes(saved) ? saved : defaultCareersDay;
  }

  return {
    byName: (username) => withPermissions(byName.get(username)),
    byId: (id) => withPermissions(byId.get(id)),
    list: () => users.all().map(withPermissions),
    roles: () => roles.all().map(withPermissions),
    role: (id) => withPermissions(role.get(id)),
    roleByName: (name) => roleByName.get(name),
    addRole(actor, name, permissions) {
      transaction(db, () => {
        insertRole.run(randomBytes(8).toString("hex"), name, JSON.stringify(permissions));
        record(actor, "Role added", name);
      });
    },
    updateRole(actor, current, name, permissions) {
      transaction(db, () => {
        saveRole.run(name, JSON.stringify(permissions), current.id);
        record(actor, "Role edited", current.name === name ? name : `${current.name} → ${name}`);
      });
    },
    deleteRole(actor, current) {
      return transaction(db, () => {
        if (!removeRole.run(current.id).changes) return false;
        record(actor, "Role deleted", current.name);
        return true;
      });
    },
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
        insert.run(username, hash, role.id);
        record(actor, "User added", `${username} (${role.name})`);
      });
    },
    updateUser(actor, current, username, role, hash) {
      transaction(db, () => {
        update.run(username, role.id, hash, current.id);
        if (hash || username !== current.username || role.id !== current.role) deleteUserSessions.run(current.id);
        record(actor, "User edited", `${current.username} → ${username} (${role.name})`);
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
    session: (token, now = Date.now()) => withPermissions(getSession.get(tokenHash(token), now)),
    signOut: (token) => deleteSession.run(tokenHash(token)),
    outgoingPaused: () => getSetting.get("outgoing_paused")?.value === "true",
    pauseOutgoing(actor, paused) {
      transaction(db, () => {
        setSetting.run("outgoing_paused", String(paused));
        record(actor, paused ? "Digest Bot frozen" : "Digest Bot resumed", "Outgoing mail queue");
      });
    },
    careersDay,
    setCareersDay(actor, day) {
      transaction(db, () => {
        const previous = careersDay();
        if (day === previous) return;
        setSetting.run("careers_day", day);
        record(actor, "Careers at Bond schedule changed", `${previous} → ${day}`);
      });
    },
    pendingSiteUpdate,
    startSiteUpdate(actor, kind, previousUpdatedAt) {
      return transaction(db, () => {
        if (pendingSiteUpdate()) return undefined;
        const at = Date.now();
        const id = record(actor, `${siteAction[kind]} requested`, "EC2 host updater", at);
        const pending = { id, at, actor, kind, previousUpdatedAt };
        setSetting.run("site_update", JSON.stringify(pending));
        return pending;
      });
    },
    finishSiteUpdate(pending, succeeded, detail, at) {
      transaction(db, () => {
        if (pendingSiteUpdate()?.id !== pending.id) return;
        record(pending.actor, `${siteAction[pending.kind]} ${succeeded ? "completed" : "failed"}`, detail, at);
        deleteSetting.run("site_update");
      });
    },
    record,
    activity: () => activity.all(),
    lastActivity: (action) => lastActivity.get(action)?.at,
    close: () => db.close(),
  };
}

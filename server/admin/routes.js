import { readFileSync } from "node:fs";
import { normaliseAddress } from "../../dist/core/mailbox.js";
import { checkPassword, hashPassword, openAccounts, sessionSeconds, validPassword, validUsername } from "./accounts.js";
import { createHostActions } from "./host.js";
import { adminPages, can, canManageRole, canViewSystem, permissions } from "./permissions.js";
import { accountPage, editRolePage, editUserPage, mailDetail, mailPage, messagePage, rolesPage, settingsFields, signIn,
  statuses, systemPage, usersPage } from "./views.js";

const assets = {
  "/admin/admin.css": ["text/css; charset=UTF-8", readFileSync(new URL("./admin.css", import.meta.url))],
  "/admin/notice.js": ["text/javascript; charset=UTF-8", readFileSync(new URL("./notice.js", import.meta.url))],
};
const cookieName = "__Host-sdc-admin";
const cookieOptions = "Path=/; Secure; HttpOnly; SameSite=Strict";
const allowedRecipientRequest = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const siteUpdateDeadlineMs = 21 * 60_000;
const notices = {
  resent: "The copy is queued. Follow the delivery in its timeline.",
  update: "Update requested. Refresh this page after the sites restart.",
  restart: "Rebuild requested. Refresh this page after the sites restart.",
  settings: "Settings save requested. Check the host status before rebuilding the sites.",
  refreshed: "Settings reload requested. Refresh this page to see the EC2 values.",
  reboot: "AWS accepted the reboot request. Check the sites after the host starts again.",
  frozen: "Digest Bot frozen. The current send can finish and new mail will still queue.",
  resumed: "Digest Bot resumed.",
  added: "User added.",
  edited: "User updated.",
  deleted: "User deleted.",
  "role-added": "Role added.",
  "role-edited": "Role updated.",
  "role-deleted": "Role deleted.",
};

const hostActions = {
  "/admin/system/update": { kind: "update", notice: "update" },
  "/admin/system/restart": { kind: "restart", notice: "restart" },
  "/admin/system/settings": { kind: "settings", action: "Environment save requested", notice: "settings" },
  "/admin/system/refresh-settings": { kind: "refresh", action: "Environment reload requested", notice: "refreshed" },
};
const systemPermissions = {
  "/admin/system/mail": "freeze",
  "/admin/system/update": "site_updates",
  "/admin/system/restart": "site_updates",
  "/admin/system/settings": "environment",
  "/admin/system/refresh-settings": "environment",
  "/admin/system/reboot": "reboot",
};
const landing = (user) => `/admin/${adminPages(user)[0][0]}`;
const mailId = (value) => value.startsWith("D-") ? value : Number(value);
const canManageUser = (user, account) => account && canManageRole(user, { id: account.role, permissions: account.permissions });

function readSettingsForm(form, automatic) {
  const values = Object.fromEntries(Object.keys(settingsFields).map((key) => [key, form.get(key)?.trim() ?? ""]));
  const supportedEmail = (value) => normaliseAddress(value) && /^[a-z0-9_.+%@-]+$/i.test(value);
  if (!supportedEmail(values.ACME_EMAIL) || ((automatic || values.DIGEST_GROUP_ADDRESS) && !supportedEmail(values.DIGEST_GROUP_ADDRESS))
      || (values.SDC_ADMIN_EC2_INSTANCE_ID && !/^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(values.SDC_ADMIN_EC2_INSTANCE_ID))) {
    throw new FormError(400, "Check the email addresses and EC2 instance ID.");
  }
  return values;
}

class FormError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readForm(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded") {
    throw new FormError(415, "Submit the form from the admin panel.");
  }
  const limit = 8192;
  if (Number(req.headers["content-length"]) > limit) throw new FormError(413, "The form is too large.");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new FormError(413, "The form is too large.");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function html(res, status, content) {
  res.writeHead(status, { "Content-Type": "text/html; charset=UTF-8" });
  res.end(content);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

function readToken(req) {
  return req.headers.cookie?.match(/(?:^|;\s*)__Host-sdc-admin=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
}

function clearSession(res) {
  res.setHeader("Set-Cookie", `${cookieName}=; ${cookieOptions}; Max-Age=0`);
}

function errorPage(res, status, message, user) {
  const title = status === 404 ? "Page not found" : status === 403 ? "Access denied" : "Action unavailable";
  html(res, status, messagePage(title, message, user));
}

function denied(res, user) {
  return errorPage(res, 403, "Your role does not have permission for this action.", user);
}

export function createAdminPanel(config, store, host = createHostActions(config.admin)) {
  const accounts = openAccounts(config.admin.databasePath);
  const failedAttempts = new Map();
  let activeSignIns = 0;
  let pruneAttemptsAt = 0;
  let startingHostAction = false;
  let closed = false;

  async function updateStatus() {
    const pending = accounts.pendingSiteUpdate();
    const result = await host.updateStatus();
    if (pending && !closed) {
      // The host serializes requests and writes its result before removing the request file.
      const at = Date.parse(result.updatedAt);
      const current = at >= pending.at && result.updatedAt !== pending.previousUpdatedAt;
      if (current && ["succeeded", "failed", "unknown"].includes(result.state)) {
        accounts.finishSiteUpdate(pending, result.state === "succeeded", result.detail, at);
      } else if (Date.now() - pending.at >= siteUpdateDeadlineMs) {
        accounts.finishSiteUpdate(pending, false, "The host did not report a final result. Check the bond-sdc-admin service log on EC2.");
      }
    }
    return result;
  }

  const auditTimer = setInterval(() => {
    if (!startingHostAction && accounts.pendingSiteUpdate()) {
      updateStatus().catch(() => console.error("Could not record the site maintenance result"));
    }
  }, 5000).unref();

  async function login(req, res, form) {
    const now = Date.now();
    const client = req.headers["x-sdc-admin-client"] || req.socket.remoteAddress;
    if (now >= pruneAttemptsAt) {
      for (const [ip, entry] of failedAttempts) if (entry.expires <= now) failedAttempts.delete(ip);
      pruneAttemptsAt = now + 60_000;
    }
    const last = failedAttempts.get(client);
    const attempt = last?.expires > now ? last : { failures: 0, expires: now + 15 * 60_000 };
    if (attempt.failures >= 8 || activeSignIns >= 4 || (!last && failedAttempts.size >= 1024)) {
      return html(res, 429, signIn({ ready: true, error: "Too many attempts. Try again in a few minutes." }));
    }
    activeSignIns++;
    attempt.failures++;
    failedAttempts.set(client, attempt);
    try {
      const username = (form.get("username") ?? "").trim().toLowerCase();
      const account = accounts.byName(username);
      const matches = await checkPassword(form.get("password") ?? "", account?.password_hash);
      if (!matches || accounts.byName(username)?.password_hash !== account.password_hash) {
        return html(res, 401, signIn({ ready: true, error: "Incorrect username or password." }));
      }
      failedAttempts.delete(client);
      const token = accounts.signIn(account);
      res.setHeader("Set-Cookie", `${cookieName}=${token}; ${cookieOptions}; Max-Age=${sessionSeconds}`);
      return redirect(res, landing(account));
    } finally {
      activeSignIns--;
    }
  }

  async function manageUser(res, user, token, form, id, deleting) {
    if (deleting) {
      const account = accounts.byId(id);
      if (!account || account.role === "owner") return errorPage(res, 404, "The user cannot be deleted here.", user);
      if (!canManageUser(user, account)) return denied(res, user);
      if (form.get("confirm") !== "yes") return errorPage(res, 400, "Confirm the account deletion.", user);
      accounts.removeUser(user.username, account);
      return redirect(res, "/admin/users?notice=deleted");
    }

    const username = (form.get("username") ?? "").trim().toLowerCase();
    const password = form.get("password") ?? "";
    const roleId = form.get("role");
    if (!validUsername(username) || !roleId || ((!id || password) && !validPassword(password))) {
      return errorPage(res, 400, "Use a valid username and role. New passwords need at least 14 characters.", user);
    }
    const hash = password ? await hashPassword(password) : null;
    user = accounts.session(token);
    if (!user) return errorPage(res, 401, "Sign in to continue.");
    const role = accounts.role(roleId);
    if (!can(user, "users")) return denied(res, user);
    if (!role) return errorPage(res, 400, "Choose an existing role.", user);
    if (!canManageRole(user, role)) return denied(res, user);
    const existing = accounts.byName(username);
    if (existing && existing.id !== id) return errorPage(res, 409, "That username is already in use.", user);
    if (!id) {
      accounts.addUser(user.username, username, role, hash);
      return redirect(res, "/admin/users?notice=added");
    }
    const account = accounts.byId(id);
    if (!account || account.role === "owner") return errorPage(res, 404, "The user cannot be edited here.", user);
    if (!canManageUser(user, account)) return denied(res, user);
    accounts.updateUser(user.username, account, username, role, hash);
    return redirect(res, "/admin/users?notice=edited");
  }

  function manageRole(res, user, form, id, deleting) {
    const role = id ? accounts.role(id) : undefined;
    if (id && (!role || role.id === "owner")) return errorPage(res, 404, "The role cannot be changed here.", user);
    if (role && !canManageRole(user, role)) return denied(res, user);
    if (deleting) {
      if (form.get("confirm") !== "yes") return errorPage(res, 400, "Confirm the role deletion.", user);
      if (!accounts.deleteRole(user.username, role)) {
        return errorPage(res, 409, "Reassign the users with this role before deleting it.", user);
      }
      return redirect(res, "/admin/roles?notice=role-deleted");
    }

    const name = (form.get("name") ?? "").trim();
    const grants = [...new Set(form.getAll("permission"))];
    if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name) || grants.some((grant) => !Object.hasOwn(permissions, grant))) {
      return errorPage(res, 400, "Enter a role name and select valid permissions.", user);
    }
    if (grants.some((grant) => !can(user, grant))) return denied(res, user);
    const existing = accounts.roleByName(name);
    if (existing && existing.id !== id) return errorPage(res, 409, "That role name is already in use.", user);
    if (!role) {
      accounts.addRole(user.username, name, grants);
      return redirect(res, "/admin/roles?notice=role-added");
    }
    accounts.updateRole(user.username, role, name, grants);
    const next = user.role === id && !grants.includes("roles") ? landing({ ...user, permissions: grants }) : "/admin/roles";
    return redirect(res, `${next}?notice=role-edited`);
  }

  async function changePassword(res, user, form) {
    const password = form.get("password") ?? "";
    if (!validPassword(password)) return errorPage(res, 400, "New passwords need at least 14 characters.", user);
    const current = accounts.byId(user.id)?.password_hash;
    if (!await checkPassword(form.get("current") ?? "", current)) return errorPage(res, 400, "The current password is incorrect.", user);
    const hash = await hashPassword(password);
    if (accounts.byId(user.id)?.password_hash !== current) return errorPage(res, 409, "Your account changed. Sign in again.", user);
    accounts.changePassword(user, hash);
    clearSession(res);
    return redirect(res, "/admin");
  }

  function resend(res, user, form, id) {
    if (!can(user, "resend")) return denied(res, user);
    if (!store) return errorPage(res, 409, "Automatic delivery is disabled.", user);
    const recipient = normaliseAddress(form.get("recipient")).toLowerCase();
    const requestKey = form.get("request") ?? "";
    if (!recipient || !allowedRecipientRequest.test(requestKey)
        || [config.groupAddress, config.inboxAddress, config.from.toLowerCase()].includes(recipient)) {
      return errorPage(res, 400, "Enter one recipient mailbox. Digest Bot and its group addresses cannot receive resends.", user);
    }
    const original = store.history.get(id);
    if (!original) return errorPage(res, 404, "The formatted email is unavailable.", user);
    const result = store.queueResend({ originalId: original.id, recipient, requestKey, actor: user.username });
    if (result.state === "unavailable") return errorPage(res, 404, "The formatted email is unavailable.", user);
    if (result.state === "busy") return errorPage(res, 503, "The mail queue is full. Try again shortly.", user);
    return redirect(res, `/admin/mail/${store.history.get(result.id).public_id}?notice=resent`);
  }

  async function requestHostAction(res, token, path, form) {
    const status = await updateStatus();
    const user = accounts.session(token);
    if (!user) return errorPage(res, 401, "Sign in to continue.");
    if (!can(user, systemPermissions[path])) return denied(res, user);
    if (accounts.pendingSiteUpdate() || ["queued", "running"].includes(status.state)) {
      return errorPage(res, 409, "Wait for the current host request to finish.", user);
    }
    if (Object.hasOwn(hostActions, path)) {
      const { kind, action, notice } = hostActions[path];
      if (Date.now() - (accounts.lastActivity("EC2 reboot requested") ?? 0) < 300_000) {
        return errorPage(res, 409, "Wait five minutes after requesting an EC2 reboot before using host controls.", user);
      }
      const payload = kind === "settings" ? { kind, values: readSettingsForm(form, Boolean(store)) } : { kind };
      const siteUpdate = kind === "update" || kind === "restart";
      const pending = siteUpdate ? accounts.startSiteUpdate(user.username, kind, status.updatedAt) : undefined;
      if (siteUpdate && !pending) return errorPage(res, 409, "A site update is already in progress.", user);
      let queued;
      try {
        queued = await host.request(payload);
      } catch (error) {
        if (pending) accounts.finishSiteUpdate(pending, false, "The panel could not submit the request to the host updater.");
        throw error;
      }
      if (!queued) {
        const detail = "The host updater is unavailable or already running.";
        if (pending) accounts.finishSiteUpdate(pending, false, detail);
        return errorPage(res, 409, detail, user);
      }
      if (action) accounts.record(user.username, action, "EC2 host updater");
      return redirect(res, `/admin/system?notice=${notice}`);
    }
    if (path === "/admin/system/reboot") {
      if (!config.admin.instanceId || form.get("confirmation") !== "REBOOT") {
        return errorPage(res, 400, "Configure EC2 reboot and type REBOOT to confirm.", user);
      }
      if (Date.now() - (accounts.lastActivity("EC2 reboot requested") ?? 0) < 300_000) {
        return errorPage(res, 409, "Wait five minutes after requesting an EC2 reboot before retrying.", user);
      }
      accounts.record(user.username, "EC2 reboot requested", config.admin.instanceId);
      try {
        await host.reboot();
        accounts.record(user.username, "EC2 reboot accepted", config.admin.instanceId);
        return redirect(res, "/admin/system?notice=reboot");
      } catch (error) {
        const status = error.$metadata?.httpStatusCode;
        const rejected = status >= 400 && status < 500 && status !== 408;
        const name = /^[a-z0-9_.-]{1,80}$/i.test(error.name ?? "") ? error.name : "Request error";
        accounts.record(user.username, rejected ? "EC2 reboot rejected" : "EC2 reboot unconfirmed", name);
        return errorPage(res, 502, rejected ? "AWS rejected the reboot. Check the instance role and region." : "The reboot result is unconfirmed. Check the EC2 console before retrying.", user);
      }
    }
    return errorPage(res, 404, "This action does not exist.", user);
  }

  async function changeSystem(res, user, token, path, form) {
    if (path === "/admin/system/mail") {
      const pause = form.get("pause");
      if (!store || !["true", "false"].includes(pause)) return errorPage(res, 409, "Automatic delivery is unavailable.", user);
      accounts.pauseOutgoing(user.username, pause === "true");
      return redirect(res, `/admin/system?notice=${pause === "true" ? "frozen" : "resumed"}`);
    }
    if (startingHostAction) return errorPage(res, 409, "A host action is already starting.", user);
    startingHostAction = true;
    try {
      return await requestHostAction(res, token, path, form);
    } finally {
      startingHostAction = false;
    }
  }

  async function view(res, user, path, params, recordId, userId, roleId) {
    const notice = Object.hasOwn(notices, params.get("notice")) ? notices[params.get("notice")] : undefined;
    if (path === "/admin/mail") {
      const requested = Number(params.get("page"));
      const page = Number.isSafeInteger(requested) && requested >= 1 ? requested : 1;
      const state = Object.hasOwn(statuses, params.get("state")) ? params.get("state") : "";
      return html(res, 200, mailPage(user, store?.history.page(page, state), state, notice));
    }
    if (recordId) {
      const row = store?.history.get(recordId);
      if (row) return html(res, 200, mailDetail(user, row, notice));
    }
    if (path === "/admin/system") {
      const readUpdate = ["site_updates", "environment", "reboot", "activity"].some((permission) => can(user, permission));
      const readSettings = can(user, "environment") || can(user, "reboot");
      const [update, settings] = await Promise.all([readUpdate ? updateStatus() : undefined, readSettings ? host.readSettings() : undefined]);
      return html(res, 200, systemPage(user, { pending: store?.pending(), paused: accounts.outgoingPaused(),
        activity: can(user, "activity") ? accounts.activity() : [], update, settings, instanceId: config.admin.instanceId }, notice));
    }
    if (path === "/admin/users" || userId) {
      const roles = accounts.roles().filter((role) => canManageRole(user, role));
      if (!userId) return html(res, 200, usersPage(user, accounts.list(), roles, notice));
      const account = accounts.byId(userId);
      if (account && account.role !== "owner") {
        if (!canManageUser(user, account)) return denied(res, user);
        return html(res, 200, editUserPage(user, account, roles, notice));
      }
    }
    if (path === "/admin/roles") return html(res, 200, rolesPage(user, accounts.roles(), notice));
    if (roleId) {
      const role = accounts.role(roleId);
      if (role && role.id !== "owner") {
        if (!canManageRole(user, role)) return denied(res, user);
        return html(res, 200, editRolePage(user, role, notice));
      }
    }
    if (path === "/admin/account") return html(res, 200, accountPage(user, notice));
    return errorPage(res, 404, "This page does not exist.", user);
  }

  async function handle(req, res, url) {
    if (req.headers.host?.toLowerCase() !== config.admin.host) return errorPage(res, 404, "This page does not exist.");
    res.setHeader("Cache-Control", "no-store");
    // A no-referrer policy makes native form submissions send Origin: null.
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const path = url.pathname.replace(/\/$/, "");
    if (req.method === "GET" && Object.hasOwn(assets, path)) {
      const [contentType, content] = assets[path];
      res.writeHead(200, { "Content-Type": contentType });
      return res.end(content);
    }
    const post = req.method === "POST";
    if (!post && req.method !== "GET") return errorPage(res, 405, "Use the admin panel in a browser.");
    if (post && req.headers.origin !== config.admin.origin) return errorPage(res, 403, "Submit the form from the admin panel.");
    const token = readToken(req);
    let user = token && accounts.session(token);
    try {
      if (path === "/admin/login" && post) {
        const form = await readForm(req);
        if (!accounts.hasOwner()) return html(res, 403, signIn());
        return login(req, res, form);
      }
      if (!user) {
        if (post) return errorPage(res, 401, "Sign in to continue.");
        if (path !== "/admin") return redirect(res, "/admin");
        return html(res, 200, signIn({ ready: accounts.hasOwner() }));
      }
      if (path === "/admin" && !post) return redirect(res, landing(user));
      const mail = /^\/admin\/mail\/(D-[0-9A-F]{10}|[1-9]\d{0,13})(\/resend)?$/.exec(path);
      const account = /^\/admin\/users\/([1-9]\d{0,13})(\/delete)?$/.exec(path);
      const role = /^\/admin\/roles\/(owner|viewer|operator|[a-f0-9]{16})(\/delete)?$/.exec(path);
      const form = post ? await readForm(req) : undefined;
      if (post) {
        user = accounts.session(token);
        if (!user) return errorPage(res, 401, "Sign in to continue.");
      }
      const systemPermission = Object.hasOwn(systemPermissions, path) ? systemPermissions[path] : undefined;
      if (((path === "/admin/mail" || mail) && !can(user, "email_history"))
          || ((path === "/admin/users" || account) && !can(user, "users"))
          || ((path === "/admin/roles" || role) && !can(user, "roles"))
          || (path === "/admin/system" && !canViewSystem(user))
          || (systemPermission && !can(user, systemPermission))) return denied(res, user);
      if (!post) return view(res, user, path, url.searchParams, mail && !mail[2] ? mailId(mail[1]) : undefined,
        account && !account[2] ? Number(account[1]) : undefined, role && !role[2] ? role[1] : undefined);
      if (path === "/admin/logout") {
        accounts.signOut(token);
        clearSession(res);
        return redirect(res, "/admin");
      }
      if (mail?.[2]) return resend(res, user, form, mailId(mail[1]));
      if (path === "/admin/account") return changePassword(res, user, form);
      if (path === "/admin/users" || account) return await manageUser(res, user, token, form, account ? Number(account[1]) : null, Boolean(account?.[2]));
      if (path === "/admin/roles" || role) return manageRole(res, user, form, role?.[1], Boolean(role?.[2]));
      if (systemPermission) return await changeSystem(res, user, token, path, form);
      return errorPage(res, 404, "This action does not exist.", user);
    } catch (error) {
      if (!(error instanceof FormError)) throw error;
      return errorPage(res, error.status, error.message, user);
    }
  }

  return { handle, outgoingPaused: accounts.outgoingPaused, close() {
    closed = true;
    clearInterval(auditTimer);
    host.close?.();
    accounts.close();
  } };
}

import { readFileSync } from "node:fs";
import { normaliseAddress } from "../../dist/core/mailbox.js";
import { checkPassword, hashPassword, openAccounts, sessionSeconds, validPassword, validUsername } from "./accounts.js";
import { createHostActions } from "./host.js";
import { accountPage, editUserPage, mailDetail, mailPage, messagePage, settingsFields, signIn, statuses, systemPage, usersPage } from "./views.js";

const style = readFileSync(new URL("./admin.css", import.meta.url));
const cookieName = "__Host-sdc-admin";
const cookieOptions = "Path=/; Secure; HttpOnly; SameSite=Strict";
const allowedRecipientRequest = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const notices = {
  resent: "The copy is queued. Follow the delivery in its timeline.",
  update: "Update requested. Refresh this page after the sites restart.",
  restart: "Rebuild requested. Refresh this page after the sites restart.",
  settings: "Settings save requested. Check the host status before rebuilding the sites.",
  refreshed: "Settings reload requested. Refresh this page to see the EC2 values.",
  reboot: "AWS accepted the reboot request. Check the sites after the host starts again.",
  paused: "Outgoing mail paused. The current send can finish and new mail will still queue.",
  resumed: "Outgoing mail resumed.",
  added: "User added.",
  edited: "User updated.",
  deleted: "User deleted.",
};

const hostActions = {
  "/admin/system/update": { kind: "update", action: "Site update requested", notice: "update" },
  "/admin/system/restart": { kind: "restart", action: "Site rebuild requested", notice: "restart" },
  "/admin/system/settings": { kind: "settings", action: "Environment save requested", notice: "settings" },
  "/admin/system/refresh-settings": { kind: "refresh", action: "Environment reload requested", notice: "refreshed" },
};

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

export function createAdminPanel(config, store, host = createHostActions(config.admin)) {
  const accounts = openAccounts(config.admin.databasePath);
  const failedAttempts = new Map();
  let activeSignIns = 0;
  let pruneAttemptsAt = 0;
  let startingHostAction = false;

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
      return redirect(res, "/admin/mail");
    } finally {
      activeSignIns--;
    }
  }

  async function manageUser(res, user, form, id, deleting) {
    if (deleting) {
      const account = accounts.byId(id);
      if (!account || account.role === "owner") return errorPage(res, 404, "The user cannot be deleted here.", user);
      if (form.get("confirm") !== "yes") return errorPage(res, 400, "Confirm the account deletion.", user);
      accounts.removeUser(user.username, account);
      return redirect(res, "/admin/users?notice=deleted");
    }

    const username = (form.get("username") ?? "").trim().toLowerCase();
    const password = form.get("password") ?? "";
    const role = form.get("role");
    if (!validUsername(username) || !["viewer", "operator"].includes(role) || ((!id || password) && !validPassword(password))) {
      return errorPage(res, 400, "Use a valid username and role. New passwords need at least 14 characters.", user);
    }
    const hash = password ? await hashPassword(password) : null;
    const existing = accounts.byName(username);
    if (existing && existing.id !== id) return errorPage(res, 409, "That username is already in use.", user);
    if (!id) {
      accounts.addUser(user.username, username, role, hash);
      return redirect(res, "/admin/users?notice=added");
    }
    const account = accounts.byId(id);
    if (!account || account.role === "owner") return errorPage(res, 404, "The user cannot be edited here.", user);
    accounts.updateUser(user.username, account, username, role, hash);
    return redirect(res, "/admin/users?notice=edited");
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
    if (user.role === "viewer") return errorPage(res, 403, "Your account can view the log. An operator or owner can resend mail.", user);
    if (!store) return errorPage(res, 409, "Automatic delivery is disabled.", user);
    const recipient = normaliseAddress(form.get("recipient")).toLowerCase();
    const requestKey = form.get("request") ?? "";
    if (!recipient || !allowedRecipientRequest.test(requestKey)
        || [config.groupAddress, config.inboxAddress, config.from.toLowerCase()].includes(recipient)) {
      return errorPage(res, 400, "Enter one recipient mailbox. Digest Bot and its group addresses cannot receive resends.", user);
    }
    const result = store.queueResend({ originalId: id, recipient, requestKey, actor: user.username });
    if (result.state === "unavailable") return errorPage(res, 404, "The formatted email is unavailable.", user);
    if (result.state === "busy") return errorPage(res, 503, "The mail queue is full. Try again shortly.", user);
    return redirect(res, `/admin/mail/${result.id}?notice=resent`);
  }

  async function requestHostAction(res, user, path, form) {
    if (Object.hasOwn(hostActions, path)) {
      const { kind, action, notice } = hostActions[path];
      if (Date.now() - (accounts.lastActivity("EC2 reboot requested") ?? 0) < 300_000) {
        return errorPage(res, 409, "Wait five minutes after requesting an EC2 reboot before using host controls.", user);
      }
      const payload = kind === "settings" ? { kind, values: readSettingsForm(form, Boolean(store)) } : { kind };
      if (!await host.request(payload)) return errorPage(res, 409, "The host updater is unavailable or already running.", user);
      accounts.record(user.username, action, "EC2 host updater");
      return redirect(res, `/admin/system?notice=${notice}`);
    }
    if (path === "/admin/system/reboot") {
      if (!config.admin.instanceId || form.get("confirmation") !== "REBOOT") {
        return errorPage(res, 400, "Configure EC2 reboot and type REBOOT to confirm.", user);
      }
      const { state } = await host.updateStatus();
      if (["queued", "running"].includes(state) || Date.now() - (accounts.lastActivity("EC2 reboot requested") ?? 0) < 300_000) {
        return errorPage(res, 409, "Wait for the update to finish or the reboot cooldown to pass.", user);
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

  async function changeSystem(res, user, path, form) {
    if (path === "/admin/system/mail") {
      const pause = form.get("pause");
      if (!store || !["true", "false"].includes(pause)) return errorPage(res, 409, "Automatic delivery is unavailable.", user);
      accounts.pauseOutgoing(user.username, pause === "true");
      return redirect(res, `/admin/system?notice=${pause === "true" ? "paused" : "resumed"}`);
    }
    if (startingHostAction) return errorPage(res, 409, "A host action is already starting.", user);
    startingHostAction = true;
    try {
      return await requestHostAction(res, user, path, form);
    } finally {
      startingHostAction = false;
    }
  }

  async function view(res, user, path, params, mailId, userId) {
    const notice = Object.hasOwn(notices, params.get("notice")) ? notices[params.get("notice")] : undefined;
    if (path === "/admin/mail") {
      const requested = Number(params.get("page"));
      const page = Number.isSafeInteger(requested) && requested >= 1 ? requested : 1;
      const state = Object.hasOwn(statuses, params.get("state")) ? params.get("state") : "";
      return html(res, 200, mailPage(user, store?.history.page(page, state), state, notice));
    }
    if (mailId) {
      const row = store?.history.get(mailId);
      if (row) return html(res, 200, mailDetail(user, row, notice));
    }
    if (path === "/admin/system") {
      const owner = user.role === "owner";
      const [update, settings] = owner ? await Promise.all([host.updateStatus(), host.readSettings()]) : [{}];
      return html(res, 200, systemPage(user, { pending: store?.pending(), paused: accounts.outgoingPaused(),
        activity: owner ? accounts.activity() : [], update, settings, instanceId: owner ? config.admin.instanceId : undefined }, notice));
    }
    if (path === "/admin/users") return html(res, 200, usersPage(user, accounts.list(), notice));
    if (userId) {
      const account = accounts.byId(userId);
      if (account && account.role !== "owner") return html(res, 200, editUserPage(user, account, notice));
    }
    if (path === "/admin/account") return html(res, 200, accountPage(user, notice));
    return errorPage(res, 404, "This page does not exist.", user);
  }

  async function handle(req, res, url) {
    if (req.headers.host?.toLowerCase() !== config.admin.host) return errorPage(res, 404, "This page does not exist.");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const path = url.pathname.replace(/\/$/, "");
    if (req.method === "GET" && path === "/admin/admin.css") {
      res.writeHead(200, { "Content-Type": "text/css; charset=UTF-8" });
      return res.end(style);
    }
    const post = req.method === "POST";
    if (!post && req.method !== "GET") return errorPage(res, 405, "Use the admin panel in a browser.");
    if (post && req.headers.origin !== config.admin.origin) return errorPage(res, 403, "Submit the form from the admin panel.");
    const token = readToken(req);
    const user = token && accounts.session(token);
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
      if (path === "/admin" && !post) return redirect(res, "/admin/mail");
      if ((/^\/admin\/users(?:\/|$)/.test(path) || path.startsWith("/admin/system/")) && user.role !== "owner") {
        return errorPage(res, 403, "This page is reserved for the owner.", user);
      }
      const mail = /^\/admin\/mail\/([1-9]\d{0,13})(\/resend)?$/.exec(path);
      const account = /^\/admin\/users\/([1-9]\d{0,13})(\/delete)?$/.exec(path);
      if (!post) return view(res, user, path, url.searchParams, mail && !mail[2] ? Number(mail[1]) : 0,
        account && !account[2] ? Number(account[1]) : 0);
      const form = await readForm(req);
      if (path === "/admin/logout") {
        accounts.signOut(token);
        clearSession(res);
        return redirect(res, "/admin");
      }
      if (mail?.[2]) return resend(res, user, form, Number(mail[1]));
      if (path === "/admin/account") return changePassword(res, user, form);
      if (path === "/admin/users" || account) return manageUser(res, user, form, account ? Number(account[1]) : null, Boolean(account?.[2]));
      if (path.startsWith("/admin/system/")) return await changeSystem(res, user, path, form);
      return errorPage(res, 404, "This action does not exist.", user);
    } catch (error) {
      if (!(error instanceof FormError)) throw error;
      return errorPage(res, error.status, error.message, user);
    }
  }

  return { handle, outgoingPaused: accounts.outgoingPaused, close() { host.close?.(); accounts.close(); } };
}

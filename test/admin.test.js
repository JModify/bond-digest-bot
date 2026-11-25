import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";
import { hashPassword, openAccounts } from "../server/admin/accounts.js";
import { createAdminPanel } from "../server/admin/routes.js";
import { systemPage } from "../server/admin/views.js";
import { loadConfig } from "../server/config.js";
import { startDeliveryWorker } from "../server/delivery.js";
import { createWebServer } from "../server/http.js";
import { openStore } from "../server/store.js";
import { parseEmail } from "../dist/core/mime.js";
import { DEFAULT_PRESET } from "../dist/core/preset.js";

const config = loadConfig({ DIGEST_EMAIL_DELIVERY_ENABLED: "true", DIGEST_GROUP_ADDRESS: "news@example.org" });
const sender = "staff@example.org";
const fixture = Buffer.from([
  `From: ${sender}`, "Subject: Original staff digest", "Content-Type: text/html; charset=UTF-8", "",
  '<html><body><table><tr><td><a href="https://example.sharepoint.com/sites/News/SitePages/Test.aspx">Test story</a>',
  "<p>Sample summary</p></td></tr></table></body></html>", "",
].join("\r\n"));
const actionKey = "b0219890-7a66-49d5-9dbb-9532ab17e36a";
const quiet = { error() {}, info() {}, warn() {} };

test("shows whether the reboot instance ID has been applied to Digest Bot", () => {
  const user = { username: "jlavagna", role: "owner" };
  const instanceId = "i-0123456789abcdef0";
  const state = { pending: 0, paused: false, activity: [], update: { state: "ready", detail: "Ready" } };

  const missing = systemPage(user, state);
  assert.match(missing, /running Digest Bot container has an empty <code>SDC_ADMIN_EC2_INSTANCE_ID/);
  assert.doesNotMatch(missing, /action="\/admin\/system\/reboot"/);

  const settings = { SDC_ADMIN_EC2_INSTANCE_ID: instanceId };
  const saved = systemPage(user, { ...state, settings });
  assert.match(saved, /saved in <code>\.env<\/code> and is waiting to be applied/);
  assert.match(saved, /Select <strong>Rebuild current code<\/strong>/);
  assert.doesNotMatch(saved, /action="\/admin\/system\/reboot"/);

  const applied = systemPage(user, { ...state, settings, instanceId });
  assert.match(applied, /Reboots <code>i-0123456789abcdef0<\/code>/);
  assert.match(applied, /action="\/admin\/system\/reboot"/);
});

async function waitFor(read, expected) {
  for (let i = 0; i < 50; i++) {
    if (read() === expected) return;
    await delay(40);
  }
  assert.equal(read(), expected);
}

test("archives the formatted digest, resends it once and retains history after queue cleanup", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "digest-history-"));
  const path = join(dir, "queue.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = openStore(path);
  const jobs = [];
  const stop = startDeliveryWorker(config, store, { async send(job) {
    jobs.push(job);
    return { MessageId: `ses-${jobs.length}` };
  } }, quiet);
  try {
    const message = { recipient: sender, subject: DEFAULT_PRESET.subject, sourceSubject: "Original staff digest", method: "spf",
      messageId: "<staff-news-1@example.org>", raw: fixture };
    assert.equal(store.enqueueIncoming(message), "queued");
    assert.equal(store.enqueueIncoming(message), "duplicate");
    await waitFor(() => store.history.get(1).state, "sent");
    const incoming = store.history.get(1);
    assert.equal(incoming.ses_message_id, "ses-1");
    assert.equal(incoming.subject, "Original staff digest");
    assert.match(incoming.public_id, /^D-[0-9A-F]{10}$/);
    assert.equal(store.history.get(incoming.public_id).id, incoming.id);
    assert.deepEqual(incoming.events.map(({ event }) => event), ["received", "queued", "duplicate", "processing", "sending", "sent"]);

    const to = "individual@example.net";
    const request = { originalId: 1, recipient: to, requestKey: actionKey, actor: "jlavagna" };
    assert.deepEqual(store.queueResend(request), { id: 2, state: "queued" });
    assert.deepEqual(store.queueResend(request), { id: 2, state: "duplicate" });
    await waitFor(() => store.history.get(2).state, "sent");
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].recipient, to);
    assert.equal(store.history.get(2).original_id, 1);
    assert.equal(store.history.get(2).actor, "jlavagna");
    const [sent, copy] = jobs.map(({ raw }) => parseEmail(raw));
    assert.equal(incoming.output_subject, sent.subject);
    assert.equal(store.history.get(2).output_subject, sent.subject);
    assert.notEqual(store.history.get(2).public_id, incoming.public_id);
    assert.equal(store.history.get(2).original_public_id, incoming.public_id);
    assert.equal(copy.subject, sent.subject);
    assert.equal(copy.html, sent.html);
    assert.equal(copy.images.size, sent.images.size);
    assert.match(jobs[1].raw.toString(), /\r\nTo: individual@example\.net\r\n/);
    assert.doesNotMatch(jobs[1].raw.toString(), /\r\n(?:To|Cc|Bcc): staff@example\.org\r\n/);
    store.prune(Date.now() + 8 * 24 * 60 * 60 * 1000);
  } finally {
    await stop();
    store.close();
  }
  store = openStore(path);
  try {
    assert.equal(store.pending(), 0);
    assert.equal(store.history.page(1, "sent").total, 2);
    assert.deepEqual(store.history.readArchived(1), jobs[0].raw);
    assert.equal(store.history.get(2).can_resend, 1);
  } finally {
    store.close();
  }
});

test("migrates old queue records and keeps interrupted or rejected statuses accurate", () => {
  const dir = mkdtempSync(join(tmpdir(), "digest-legacy-"));
  const path = join(dir, "queue.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE jobs (id TEXT PRIMARY KEY, status_key_hash TEXT NOT NULL, title_code TEXT NOT NULL, recipient TEXT NOT NULL,
      subject TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'waiting',
      available_at INTEGER, raw BLOB, attempts INTEGER NOT NULL DEFAULT 0, reason TEXT) STRICT;
    INSERT INTO jobs (id, status_key_hash, title_code, recipient, subject, created_at, expires_at, state)
    VALUES ('old', '', '', 'staff@example.org', 'Original', 10, 20, 'sent'),
           ('in-flight', '', '', 'staff@example.org', 'Pending', 11, 20, 'sending');
  `);
  legacy.close();
  const store = openStore(path);
  try {
    store.recover(30);
    assert.deepEqual(store.history.get(1).events.map(({ event }) => event), ["imported"]);
    assert.equal(store.history.get(1).state, "sent");
    assert.equal(store.history.get(1).can_resend, 0);
    assert.equal(store.history.get(2).state, "uncertain");
    for (let i = 0; i < 26; i++) store.recordSmtpAttempt({ source: sender, state: "rejected", description: "SMTP 550: authentication rejected." });
    const { total, pages, rows } = store.history.page(2, "rejected");
    assert.equal(total, 26);
    assert.equal(pages, 2);
    assert.equal(rows.length, 1);
    store.prune(Date.now());
    assert.equal(store.history.page(1, "").total, 28);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backfills stable IDs for existing email history", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "digest-history-ids-"));
  const path = join(dir, "queue.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const oldStore = openStore(path);
  oldStore.recordSmtpAttempt({ source: sender, state: "rejected", description: "Legacy attempt" });
  oldStore.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP INDEX digest_history_public_id; ALTER TABLE digest_history DROP COLUMN public_id");
  legacy.close();

  const migrated = openStore(path);
  const row = migrated.history.get(1);
  assert.match(row.public_id, /^D-[0-9A-F]{10}$/);
  assert.equal(row.events[0].detail, "Legacy attempt");
  migrated.close();
  const reopened = openStore(path);
  try {
    assert.deepEqual(reopened.history.get(row.public_id), row);
  } finally {
    reopened.close();
  }
});

test("migrates admin accounts and active sessions with the existing role permissions", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "digest-admin-roles-"));
  const path = join(dir, "admin.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE admin_users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner', 'operator', 'viewer'))) STRICT;
    CREATE UNIQUE INDEX admin_only_one_owner ON admin_users(role) WHERE role = 'owner';
    CREATE TABLE admin_sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL) STRICT;
    INSERT INTO admin_users VALUES (1, 'jlavagna', 'owner-hash', 'owner'), (2, 'reader', 'reader-hash', 'viewer'),
      (9, 'deleted', 'old-hash', 'operator');
    DELETE FROM admin_users WHERE id = 9;
  `);
  const token = "existing-token";
  legacy.prepare("INSERT INTO admin_sessions VALUES (?, 2, ?)").run(createHash("sha256").update(token).digest("hex"), Date.now() + 60000);
  legacy.close();

  const migrated = openAccounts(path);
  assert.equal(migrated.byName("reader").password_hash, "reader-hash");
  assert.equal(migrated.session(token).id, 2);
  assert.deepEqual(migrated.session(token).permissions, ["email_history", "digest_status"]);
  assert.ok(migrated.role("operator").permissions.includes("resend"));
  assert.equal(migrated.deleteRole("jlavagna", migrated.role("viewer")), false);
  assert.equal(migrated.deleteRole("jlavagna", migrated.role("operator")), true);
  migrated.addUser("jlavagna", "new-reader", migrated.role("viewer"), "new-hash");
  assert.equal(migrated.byName("new-reader").id, 10);
  migrated.close();
  const reopened = openAccounts(path);
  try {
    assert.equal(reopened.role("operator"), undefined);
    assert.equal(reopened.session(token).username, "reader");
  } finally {
    reopened.close();
  }
});

async function startAdmin(adminConfig, store, host) {
  const { origin, host: hostname } = adminConfig.admin;
  const panel = createAdminPanel(adminConfig, store, host);
  const web = createWebServer(adminConfig, quiet, panel).listen(0, "127.0.0.1");
  await once(web, "listening");
  const base = `http://127.0.0.1:${web.address().port}`;
  const request = (path, { cookie, body, headers } = {}) => new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : undefined;
    const input = httpRequest(base + path, {
      method: body ? "POST" : "GET",
      headers: { host: hostname, ...(cookie ? { cookie } : {}),
        ...(body ? { origin, "content-type": "application/x-www-form-urlencoded" } : {}), ...headers },
    }, async (res) => {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers }));
    });
    input.on("error", reject);
    input.end(payload);
  });
  const login = async (username, value) => {
    const response = await request("/admin/login", { body: { username, password: value } });
    assert.equal(response.status, 303);
    const header = response.headers.get("set-cookie");
    assert.match(header, /Secure; HttpOnly; SameSite=Strict/);
    return header.split(";")[0];
  };
  return { panel, request, login, async close() {
    await new Promise((resolve) => web.close(resolve));
    panel.close();
  } };
}

const origin = "https://bond-sdc.com";
const password = "Test owner password 471";
async function provisionAdmin(dir, extra = {}) {
  const adminConfig = { ...config, admin: { origin, host: "bond-sdc.com", databasePath: join(dir, "admin.sqlite"),
    instanceId: "i-0123456789abcdef0", ...extra } };
  const owner = openAccounts(adminConfig.admin.databasePath);
  owner.provision(await hashPassword(password), false);
  owner.close();
  return adminConfig;
}

test("protects maintenance and resends with roles, origin checks and revocable sessions", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "digest-admin-"));
  const adminConfig = await provisionAdmin(dir);
  const requested = [];
  let hostStatus = { state: "ready", detail: "Ready" };
  const host = {
    async updateStatus() { return hostStatus; },
    async readSettings() { return { ACME_EMAIL: "admin@example.org", DIGEST_GROUP_ADDRESS: config.groupAddress }; },
    async request(action) { requested.push(action); return true; },
    async reboot() { requested.push({ kind: "reboot" }); },
  };
  const outgoing = "Bond Staff News | Wednesday 25 November 2026";
  const store = openStore(":memory:");
  store.enqueueIncoming({ recipient: sender, subject: outgoing, sourceSubject: "<test title>", messageId: "<example@example.org>", raw: fixture });
  const job = store.claim();
  store.sending(job.id, { raw: fixture, subject: outgoing });
  store.finish(job.id, "sent", null, { messageId: "test-123" });
  const { panel, request, login, close } = await startAdmin(adminConfig, store, host);
  t.after(async () => {
    await close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const signInPage = await request("/admin");
  assert.equal(signInPage.headers.get("referrer-policy"), "same-origin");
  assert.equal((await request("/admin/mail")).status, 303);
  assert.equal((await request("/admin/mail", { headers: { host: "digest.bond-sdc.com" } })).status, 404);
  assert.equal((await request("/admin/login", { body: {}, headers: { origin: "null" } })).status, 403);
  assert.equal((await request("/admin/login", { body: { username: "jlavagna", password: "admin" } })).status, 401);
  const cookie = await login("jlavagna", password);
  const mail = new JSDOM(await (await request("/admin/mail", { cookie })).text()).window.document;
  assert.equal(mail.querySelector("h1").textContent, "Digest Bot Email History");
  assert.deepEqual([...mail.querySelectorAll("th")].map((cell) => cell.textContent), ["ID", "Queued", "Subject", "Send To", "Status"]);
  const cells = mail.querySelector("tbody tr").cells;
  const recordPath = cells[0].firstElementChild.getAttribute("href");
  assert.equal(recordPath, `/admin/mail/${store.history.get(1).public_id}`);
  assert.equal(cells[2].textContent, outgoing);
  assert.equal(cells[2].querySelector("a"), null);
  const detail = await request("/admin/mail/1", { cookie });
  assert.equal(detail.headers.get("cache-control"), "no-store");
  const detailHtml = await detail.text();
  assert.match(detailHtml, /&lt;test title&gt;/);
  assert.match(detailHtml, /Accepted by SES/);
  assert.equal((await request(recordPath, { cookie })).status, 200);
  const system = await request("/admin/system", { cookie });
  const systemHtml = await system.text();
  assert.match(systemHtml, /Environment settings/);
  assert.match(systemHtml, /State:<\/strong> Listening<br><strong>Queued:<\/strong> 0/);
  assert.match(systemHtml, />Freeze<\/button>/);
  assert.equal((await request("/admin/system/update", { cookie, body: {}, headers: { origin: "https://digest.bond-sdc.com" } })).status, 403);
  assert.equal((await request("/admin/system/mail", { cookie, body: { pause: "true" } })).status, 303);
  assert.equal(panel.outgoingPaused(), true);
  const frozenHtml = await (await request("/admin/system?notice=frozen", { cookie })).text();
  assert.match(frozenHtml, /State:<\/strong> Frozen/);
  assert.match(frozenHtml, />Resume<\/button>/);
  assert.match(frozenHtml, /<script src="\/admin\/notice.js" defer><\/script>/);
  const noticeScript = await request("/admin/notice.js");
  assert.match(noticeScript.headers.get("content-type"), /text\/javascript/);
  const { window } = new JSDOM(frozenHtml, { url: `${origin}/admin/system?notice=frozen`, runScripts: "outside-only" });
  let expireNotice;
  window.setTimeout = (callback, duration) => {
    assert.equal(duration, 6000);
    expireNotice = callback;
  };
  window.eval(await noticeScript.text());
  assert.equal(window.location.search, "");
  assert.ok(window.document.querySelector(".notice"));
  expireNotice();
  assert.equal(window.document.querySelector(".notice"), null);
  window.close();
  assert.equal((await request("/admin/system/mail", { cookie, body: { pause: "false" } })).status, 303);
  assert.equal(panel.outgoingPaused(), false);

  const values = { ACME_EMAIL: "admin@example.org", DIGEST_GROUP_ADDRESS: "team@example.org", SDC_ADMIN_EC2_INSTANCE_ID: "i-0123456789abcdef0" };
  assert.equal((await request("/admin/system/settings", { cookie, body: { ...values, ACME_EMAIL: "${SECRET}" } })).status, 400);
  assert.equal((await request("/admin/system/settings", { cookie, body: { ...values, AWS_SECRET_ACCESS_KEY: "ignored" } })).status, 303);
  assert.deepEqual(requested, [{ kind: "settings", values }]);
  assert.equal((await request("/admin/system/update", { cookie, body: {} })).status, 303);
  hostStatus = { state: "succeeded", updatedAt: new Date().toISOString(), detail: "Both services passed the Compose startup checks." };
  assert.equal((await request("/admin/system/reboot", { cookie, body: { confirmation: "REBOOT" } })).status, 303);
  assert.equal((await request("/admin/system/reboot", { cookie, body: { confirmation: "REBOOT" } })).status, 409);
  assert.deepEqual(requested.slice(1), [{ kind: "update" }, { kind: "reboot" }]);

  const viewerPassword = "Safe viewer password 527";
  assert.equal((await request("/admin/users", { cookie, body: { username: "reader", password: viewerPassword, role: "viewer" } })).status, 303);
  const viewerCookie = await login("reader", viewerPassword);
  assert.equal((await request("/admin/mail", { cookie: viewerCookie })).status, 200);
  assert.equal((await request("/admin/system", { cookie: viewerCookie })).status, 200);
  assert.equal((await request("/admin/users", { cookie: viewerCookie })).status, 403);
  assert.equal((await request("/admin/system/restart", { cookie: viewerCookie, body: {} })).status, 403);
  const resend = { request: actionKey, recipient: "one@example.net" };
  assert.equal((await request(`${recordPath}/resend`, { cookie: viewerCookie, body: resend })).status, 403);
  assert.equal((await request("/admin/users/2", { cookie, body: { username: "reader", role: "operator" } })).status, 303);
  assert.equal((await request("/admin/mail", { cookie: viewerCookie })).status, 303);
  const operatorCookie = await login("reader", viewerPassword);
  const resent = await request(`${recordPath}/resend`, { cookie: operatorCookie, body: resend });
  assert.equal(resent.status, 303);
  assert.match(resent.headers.get("location"), /^\/admin\/mail\/D-[0-9A-F]{10}\?notice=resent$/);
  assert.equal((await request("/admin/users/2/delete", { cookie, body: { confirm: "yes" } })).status, 303);
  assert.equal((await request("/admin/mail", { cookie: operatorCookie })).status, 303);
  assert.equal((await request("/admin/users/1/delete", { cookie, body: { confirm: "yes" } })).status, 404);
});

test("applies editable role permissions to pages, direct requests and active sessions", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "digest-delegated-roles-"));
  const adminConfig = await provisionAdmin(dir);
  const { request, login, close } = await startAdmin(adminConfig);
  t.after(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });
  const cookie = await login("jlavagna", password);
  const ownerRoles = await (await request("/admin/roles", { cookie })).text();
  assert.match(ownerRoles, /\/admin\/roles\/viewer/);
  assert.match(ownerRoles, /\/admin\/roles\/operator/);
  const viewer = await (await request("/admin/roles/viewer", { cookie })).text();
  assert.match(viewer, /name="permission" value="email_history" checked/);
  assert.match(viewer, /name="permission" value="activity">/);
  assert.match(viewer, /name="permission" value="reboot">/);

  const grants = (name, ...permissions) => new URLSearchParams([["name", name], ...permissions.map((permission) => ["permission", permission])]);
  assert.equal((await request("/admin/roles", { cookie, body: grants("Delegated manager", "activity", "roles", "users") })).status, 303);
  const createdRoles = await (await request("/admin/roles", { cookie })).text();
  const roleId = createdRoles.match(/href="\/admin\/roles\/([a-f0-9]{16})">Edit<span class="sr-only"> Delegated manager/)[1];
  const delegatePassword = "Test delegated password 973";
  assert.equal((await request("/admin/users", { cookie, body: { username: "delegate", role: roleId, password: delegatePassword } })).status, 303);
  const delegate = await login("delegate", delegatePassword);
  assert.equal((await request("/admin", { cookie: delegate })).headers.get("location"), "/admin/system");
  assert.equal((await request("/admin/mail", { cookie: delegate })).status, 403);
  const delegatedSystem = await (await request("/admin/system", { cookie: delegate })).text();
  assert.match(delegatedSystem, /<h2>Admin Activity<\/h2>/);
  assert.doesNotMatch(delegatedSystem, /<h2>(Environment settings|EC2 reboot)<\/h2>/);
  assert.equal((await request("/admin/system/reboot", { cookie: delegate, body: { confirmation: "REBOOT" } })).status, 403);
  assert.equal((await request("/admin/roles", { cookie: delegate, body: grants("Auditor", "activity") })).status, 303);
  assert.equal((await request(`/admin/roles/${roleId}`, { cookie: delegate, body: grants("Delegated manager", "roles", "reboot") })).status, 403);
  assert.equal((await request("/admin/roles/operator", { cookie: delegate, body: grants("Operator") })).status, 403);
  assert.equal((await request("/admin/roles/owner", { cookie, body: grants("Other owner") })).status, 404);
  assert.equal((await request("/admin/users", { cookie: delegate, body: { username: "newowner", role: "owner", password } })).status, 403);
  assert.equal((await request("/admin/users/1/delete", { cookie: delegate, body: { confirm: "yes" } })).status, 404);
  assert.equal((await request(`/admin/roles/${roleId}/delete`, { cookie, body: { confirm: "yes" } })).status, 409);

  assert.equal((await request(`/admin/roles/${roleId}`, { cookie, body: grants("Delegated manager", "email_history") })).status, 303);
  assert.equal((await request("/admin/roles", { cookie: delegate })).status, 403);
  assert.equal((await request("/admin/system", { cookie: delegate })).status, 403);
  assert.equal((await request("/admin/mail", { cookie: delegate })).status, 200);
  const editHtml = await (await request("/admin/users/2", { cookie })).text();
  assert.match(editHtml, /action="\/admin\/users\/2\/delete" class="fields stacked-form"/);
  assert.equal((await request("/admin/users/2", { cookie, body: { username: "delegate", role: "operator" } })).status, 303);
  assert.equal((await request(`/admin/roles/${roleId}/delete`, { cookie, body: { confirm: "yes" } })).status, 303);
  assert.equal((await request(`/admin/roles/${roleId}`, { cookie })).status, 404);
});

test("records the host update result across a restart and limits Admin Activity to 20 entries", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "digest-update-activity-"));
  mkdirSync(join(dir, "requests"));
  mkdirSync(join(dir, "status"));
  const requestPath = join(dir, "requests", "request.json");
  const statusPath = join(dir, "status", "update.json");
  const setStatus = (state, detail) => writeFileSync(statusPath, JSON.stringify({ state, detail, updatedAt: new Date().toISOString() }));
  setStatus("ready", "Ready");
  const adminConfig = await provisionAdmin(dir, { updateDir: dir });
  let admin = await startAdmin(adminConfig);
  t.after(async () => {
    await admin.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const cookie = await admin.login("jlavagna", password);
  const start = () => admin.request("/admin/system/update", { cookie, body: {} });
  const activityHtml = async () => (await admin.request("/admin/system", { cookie })).text();
  assert.equal((await start()).status, 303);
  assert.deepEqual(JSON.parse(readFileSync(requestPath, "utf8")), { kind: "update" });
  const waiting = await activityHtml();
  assert.match(waiting, /<td>Site update requested<\/td>/);
  assert.doesNotMatch(waiting, /<td>Site update completed<\/td>/);
  assert.equal((await admin.request("/admin/system/refresh-settings", { cookie, body: {} })).status, 409);

  await admin.close();
  setStatus("succeeded", "Both services passed the Compose startup checks.");
  rmSync(requestPath);
  admin = await startAdmin(adminConfig);
  assert.match(await activityHtml(), /<td>Site update completed<\/td><td>Both services passed the Compose startup checks\.<\/td>/);
  assert.equal((await start()).status, 303);
  setStatus("failed", "bond-digest-bot has local changes to tracked files.");
  rmSync(requestPath);
  const failed = await activityHtml();
  assert.match(failed, /<td>Site update failed<\/td><td>bond-digest-bot has local changes to tracked files\.<\/td>/);
  assert.equal((await activityHtml()).match(/<td>Site update completed<\/td>/g).length, 1);

  const accounts = openAccounts(adminConfig.admin.databasePath);
  for (let i = 1; i <= 25; i++) accounts.record("test", "Audit test", `Entry ${i}`, Date.now() + i);
  accounts.close();
  const doc = new JSDOM(await activityHtml()).window.document;
  const activity = [...doc.querySelectorAll(".panel")].find((section) => section.querySelector("h2").textContent === "Admin Activity");
  assert.deepEqual([...activity.querySelectorAll("th")].map((cell) => cell.textContent), ["Time", "User", "Action", "Details"]);
  const rows = activity.querySelectorAll("tbody tr");
  assert.equal(rows.length, 20);
  assert.equal(rows[0].cells[3].textContent, "Entry 25");
  assert.equal(rows[19].cells[3].textContent, "Entry 6");
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { hashPassword, openAccounts } from "../server/admin/accounts.js";
import { createAdminPanel } from "../server/admin/routes.js";
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

test("protects maintenance and resends with roles, origin checks and revocable sessions", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "digest-admin-"));
  const origin = "https://bond-sdc.com";
  const adminConfig = { ...config, admin: { origin, host: "bond-sdc.com", databasePath: join(dir, "admin.sqlite"),
    instanceId: "i-0123456789abcdef0" } };
  const password = "Test owner password 471";
  const owner = openAccounts(adminConfig.admin.databasePath);
  owner.provision(await hashPassword(password), false);
  owner.close();
  const requested = [];
  const host = {
    async updateStatus() { return { state: "ready", detail: "Ready" }; },
    async readSettings() { return { ACME_EMAIL: "admin@example.org", DIGEST_GROUP_ADDRESS: config.groupAddress }; },
    async request(action) { requested.push(action); return true; },
    async reboot() { requested.push({ kind: "reboot" }); },
  };
  const store = openStore(":memory:");
  store.enqueueIncoming({ recipient: sender, subject: "Archived news", sourceSubject: "<test title>", messageId: "<example@example.org>", raw: fixture });
  const job = store.claim();
  store.sending(job.id, { raw: fixture, subject: "Archived news" });
  store.finish(job.id, "sent", null, { messageId: "test-123" });
  const panel = createAdminPanel(adminConfig, store, host);
  const web = createWebServer(adminConfig, quiet, panel).listen(0, "127.0.0.1");
  await once(web, "listening");
  t.after(async () => {
    await new Promise((resolve) => web.close(resolve));
    panel.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${web.address().port}`;
  const request = (path, { cookie, body, headers } = {}) => new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : undefined;
    const input = httpRequest(base + path, {
      method: body ? "POST" : "GET",
      headers: { host: "bond-sdc.com", ...(cookie ? { cookie } : {}),
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

  const signInPage = await request("/admin");
  assert.equal(signInPage.headers.get("referrer-policy"), "same-origin");
  assert.equal((await request("/admin/mail")).status, 303);
  assert.equal((await request("/admin/mail", { headers: { host: "digest.bond-sdc.com" } })).status, 404);
  assert.equal((await request("/admin/login", { body: {}, headers: { origin: "null" } })).status, 403);
  assert.equal((await request("/admin/login", { body: { username: "jlavagna", password: "admin" } })).status, 401);
  const cookie = await login("jlavagna", password);
  const detail = await request("/admin/mail/1", { cookie });
  assert.equal(detail.headers.get("cache-control"), "no-store");
  const detailHtml = await detail.text();
  assert.match(detailHtml, /&lt;test title&gt;/);
  assert.match(detailHtml, /Accepted by SES/);
  const system = await request("/admin/system", { cookie });
  assert.match(await system.text(), /Environment settings/);
  assert.equal((await request("/admin/system/update", { cookie, body: {}, headers: { origin: "https://digest.bond-sdc.com" } })).status, 403);
  assert.equal((await request("/admin/system/mail", { cookie, body: { pause: "true" } })).status, 303);
  assert.equal(panel.outgoingPaused(), true);

  const values = { ACME_EMAIL: "admin@example.org", DIGEST_GROUP_ADDRESS: "team@example.org", SDC_ADMIN_EC2_INSTANCE_ID: "i-0123456789abcdef0" };
  assert.equal((await request("/admin/system/settings", { cookie, body: { ...values, ACME_EMAIL: "${SECRET}" } })).status, 400);
  assert.equal((await request("/admin/system/settings", { cookie, body: { ...values, AWS_SECRET_ACCESS_KEY: "ignored" } })).status, 303);
  assert.deepEqual(requested, [{ kind: "settings", values }]);
  assert.equal((await request("/admin/system/update", { cookie, body: {} })).status, 303);
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
  assert.equal((await request("/admin/mail/1/resend", { cookie: viewerCookie, body: resend })).status, 403);
  assert.equal((await request("/admin/users/2", { cookie, body: { username: "reader", role: "operator" } })).status, 303);
  assert.equal((await request("/admin/mail", { cookie: viewerCookie })).status, 303);
  const operatorCookie = await login("reader", viewerPassword);
  assert.equal((await request("/admin/mail/1/resend", { cookie: operatorCookie, body: resend })).status, 303);
  assert.equal((await request("/admin/users/2/delete", { cookie, body: { confirm: "yes" } })).status, 303);
  assert.equal((await request("/admin/mail", { cookie: operatorCookie })).status, 303);
  assert.equal((await request("/admin/users/1/delete", { cookie, body: { confirm: "yes" } })).status, 404);
});

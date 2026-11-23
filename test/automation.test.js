import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { JSDOM } from "jsdom";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { formatDigest, readDigest } from "../dist/core/digest.js";
import { parseEmail } from "../dist/core/mime.js";
import { DEFAULT_PRESET } from "../dist/core/preset.js";
import { loadConfig } from "../server/config.js";
import { startDeliveryWorker } from "../server/delivery.js";
import { createWebServer } from "../server/http.js";
import { createSmtpServer } from "../server/smtp.js";
import { openStore } from "../server/store.js";

const config = {
  emailDeliveryEnabled: true,
  origin: "https://digest.bond-sdc.com",
  inboxDomain: "inbox.bond-sdc.com",
  mailHost: "mail.bond-sdc.com",
  from: "digest@bond-sdc.com",
  allowedRecipients: ["staff@example.org"],
  recipientDomains: [],
  sharepointHosts: ["bonduni.sharepoint.com"],
  maxMessageBytes: 1024 * 1024,
};

const sourceDigest = `From: Staff Member <someone@example.net>\r
Subject: SharePoint digest TITLE_CODE\r
Content-Type: text/html; charset=UTF-8\r
\r
<html><body><table><tr><td>
<a href="https://bonduni.sharepoint.com/sites/News/SitePages/Example.aspx">Test story</a>
<p>Sample summary.</p><div class="author">Example Author</div><div>19/11/2026</div>
</td></tr></table></body></html>\r
`;
const article = {
  title: "Test story",
  href: "https://bonduni.sharepoint.com/sites/News/SitePages/Example.aspx",
  summary: "Sample summary.",
};

async function statusEventually(url, key, states) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(url, { headers: { "X-Digest-Status": key } });
    const job = await response.json();
    if (states.includes(job.state)) return job;
    await delay(50);
  }
  throw new Error("The expected job state was not reached");
}

async function smtpClient(port) {
  const socket = net.connect({ port, host: "127.0.0.1" });
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  async function response() {
    let line;
    do {
      line = (await lines.next()).value;
      assert.ok(line, "The SMTP server closed the connection");
    } while (/^\d{3}-/.test(line));
    return line;
  }
  async function command(line) {
    socket.write(line + "\r\n");
    return response();
  }
  async function body(raw) {
    return command(raw.replace(/(^|\r\n)\./g, "$1..").replace(/\r\n$/, "") + "\r\n.");
  }
  assert.match(await response(), /^220 /);
  assert.match(await command("EHLO example.net"), /^250 /);
  return { command, body, close: () => socket.destroy() };
}

function mailSource(title, sample, privateSample) {
  const input = privateSample ? readFileSync(privateSample).toString("latin1") : sample;
  const text = input.replace(/^Subject:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*/mi, "Subject: Staff shared \"" + title + "\" with you");
  return text.replace(/\r?\n/g, "\r\n");
}

test("creates a private request, accepts matching SMTP mail and delivers the saved digest once", async (t) => {
  const privateSample = process.env.DIGEST_TEST_EML;
  const store = openStore(":memory:");
  const accepted = [];
  const smtp = createSmtpServer(config, store);
  smtp.listen(0, "127.0.0.1");
  await once(smtp.server, "listening");
  const web = createWebServer(config, store).listen(0, "127.0.0.1");
  await once(web, "listening");
  const stop = startDeliveryWorker(config, store, { async send(message) { accepted.push(message); } });
  const client = await smtpClient(smtp.server.address().port);
  t.after(async () => {
    client.close();
    await stop();
    await Promise.all([new Promise((resolve) => smtp.close(resolve)), new Promise((resolve) => web.close(resolve))]);
    store.close();
  });

  const base = "http://127.0.0.1:" + web.address().port;
  assert.match(await (await fetch(base)).text(), /v1\.0\.4/);
  assert.equal((await (await fetch(base + "/api/email")).json()).from, config.from);
  const create = (payload, origin = config.origin) => fetch(base + "/api/email/requests", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal((await create({ recipient: "staff@example.org" }, "https://untrusted.example")).status, 403);
  assert.equal((await create({ recipient: "unlisted@example.org" })).status, 400);
  assert.equal(smtp.options.disabledCommands.includes("AUTH"), true);
  assert.match(await client.command("MAIL FROM:<>"), /^550 /);
  assert.match(await client.command("MAIL FROM:<external@example.net>"), /^250 /);
  assert.match(await client.command("RCPT TO:<staff@example.org>"), /^550 /);

  const created = await create({ recipient: "Staff@example.org", subject: "Saved Bond preset", from: "ignored@example.net" });
  assert.equal(created.status, 201);
  const job = await created.json();
  assert.equal(job.recipient, "staff@example.org");
  assert.equal(job.from, config.from);
  const statusUrl = base + "/api/email/requests/" + job.id;
  assert.equal((await fetch(statusUrl)).status, 404);
  assert.equal((await fetch(statusUrl, { headers: { "X-Digest-Status": "0".repeat(48) } })).status, 404);

  assert.match(await client.command("RCPT TO:<" + job.inbox + ">"), /^250 /);
  assert.match(await client.command("DATA"), /^354 /);
  assert.match(await client.body(mailSource("WRONG-CODE", sourceDigest)), /^550 /);
  assert.equal((await statusEventually(statusUrl, job.statusKey, ["waiting"])).state, "waiting");

  assert.match(await client.command("MAIL FROM:<external@example.net>"), /^250 /);
  assert.match(await client.command("RCPT TO:<" + job.inbox + ">"), /^250 /);
  assert.match(await client.command("DATA"), /^354 /);
  assert.match(await client.body(mailSource(job.titleCode, sourceDigest, privateSample)), /^250 /);
  assert.match(await client.command("MAIL FROM:<external@example.net>"), /^250 /);
  assert.match(await client.command("RCPT TO:<" + job.inbox + ">"), /^550 /);

  const result = await statusEventually(statusUrl, job.statusKey, ["sent", "failed", "uncertain"]);
  assert.equal(result.state, "sent", result.reason);
  assert.equal(accepted.length, 1);
  const message = accepted[0];
  assert.equal(message.recipient, job.recipient);
  const rendered = parseEmail(message.raw);
  assert.equal(rendered.from, config.from);
  assert.equal(rendered.subject, "Saved Bond preset");
  if (!privateSample) assert.match(rendered.html, /Test story/);
  assert.match(rendered.html, /Staff News/);
  assert.match(rendered.html, /View all news and upcoming events/);
  assert.equal(rendered.images.size, privateSample ? 3 : 1);
  assert.match(message.raw.toString(), /\r\nAuto-Submitted: auto-replied\r\n/);
  assert.doesNotMatch(message.raw.toString(), /\r\nX-Unsent:/);
});

test("recovers queued mail after restart and avoids repeating an unconfirmed send", () => {
  const dir = mkdtempSync(join(tmpdir(), "digest-bot-test-"));
  const database = join(dir, "queue.sqlite");
  try {
    const before = openStore(database);
    const sending = before.create({ recipient: "staff@example.org", subject: "first" }, 1);
    const processing = before.create({ recipient: "staff@example.org", subject: "second" }, 2);
    before.enqueue(sending.id, Buffer.from("first message"), 1);
    before.enqueue(processing.id, Buffer.from("second message"), 2);
    before.claim(2);
    before.sending(sending.id);
    before.claim(2);
    before.close();

    const after = openStore(database);
    try {
      after.recover();
      assert.equal(after.status(sending.id, sending.statusKey, 10).state, "uncertain");
      assert.equal(after.status(processing.id, processing.statusKey, 10).state, "queued");
      assert.equal(Buffer.from(after.claim(10).raw).toString(), "second message");
      assert.equal(after.claim(10), undefined);
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manual export still supports viewing and editable drafts", () => {
  const digest = { articles: [article], suggestedRecipient: "manual@example.org" };
  const preset = { from: "bondstaffnews@bond.edu.au", subject: "Manual digest" };
  const date = new Date("2026-11-20T01:15:00Z");
  const view = formatDigest(digest, preset, date);
  const draft = formatDigest(digest, preset, date, undefined, { editable: true });
  assert.match(view, /\r\nFrom: bondstaffnews@bond\.edu\.au\r\nTo: manual@example\.org\r\n/);
  assert.match(draft, /\r\nX-Unsent: 1\r\n/);
  assert.doesNotMatch(view, /\r\nX-Unsent:|\r\nAuto-Submitted:/);
  assert.match(parseEmail(Buffer.from(draft)).html, /Test story/);
});

test("manual export uses the Staff News sender and leaves the recipient blank", () => {
  const { window } = new JSDOM();
  try {
    const digest = readDigest(Buffer.from(sourceDigest), window.document, { inferRecipient: false });
    const eml = formatDigest(digest, DEFAULT_PRESET, new Date("2026-11-19T22:15:00Z"));
    const message = parseEmail(Buffer.from(eml));
    assert.equal(message.from, "bondstaffnews@bond.edu.au");
    assert.equal(message.subject, "Bond Staff News | Friday 20 November 2026");
    assert.match(message.html, /Test story/);
    assert.doesNotMatch(eml, /\r\n(?:To|X-Unsent):/i);
  } finally {
    window.close();
  }
});

test("default deployment serves the formatter with email delivery inaccessible", async (t) => {
  const config = loadConfig({});
  assert.equal(config.emailDeliveryEnabled, false);
  const web = createWebServer(config).listen(0, "127.0.0.1");
  await once(web, "listening");
  t.after(() => new Promise((resolve) => web.close(resolve)));

  const base = "http://127.0.0.1:" + web.address().port;
  const page = await (await fetch(base + "/#email")).text();
  assert.match(page, /Drop your \.eml file here/);
  assert.doesNotMatch(page, /Email delivery|delivery-form|editor-form|data-tab/);
  assert.equal((await fetch(base + "/healthz")).status, 200);
  assert.equal((await fetch(base + "/email-delivery.js")).status, 404);
  assert.equal((await fetch(base + "/api/email")).status, 404);
  assert.equal((await fetch(base + "/api/email/requests/" + "0".repeat(32))).status, 404);
  const start = await fetch(base + "/api/email/requests", {
    method: "POST",
    headers: { Origin: config.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: "staff@example.org" }),
  });
  assert.equal(start.status, 404);
});

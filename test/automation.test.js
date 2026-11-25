import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { dkimSign } from "mailauth/lib/dkim/sign";
import { formatDigest, readDigest } from "../dist/core/digest.js";
import { parseEmail } from "../dist/core/mime.js";
import { DEFAULT_PRESET } from "../dist/core/preset.js";
import { loadConfig } from "../server/config.js";
import { startDeliveryWorker } from "../server/delivery.js";
import { createWebServer } from "../server/http.js";
import { createSmtpServer } from "../server/smtp.js";
import { openStore } from "../server/store.js";

const config = loadConfig({
  DIGEST_EMAIL_DELIVERY_ENABLED: "true",
  DIGEST_GROUP_ADDRESS: "staff-news@example.org",
});
const sender = "staff@example.org";
const sourceDigest = `From: Staff Member <${sender}>\r\nReply-To: another@example.net\r\nTo: ${config.groupAddress}\r\nMessage-ID: <news-1@example.org>\r\nSubject: SharePoint digest\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<html><body><table><tr><td>
<a href="https://bonduni.sharepoint.com/sites/News/SitePages/Example.aspx">Test story</a>
<p>Sample summary.</p><div class="author">Example Author</div><div>19/11/2026</div>
</td></tr></table></body></html>\r\n`.replace(/\r?\n/g, "\r\n");
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "der" },
});
const keyRecord = "v=DKIM1; k=rsa; p=" + publicKey.toString("base64");
const resolveKey = async (name) => {
  if (["test._domainkey.example.org", "test._domainkey.example.net"].includes(name)) return [[keyRecord]];
  if (name === "example.org") return [["v=spf1 ip4:127.0.0.1 -all"]];
  if (name === "open.example.net") return [["v=spf1 +all"]];
  throw Object.assign(new Error("No DKIM key"), { code: name.startsWith("timeout.") ? "ETIMEOUT" : "ENODATA" });
};

async function sign(raw, { headerList, signingDomain = "example.org", selector = "test" } = {}) {
  const { signatures, errors } = await dkimSign(Buffer.from(raw, "latin1"), {
    signatureData: [{ signingDomain, selector, privateKey }],
    headerList,
  });
  assert.deepEqual(errors, []);
  assert.match(signatures, /^DKIM-Signature:/i);
  return signatures + raw;
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
  assert.match(await response(), /^220 /);
  assert.match(await command("EHLO example.net"), /^250 /);
  return {
    command,
    async send(raw, envelopeFrom = "forward+SRS=example.org=staff@relay.example.net") {
      // Microsoft 365 can rewrite the envelope while leaving the signed From intact.
      assert.match(await command(`MAIL FROM:<${envelopeFrom}>`), /^250 /);
      assert.match(await command(`RCPT TO:<${config.inboxAddress}>`), /^250 /);
      assert.match(await command("DATA"), /^354 /);
      const data = Buffer.from(raw.replace(/(^|\r\n)\./g, "$1..").replace(/\r\n$/, "") + "\r\n.\r\n", "latin1");
      socket.write(data);
      return response();
    },
    close: () => socket.destroy(),
  };
}

function exampleDigest() {
  const privateSample = process.env.DIGEST_TEST_EML;
  if (!privateSample) return sourceDigest;
  return readFileSync(privateSample).toString("latin1").replace(/\r?\n/g, "\r\n")
    .replace(/^From:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*/mi, `From: Staff Member <${sender}>`);
}

test("returns digests once to authenticated senders from different organisations", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T00:00:00Z") });
  const store = openStore(":memory:");
  const accepted = [];
  const smtp = createSmtpServer(config, store, undefined, resolveKey);
  smtp.listen(0, "127.0.0.1");
  await once(smtp.server, "listening");
  const stop = startDeliveryWorker(config, store, { async send(message) { accepted.push(message); } });
  const client = await smtpClient(smtp.server.address().port);
  t.after(async () => {
    client.close();
    await stop();
    await new Promise((resolve) => smtp.close(resolve));
    store.close();
  });

  assert.match(await client.command("MAIL FROM:<>"), /^550 /);
  assert.match(await client.command("MAIL FROM:<relay@example.net>"), /^250 /);
  assert.match(await client.command(`RCPT TO:<digest-${"0".repeat(32)}@inbox.bond-sdc.com>`), /^550 /);
  assert.match(await client.command("RSET"), /^250 /);
  const raw = await sign(exampleDigest());
  assert.match(await client.send(raw), /^250 Digest queued/);
  for (let attempt = 0; attempt < 50 && !accepted.length; attempt += 1) await delay(50);
  assert.match(await client.send("Received: by retry.example.net\r\n" + raw), /^250 Digest already received/);
  assert.equal(store.claim(), undefined);
  assert.equal(accepted.length, 1);
  const message = accepted[0];
  assert.equal(message.recipient, sender);
  const rendered = parseEmail(message.raw);
  assert.equal(rendered.from, config.from);
  assert.match(rendered.subject, /^Bond Staff News \| /);
  if (!process.env.DIGEST_TEST_EML) assert.match(rendered.html, /Test story/);
  assert.match(rendered.html, /View all news and upcoming events/);
  assert.equal(rendered.images.size, process.env.DIGEST_TEST_EML ? 3 : 1);
  assert.match(message.raw.toString(), /\r\nAuto-Submitted: auto-replied\r\n/);

  const otherSender = "staff@example.net";
  const otherDigest = sourceDigest.replace(sender, otherSender).replace("bonduni.sharepoint.com", "sampletenant.sharepoint.com");
  assert.match(await client.send(await sign(otherDigest, { signingDomain: "example.net" })), /^250 Digest queued/);
  for (let attempt = 0; attempt < 50 && accepted.length < 2; attempt += 1) await delay(50);
  assert.equal(accepted.length, 2);
  assert.equal(accepted[1].recipient, otherSender);
  assert.match(parseEmail(accepted[1].raw).html, /sampletenant\.sharepoint\.com/);
});

test("rejects unauthenticated, mismatched or altered From fields before creating a job", async (t) => {
  const store = openStore(":memory:");
  const smtp = createSmtpServer(config, store, undefined, resolveKey);
  smtp.listen(0, "127.0.0.1");
  await once(smtp.server, "listening");
  const client = await smtpClient(smtp.server.address().port);
  t.after(async () => {
    client.close();
    await new Promise((resolve) => smtp.close(resolve));
    store.close();
  });

  assert.match(await client.send("Authentication-Results: example.org; dkim=pass\r\n" + sourceDigest), /^550 .*DKIM or SPF/);
  assert.match(await client.send(await sign(sourceDigest.replace(sender, "other@example.net"))), /^550 .*DKIM or SPF/);
  const signed = await sign(sourceDigest);
  assert.match(await client.send("From: Staff Member <staff@example.org>\r\n" + signed), /^550 /);
  assert.match(await client.send(signed.replace("Sample summary.", "Edited summary.")), /^550 .*DKIM/);
  assert.match(await client.send(await sign(sourceDigest, { selector: "timeout" })), /^451 .*authentication/);
  const autoReply = await sign("Auto-Submitted: auto-replied\r\n" + sourceDigest);
  assert.match(await client.send(autoReply), /^550 .*automatic reply/);
  assert.equal(store.claim(), undefined);
});

test("can use aligned SMTP SPF and uses the signature ID when DKIM leaves Message-ID unsigned", async (t) => {
  const store = openStore(":memory:");
  const smtp = createSmtpServer(config, store, undefined, resolveKey);
  smtp.listen(0, "127.0.0.1");
  await once(smtp.server, "listening");
  const client = await smtpClient(smtp.server.address().port);
  t.after(async () => {
    client.close();
    await new Promise((resolve) => smtp.close(resolve));
    store.close();
  });

  const rewrittenEnvelope = "forward+SRS=example.org=staff@example.org";
  assert.match(await client.send(sourceDigest, rewrittenEnvelope), /^250 Digest queued/);
  assert.match(await client.send(sourceDigest, rewrittenEnvelope), /^250 Digest already received/);
  assert.equal(store.claim().recipient, sender);

  const openSpfMessage = sourceDigest.replace(sender, "staff@open.example.net");
  assert.match(await client.send(openSpfMessage, "staff@open.example.net"), /^550 .*DKIM or SPF/);
  const unsignedId = await sign(sourceDigest, { headerList: ["from", "subject", "content-type"] });
  assert.match(await client.send(unsignedId), /^250 Digest queued/);
  assert.match(await client.send(unsignedId.replace("<news-1@example.org>", "<news-2@example.org>")), /^250 Digest already received/);
  assert.equal(store.claim().recipient, sender);
  assert.equal(store.claim(), undefined);
});

test("recovers queued mail after restart and avoids repeating an unconfirmed send", () => {
  const dir = mkdtempSync(join(tmpdir(), "digest-bot-test-"));
  const database = join(dir, "queue.sqlite");
  const incoming = { recipient: sender, subject: DEFAULT_PRESET.subject, messageId: "<one@example.org>", raw: Buffer.from("first") };
  try {
    const before = openStore(database);
    assert.equal(before.enqueueIncoming(incoming, 1), "queued");
    assert.equal(before.enqueueIncoming({ ...incoming, messageId: "<two@example.org>", raw: Buffer.from("second") }, 2), "queued");
    const first = before.claim(3);
    before.sending(first.id);
    before.claim(3);
    before.close();

    const after = openStore(database);
    const reader = new DatabaseSync(database, { readOnly: true });
    try {
      after.recover();
      const previous = reader.prepare("SELECT state, raw FROM jobs WHERE id = ?").get(first.id);
      assert.equal(previous.state, "uncertain");
      assert.equal(previous.raw, null);
      assert.equal(Buffer.from(after.claim(10).raw).toString(), "second");
      assert.equal(after.claim(10), undefined);
      assert.equal(after.enqueueIncoming(incoming, 10), "duplicate");
    } finally {
      reader.close();
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("the website exposes only the group address when automatic mode is configured", async (t) => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const current of [loadConfig({}), config]) {
    const web = createWebServer(current).listen(0, "127.0.0.1");
    await once(web, "listening");
    t.after(() => new Promise((resolve) => web.close(resolve)));

    const base = "http://127.0.0.1:" + web.address().port;
    const page = await (await fetch(base)).text();
    assert.match(page, /Drop your \.eml file here/);
    assert.doesNotMatch(page, /delivery-form|editor-form|Return email address/);
    const { window } = new JSDOM(page);
    t.after(() => window.close());
    const { document } = window;
    const tabs = [...document.querySelectorAll("[data-workflow]")];
    assert.deepEqual(tabs.map((tab) => tab.dataset.workflow), ["automatic", "manual"]);
    assert.equal(tabs[0].getAttribute("aria-current"), "page");
    assert.equal(document.getElementById("automatic-view").hidden, false);
    assert.equal(document.getElementById("manual-view").hidden, true);
    const footer = document.querySelector("body > footer");
    assert.match(footer.textContent, /Author: Joshua Lavagna-Slater/);
    assert.equal(footer.querySelector(".version").textContent, `v${version}`);
    assert.equal(document.querySelector("header .home-link").href, "https://bond-sdc.com/");
    assert.equal((await fetch(base + "/healthz")).status, 200);
    const settings = await fetch(base + "/api/email");
    if (current.emailDeliveryEnabled) assert.deepEqual(await settings.json(), { groupAddress: config.groupAddress });
    else assert.equal(settings.status, 404);
    assert.equal((await fetch(base + "/api/email/requests/" + "0".repeat(32))).status, 404);
    assert.equal((await fetch(base + "/api/email/requests", { method: "POST" })).status, 404);
  }
});

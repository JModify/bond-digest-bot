import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { formatDigest, readDigest } from "../dist/core/digest.js";
import { readEmailSubject } from "../dist/core/mime.js";
import { linkDestination } from "../dist/core/sharepoint.js";

const queuePollIntervalMs = 500;
const pruneIntervalMs = 60_000;
const sesTimeoutMs = 25_000;
const retryDelayMs = 15_000;
const maxThrottleRetries = 2;

export function createSesTransport(region) {
  // Retry only explicit throttling responses in the queue. A timeout can mean
  // that SES has already accepted the message.
  const client = new SESv2Client({ region, maxAttempts: 1 });
  return {
    send({ from, recipient, raw }) {
      return client.send(new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [recipient] },
        Content: { Raw: { Data: raw } },
      }), { abortSignal: AbortSignal.timeout(sesTimeoutMs) });
    },
    close() {
      client.destroy();
    },
  };
}

function isAllowedSharePointUrl(url, hosts) {
  const { hostname, protocol } = new URL(linkDestination(url));
  if (protocol !== "https:") return false;
  return hosts.length ? hosts.includes(hostname) : hostname.endsWith(".sharepoint.com");
}

export function retargetDigest(raw, from, recipient) {
  const separator = raw.indexOf("\r\n\r\n");
  if (separator === -1) throw new Error("The archived email is missing its MIME headers");
  const headers = raw.subarray(0, separator).toString("latin1").split(/\r\n(?=[^ \t])/);
  const preserved = headers.filter((header) => !/^(?:from|to|cc|bcc|message-id|resent-[^:]+):/i.test(header));
  return Buffer.concat([Buffer.from([...preserved, `From: ${from}`, `To: ${recipient}`].join("\r\n"), "latin1"), raw.subarray(separator)]);
}

export function startDeliveryWorker(config, store, transport, log = console, outgoingPaused = () => false) {
  // JSDOM gets no script execution or external resource loader.
  const { window } = new JSDOM("");
  const logo = {
    kind: "inline",
    type: "image/png",
    bytes: readFileSync(new URL("../dist/assets/bond-logo.png", import.meta.url)),
  };
  const { sharepointHosts, from } = config;
  let running;
  let nextPrune = 0;

  function prepare(job) {
    try {
      if (job.originalId) {
        return { raw: retargetDigest(store.history.readArchived(job.originalId), from, job.recipient) };
      }
      if (job.attempts) {
        const archived = store.history.readArchived(job.historyId);
        if (archived) return { raw: archived };
      }
      const digest = readDigest(job.raw, window.document, { inferRecipient: false });
      if (!digest.articles.every((article) => isAllowedSharePointUrl(article.href, sharepointHosts))) {
        return { reason: "source_host", detail: "The digest contained an unsupported SharePoint news link." };
      }
      if (digest.siteUrl && !isAllowedSharePointUrl(digest.siteUrl, sharepointHosts)) digest.siteUrl = "";
      for (const article of digest.articles) {
        // Do not turn an incoming external image URL into a tracking request.
        if (article.image?.kind === "remote" && !isAllowedSharePointUrl(article.image.url, sharepointHosts)) {
          article.image = null;
        }
      }
      const preset = { from, subject: job.subject, recipient: job.recipient };
      return { raw: Buffer.from(formatDigest(digest, preset, new Date(), logo, { automatic: true })), archive: true };
    } catch {
      return job.originalId
        ? { reason: "archive", detail: "The archived digest could not be read." }
        : { reason: "format", detail: "The email did not contain a readable SharePoint digest." };
    }
  }

  async function deliver(job) {
    const queueMs = Math.max(0, Date.now() - job.queuedAt);
    const formatStartedAt = performance.now();
    const { raw, archive, reason, detail } = prepare(job);
    if (!raw) {
      store.finish(job.id, "failed", reason, { detail });
      log.warn(detail);
      return;
    }

    const formatMs = Math.round(performance.now() - formatStartedAt);
    store.sending(job.id, { raw: archive ? raw : undefined, subject: archive ? readEmailSubject(raw) : undefined,
      detail: `Submitting to Amazon SES. Queue: ${queueMs} ms. Preparation: ${formatMs} ms.` });
    const sesStartedAt = performance.now();
    let response;
    try {
      response = await transport.send({ from, recipient: job.recipient, raw });
    } catch (error) {
      const sesMs = Math.round(performance.now() - sesStartedAt);
      const status = error.$metadata?.httpStatusCode;
      const name = /^[a-z0-9_.-]{1,80}$/i.test(error.name ?? "") ? error.name : "Request error";
      const detail = `${name}${status ? ` (HTTP ${status})` : ""} after ${sesMs} ms.`;
      if (status === 429 && job.attempts < maxThrottleRetries) {
        store.retry(job.id, retryDelayMs * (job.attempts + 1), Date.now(), detail);
      } else if (status >= 400 && status < 500 && status !== 408) {
        store.finish(job.id, "failed", status === 429 ? "provider_limit" : "provider_rejected", { detail });
      } else {
        store.finish(job.id, "uncertain", "unconfirmed", { detail });
      }
      log.warn("Digest delivery returned an error", { status: status ?? "unconfirmed", queueMs, formatMs, sesMs });
      return;
    }
    const sesMs = Math.round(performance.now() - sesStartedAt);
    store.finish(job.id, "sent", null, { detail: `Amazon SES accepted the email after ${sesMs} ms.`, messageId: response?.MessageId });
    log.info("Formatted digest accepted by SES", { queueMs, formatMs, sesMs, messageId: response?.MessageId });
  }

  async function tick() {
    const now = Date.now();
    if (now >= nextPrune) {
      store.prune(now);
      nextPrune = now + pruneIntervalMs;
    }
    if (outgoingPaused()) return;
    const job = store.claim(now);
    if (job) await deliver(job);
  }

  const interval = setInterval(() => {
    if (running) return;
    running = tick().catch(() => {
      // Any stale processing/sending state is reconciled on the next service start.
      log.error("Digest worker could not update its queue");
      process.exitCode = 1;
      clearInterval(interval);
      config.onWorkerError?.();
    }).finally(() => { running = undefined; });
  }, queuePollIntervalMs);

  return async () => {
    clearInterval(interval);
    await running;
    window.close();
  };
}

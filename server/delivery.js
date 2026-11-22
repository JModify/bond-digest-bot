import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { formatDigest, readDigest } from "../dist/core/digest.js";
import { linkDestination } from "../dist/core/sharepoint.js";
import { recipientAllowed } from "./config.js";

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
      }), { abortSignal: AbortSignal.timeout(25_000) });
    },
    close() {
      client.destroy();
    },
  };
}

function hostedBy(url, hosts) {
  return hosts.includes(new URL(linkDestination(url)).hostname);
}

export function startDeliveryWorker(config, store, transport, log = console) {
  // JSDOM gets no script execution or external resource loader.
  const browser = new JSDOM("");
  const logo = {
    kind: "inline",
    type: "image/png",
    bytes: readFileSync(new URL("../dist/assets/bond-logo.png", import.meta.url)),
  };
  const { sharepointHosts, from } = config;
  let running;
  let nextPrune = 0;

  async function deliver(job) {
    if (!recipientAllowed(job.recipient, config)) {
      store.finish(job.id, "failed", "recipient");
      return;
    }

    let raw;
    try {
      const digest = readDigest(job.raw, browser.window.document);
      if (!digest.articles.every((article) => hostedBy(article.href, sharepointHosts))) {
        store.finish(job.id, "failed", "source_host");
        return;
      }
      if (digest.siteUrl && !hostedBy(digest.siteUrl, sharepointHosts)) digest.siteUrl = "";
      for (const article of digest.articles) {
        // Do not turn an incoming external image URL into a tracking request.
        if (article.image?.kind === "remote" && !hostedBy(article.image.url, sharepointHosts)) article.image = null;
      }
      raw = Buffer.from(formatDigest(digest, { from, subject: job.subject, recipient: job.recipient },
        new Date(), logo, { automatic: true }));
    } catch {
      store.finish(job.id, "failed", "format");
      return;
    }

    store.sending(job.id);
    try {
      await transport.send({ from, recipient: job.recipient, raw });
    } catch (error) {
      const status = error.$metadata?.httpStatusCode;
      if (status === 429 && job.attempts < 2) {
        store.retry(job.id, 15_000 * (job.attempts + 1));
      } else if (status >= 400 && status < 500 && status !== 408) {
        store.finish(job.id, "failed", status === 429 ? "provider_limit" : "provider_rejected");
      } else {
        store.finish(job.id, "uncertain", "unconfirmed");
      }
      log.warn("Digest delivery returned an error", { status: status ?? "unconfirmed" });
      return;
    }
    store.finish(job.id, "sent");
  }

  async function tick() {
    const now = Date.now();
    if (now >= nextPrune) {
      store.prune(now);
      nextPrune = now + 60_000;
    }
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
  }, 500);

  return async () => {
    clearInterval(interval);
    await running;
    browser.window.close();
  };
}

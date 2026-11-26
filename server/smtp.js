// Accepts incoming mail for the bot's one SMTP address, authenticates it and queues it for the
// worker.

import { SMTPServer } from "smtp-server";
import { normaliseAddress } from "../dist/core/mailbox.js";
import { readEmailSubject } from "../dist/core/mime.js";
import { DEFAULT_PRESET } from "../dist/core/preset.js";
import { createDigestAuthenticator, smtpReply } from "./incoming.js";

export function createSmtpServer(config, store, tls, resolveDns) {
  const authenticate = createDigestAuthenticator(config, resolveDns);
  const temporaryFailure = () => smtpReply(451, "Digest Bot temporarily unavailable");
  const options = tls ? { ...tls, minVersion: "TLSv1.2" } : {};
  return new SMTPServer({
    ...options,
    name: config.mailHost,
    banner: "Digest Bot",
    authOptional: true,
    // The test listener uses loopback. Production requires STARTTLS.
    disabledCommands: ["AUTH", "XCLIENT", "XFORWARD", ...(tls ? [] : ["STARTTLS"])],
    socketTimeout: 60_000,
    maxClients: 16,
    size: config.maxMessageBytes,

    // Require TLS in production and reject bounces, which use an empty envelope sender.
    onMailFrom(address, session, done) {
      if (tls && !session.secure) return done(smtpReply(530, "STARTTLS required"));
      if (!address.address) return done(smtpReply(550, "Bounce messages are not accepted"));
      done();
    },
    onRcptTo(address, session, done) {
      if (address.address.toLowerCase() !== config.inboxAddress)
        return done(smtpReply(550, "Unknown Digest Bot address"));
      if (session.envelope.rcptTo.length)
        return done(smtpReply(550, "One Digest Bot recipient per message"));
      done();
    },
    onData(stream, session, done) {
      // Read the SMTP stream to completion. Stop keeping bytes once it exceeds the configured size.
      async function receive() {
        const chunks = [];
        let size = 0;
        for await (const chunk of stream) {
          size += chunk.length;
          if (size <= config.maxMessageBytes) chunks.push(chunk);
        }
        if (stream.sizeExceeded || size > config.maxMessageBytes) {
          throw smtpReply(552, "Digest exceeds the message size limit");
        }

        const raw = Buffer.concat(chunks, size);
        const authStartedAt = performance.now();
        const identity = await authenticate(raw, {
          envelopeFrom: session.envelope.mailFrom.address,
          ip: session.remoteAddress,
          helo: session.hostNameAppearsAs,
        });
        const authMs = Math.round(performance.now() - authStartedAt);
        // An SMTP success reply follows a committed queue write. A retry of the same digest
        // receives a success reply without another job.
        const sourceSubject = readEmailSubject(raw).slice(0, 512);
        const result = store.enqueueIncoming({
          ...identity,
          raw,
          sourceSubject,
          subject: DEFAULT_PRESET.subject,
        });
        if (result === "busy") throw temporaryFailure();
        if (result === "queued")
          console.info("Authenticated digest queued", { method: identity.method, authMs });
        done(null, result === "duplicate" ? "Digest already received" : "Digest queued");
      }
      receive().catch((error) => {
        if (error.authentication)
          console.warn("Digest authentication rejected", JSON.stringify(error.authentication));
        const reply = error.responseCode ? error : temporaryFailure();
        const authentication = error.authentication;
        const result = authentication
          ? ` DKIM: ${authentication.dkim.map(({ result }) => result).join(", ") || "none"}. SPF: ${authentication.spf}.`
          : "";
        // Give the admin timeline a record of a rejected or deferred DATA attempt even if there is
        // no job.
        try {
          store.recordSmtpAttempt({
            source: normaliseAddress(session.envelope.mailFrom.address),
            state: reply.responseCode >= 500 ? "rejected" : "deferred",
            description: `SMTP ${reply.responseCode}: ${reply.message}.${result}`,
          });
        } catch {
          console.error("Could not record the SMTP attempt");
        }
        done(reply);
      });
    },
  });
}

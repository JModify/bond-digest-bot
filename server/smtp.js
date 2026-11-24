import { SMTPServer } from "smtp-server";
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

    onMailFrom(address, session, done) {
      if (tls && !session.secure) return done(smtpReply(530, "STARTTLS required"));
      if (!address.address) return done(smtpReply(550, "Bounce messages are not accepted"));
      done();
    },
    onRcptTo(address, session, done) {
      if (address.address.toLowerCase() !== config.inboxAddress) return done(smtpReply(550, "Unknown Digest Bot address"));
      if (session.envelope.rcptTo.length) return done(smtpReply(550, "One Digest Bot recipient per message"));
      done();
    },
    onData(stream, session, done) {
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
        const identity = await authenticate(raw, {
          envelopeFrom: session.envelope.mailFrom.address,
          ip: session.remoteAddress,
          helo: session.hostNameAppearsAs,
        });
        const result = store.enqueueIncoming({ ...identity, raw, subject: DEFAULT_PRESET.subject });
        if (result === "busy") throw temporaryFailure();
        if (result === "queued") console.info("Authenticated digest queued", { method: identity.method });
        done(null, result === "duplicate" ? "Digest already received" : "Digest queued");
      }
      receive().catch((error) => {
        if (error.authentication) console.warn("Digest authentication rejected", JSON.stringify(error.authentication));
        done(error.responseCode ? error : temporaryFailure());
      });
    },
  });
}

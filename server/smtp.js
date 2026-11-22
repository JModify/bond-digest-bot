import { SMTPServer } from "smtp-server";
import { readEmailSubject } from "../dist/core/mime.js";

const reply = (responseCode, message) => Object.assign(new Error(message), { responseCode });
const closedRequest = () => reply(550, "Unknown or closed Digest Bot address");
const titleCodes = /\bDB-[0-9A-F]{12}\b/g;

export function createSmtpServer(config, store, tls) {
  const localPart = /^digest-([0-9a-f]{32})$/;
  const temporaryFailure = () => reply(451, "Digest Bot temporarily unavailable");
  const options = tls ? { ...tls, minVersion: "TLSv1.2" } : {};
  return new SMTPServer({
    ...options,
    name: config.mailHost,
    banner: "Digest Bot",
    authOptional: true,
    // The test listener uses loopback. Production supplies a certificate and requires STARTTLS.
    disabledCommands: tls ? ["AUTH"] : ["AUTH", "STARTTLS"],
    socketTimeout: 60_000,
    maxClients: 16,
    size: config.maxMessageBytes,

    onMailFrom(address, session, done) {
      if (tls && !session.secure) return done(reply(530, "STARTTLS required"));
      if (!address.address) return done(reply(550, "Bounce messages are not accepted"));
      done();
    },
    onRcptTo(address, session, done) {
      const [local, domain, remainder] = address.address.toLowerCase().split("@");
      const id = localPart.exec(local)?.[1];
      if (remainder || domain !== config.inboxDomain || !id) return done(closedRequest());
      if (session.envelope.rcptTo.length) return done(reply(550, "One Digest Bot recipient per message"));
      try {
        if (!store.incoming(id)) return done(closedRequest());
      } catch {
        return done(temporaryFailure());
      }
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
          return done(reply(552, "Digest exceeds the message size limit"));
        }

        const address = session.envelope.rcptTo[0].address.toLowerCase();
        const [local] = address.split("@");
        const id = localPart.exec(local)[1];
        const job = store.incoming(id);
        if (!job) return done(closedRequest());
        const raw = Buffer.concat(chunks, size);
        const codes = readEmailSubject(raw).toUpperCase().match(titleCodes);
        if (!codes?.includes(job.title_code)) return done(reply(550, "Use the displayed Digest Bot code as the digest title"));
        if (!store.enqueue(id, raw)) {
          return done(store.incoming(id) ? temporaryFailure() : closedRequest());
        }
        done(null, "Digest queued");
      }
      receive().catch(() => done(temporaryFailure()));
    },
  });
}

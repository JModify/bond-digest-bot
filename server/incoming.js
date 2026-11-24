import { Resolver } from "node:dns/promises";
import { dkimVerify } from "mailauth/lib/dkim/verify";
import { normaliseAddress } from "../dist/core/mailbox.js";
import { recipientAllowed } from "./config.js";

const dns = new Resolver({ timeout: 2500, tries: 2 });
const verificationFields = new Set(["from", "message-id", "content-type", "content-transfer-encoding"]);

export const smtpReply = (responseCode, message) => Object.assign(new Error(message), { responseCode });

export function createDigestAuthenticator(config, resolveTxt = (name) => dns.resolveTxt(name)) {
  const domains = new Set([...config.recipientDomains, ...config.allowedRecipients.map((address) => address.split("@")[1])]);

  return async function authenticateDigest(raw) {
    let lookupCount = 0;
    const verified = await dkimVerify(raw, {
      strict: true,
      resolver(name) {
        const domain = name.toLowerCase().split("._domainkey.")[1];
        if (!domains.has(domain) || lookupCount++ >= 6) {
          throw Object.assign(new Error("No matching DKIM key"), { code: "ENODATA" });
        }
        return resolveTxt(name);
      },
    });

    // Exchange may rewrite the SMTP envelope. Route replies by the signed From field.
    const recipient = normaliseAddress(verified.headerFrom[0]).toLowerCase();
    if (verified.fromFields !== 1 || verified.fromSyntax !== "valid" || verified.headerFrom.length !== 1 || !recipientAllowed(recipient, config)) {
      throw smtpReply(550, "Original From address is not approved for Digest Bot");
    }

    const fields = new Map();
    for (const { key, line } of verified.headers.parsed) {
      if (!verificationFields.has(key)) continue;
      if (fields.has(key)) throw smtpReply(550, "Digest has conflicting mail headers");
      const value = line.toString("latin1");
      fields.set(key, value.slice(value.indexOf(":") + 1).trim());
    }
    const messageId = fields.get("message-id") ?? "";
    if (messageId.length > 255 || !/^<[^<>@\s]+@[^<>@\s]+>$/.test(messageId) || !fields.has("content-type")) {
      throw smtpReply(550, "Digest is missing a usable Message-ID or Content-Type");
    }

    const domain = recipient.split("@")[1];
    const signatures = verified.results.filter((signature) => signature.signingDomain?.toLowerCase() === domain);
    const authorized = signatures.some((signature) => {
      if (signature.status.result !== "pass" || !signature.signatureTimeValid || signature.canonBodyLengthLimited) return false;
      const signed = signature.signingHeaders.keys.toLowerCase().split(":").map((key) => key.trim());
      return [...fields.keys()].every((key) => signed.includes(key));
    });
    if (authorized) return { recipient, messageId };
    if (signatures.some((signature) => signature.status.result === "temperror")) {
      throw smtpReply(451, "Digest Bot could not check the DKIM key yet");
    }
    throw smtpReply(550, "Digest Bot could not verify the original sender with DKIM");
  };
}

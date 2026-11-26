// Verifies the sender on incoming digests and returns the mailbox the worker can reply to.

import { Resolver } from "node:dns/promises";
import { dkimVerify } from "mailauth/lib/dkim/verify";
import { spf } from "mailauth/lib/spf";
import { normaliseAddress } from "../dist/core/mailbox.js";

const dns = new Resolver({ timeout: 2500, tries: 2 });
const protectedFields = ["from", "content-type", "content-transfer-encoding"];
const relevantFields = new Set([...protectedFields, "message-id", "auto-submitted"]);
const unrestrictedSpf = /(?:^|\s)\+?(?:all|ip[46]:\S+\/0)(?=\s|$)/i;
const publicDnsName = /^[a-z0-9_.-]{1,253}$/i;

export const smtpReply = (responseCode, message) =>
  Object.assign(new Error(message), { responseCode });

// A usable DKIM signature covers the full body and the MIME headers needed to interpret it. Its
// signing domain must equal the From domain.
function dkimDetail(signature, authorDomain, fields) {
  const domain = signature.signingDomain?.toLowerCase();
  const selector = signature.selector;
  let result = signature.status.result;
  if (signature.status.comment === "body hash did not verify") result = "body-changed";
  if (result === "pass") {
    if (domain !== authorDomain) result = "domain-mismatch";
    else if (!signature.signatureTimeValid) result = "signature-time-invalid";
    else if (signature.canonBodyLengthLimited) result = "partial-body";
    else {
      const signed = signature.signingHeaders.keys
        .toLowerCase()
        .split(":")
        .map((key) => key.trim());
      if (fields.some((key) => !signed.includes(key))) result = "unsigned-mime-header";
    }
  }
  return {
    domain: publicDnsName.test(domain ?? "") ? domain : undefined,
    selector: publicDnsName.test(selector ?? "") ? selector : undefined,
    result,
  };
}

export function createDigestAuthenticator(
  config,
  resolve = (name, type) => dns.resolve(name, type),
) {
  const botAddresses = new Set([
    config.inboxAddress,
    config.groupAddress,
    config.from.toLowerCase(),
  ]);

  // A policy that authorises every IP gives no evidence about the connection. Exclude it from the
  // SPF check.
  async function resolveSpf(name, type) {
    const records = await resolve(name, type);
    if (
      type === "TXT" &&
      records.some((parts) => {
        const record = parts.join("");
        return /^v=spf1(?:\s|$)/i.test(record) && unrestrictedSpf.test(record);
      })
    ) {
      throw Object.assign(new Error("Unrestricted SPF policy"), { code: "ENODATA" });
    }
    return records;
  }

  return async function authenticateDigest(raw, { envelopeFrom, ip, helo }) {
    let lookups = 0;
    const verified = await dkimVerify(raw, {
      strict: true,
      resolver(name, type) {
        if (lookups++ >= 6)
          throw Object.assign(new Error("DKIM lookup limit reached"), { code: "ENODATA" });
        return resolve(name, type);
      },
    });
    // The authenticated From mailbox determines the reply destination. The SMTP envelope sender is
    // checked separately for SPF.
    const recipient = normaliseAddress(verified.headerFrom[0]).toLowerCase();
    if (
      verified.fromFields !== 1 ||
      verified.fromSyntax !== "valid" ||
      verified.headerFrom.length !== 1 ||
      !recipient
    ) {
      throw smtpReply(550, "Digest Bot needs one valid original From address");
    }

    const fields = new Map();
    for (const { key, line } of verified.headers.parsed) {
      if (!relevantFields.has(key)) continue;
      if (fields.has(key)) throw smtpReply(550, "Digest has conflicting mail headers");
      const value = line.toString("latin1");
      fields.set(key, value.slice(value.indexOf(":") + 1).trim());
    }
    // Break mail loops by rejecting bot and group addresses and already-marked automatic replies.
    if (
      botAddresses.has(recipient) ||
      /^auto-replied\b/i.test(fields.get("auto-submitted") ?? "")
    ) {
      throw smtpReply(
        550,
        "Digest Bot cannot reply to a group, a bot address or an automatic reply",
      );
    }
    if (!fields.has("content-type"))
      throw smtpReply(550, "Digest is missing a Content-Type header");
    const rawMessageId = fields.get("message-id") ?? "";
    const messageId =
      rawMessageId.length <= 255 && /^<[^<>@\s]+@[^<>@\s]+>$/.test(rawMessageId)
        ? rawMessageId
        : "";
    const authorDomain = recipient.split("@")[1];
    const presentFields = protectedFields.filter((key) => fields.has(key));
    const dkim = verified.results.map((signature) =>
      dkimDetail(signature, authorDomain, presentFields),
    );
    const trustedIndex = dkim.findIndex(({ result }) => result === "pass");
    if (trustedIndex !== -1) {
      const signature = verified.results[trustedIndex];
      // Keep successful retries keyed on Message-ID. An unsigned ID cannot override the signed key.
      const idIsSigned = /(?:^|:)\s*message-id(?:\s*:|$)/i.test(signature.signingHeaders.keys);
      const key = messageId && idIsSigned ? messageId : `dkim:${signature.id}`;
      return { recipient, messageId: key, method: "dkim" };
    }

    // SPF authenticates the SMTP connection. Forwarding is usable when the envelope and From domains agree.
    const envelopeDomain = normaliseAddress(envelopeFrom).split("@")[1]?.toLowerCase();
    let spfStatus = "domain-mismatch";
    if (envelopeDomain === authorDomain) {
      const checked = await spf({
        sender: envelopeFrom,
        ip,
        helo,
        mta: config.mailHost,
        strict: true,
        resolver: resolveSpf,
        maxElapsedTime: 7_000,
      });
      spfStatus = checked.status.result;
      if (spfStatus === "pass") {
        if (!messageId) throw smtpReply(550, "Digest is missing a usable Message-ID");
        return { recipient, messageId, method: "spf" };
      }
    }

    // A temporary authentication problem returns 451 so the sending server can try again.
    const retry =
      spfStatus === "temperror" ||
      dkim.some(({ domain, result }) => domain === authorDomain && result === "temperror");
    const error = retry
      ? smtpReply(451, "Digest Bot could not complete email authentication yet")
      : smtpReply(
          550,
          "Digest Bot could not authenticate the original sender with aligned DKIM or SPF",
        );
    error.authentication = { authorDomain, envelopeDomain, dkim: dkim.slice(0, 6), spf: spfStatus };
    throw error;
  };
}

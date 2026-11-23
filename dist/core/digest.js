import { parseEmail, serializeEmail } from "./mime.js";
import { DEFAULT_PRESET } from "./preset.js";
import { renderDigest } from "./render.js";
import { extractSharePointDigest } from "./sharepoint.js";

const automatedSender = /^(?:no[._-]?reply|do[._-]?not[._-]?reply)(?:[+._-]|@)/i;

export function readDigest(bytes, document, { inferRecipient = true } = {}) {
  const email = parseEmail(bytes);
  const digest = extractSharePointDigest(email, document);
  if (!inferRecipient) return digest;
  const suggestedRecipient = [email.from, email.replyTo, email.sender].find((address) =>
    address && address.toLowerCase() !== DEFAULT_PRESET.from && !automatedSender.test(address),
  ) || "";
  return { ...digest, suggestedRecipient };
}

export function formatDigest(digest, preset, date = new Date(), logo, options = {}) {
  return serializeEmail(renderDigest(digest, preset, { date, logo }), date, options);
}

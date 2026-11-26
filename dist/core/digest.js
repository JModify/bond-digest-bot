// Joins the MIME reader, SharePoint extractor, renderer and exporter for both workflows.

import { parseEmail, serializeEmail } from "./mime.js";
import { DEFAULT_PRESET } from "./preset.js";
import { renderDigest } from "./render.js";
import { extractSharePointDigest } from "./sharepoint.js";

const automatedSender = /^(?:no[._-]?reply|do[._-]?not[._-]?reply)(?:[+._-]|@)/i;

// Pass a browser or JSDOM document for HTML parsing. Both active workflows supply their own
// recipient handling by disabling inference.
export function readDigest(bytes, document, { inferRecipient = true } = {}) {
  const email = parseEmail(bytes);
  const digest = extractSharePointDigest(email, document);
  if (!inferRecipient) return digest;
  const suggestedRecipient =
    [email.from, email.replyTo, email.sender].find(
      (address) =>
        address && address.toLowerCase() !== DEFAULT_PRESET.from && !automatedSender.test(address),
    ) || "";
  return { ...digest, suggestedRecipient };
}

// Turn the extracted articles into a complete .eml string with headers, body alternatives and
// inline images.
export function formatDigest(digest, preset, date = new Date(), logo, options = {}) {
  return serializeEmail(renderDigest(digest, preset, { date, logo }), date, options);
}

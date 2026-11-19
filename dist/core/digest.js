import { parseEmail, serializeEmail } from "./mime.js";
import { renderDigest } from "./render.js";
import { extractSharePointDigest } from "./sharepoint.js";

// Upload and download are adapters. A future mail transport can provide raw
// message bytes here and use the same digest model, preset and formatter.
export function readDigest(bytes, document) {
  return extractSharePointDigest(parseEmail(bytes), document);
}

export function formatDigest(digest, preset, date) {
  return serializeEmail(renderDigest(digest, preset), date);
}

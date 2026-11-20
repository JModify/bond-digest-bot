import { parseEmail, serializeEmail } from "./mime.js";
import { renderDigest } from "./render.js";
import { extractSharePointDigest } from "./sharepoint.js";

export function readDigest(bytes, document) {
  return extractSharePointDigest(parseEmail(bytes), document);
}

export function formatDigest(digest, preset, date = new Date(), logo) {
  return serializeEmail(renderDigest(digest, preset, { date, logo }), date);
}

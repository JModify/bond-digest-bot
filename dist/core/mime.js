// MIME decoding and serialization use byte arrays so Windows-1252 and UTF-8
// messages go through the same pipeline in the browser or a future worker.
const utf8 = new TextEncoder();
const crlf = "\r\n";

export function toBase64(bytes) {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value.replace(/\s/g, "")), (character) => character.charCodeAt(0));
}

function decodeText(bytes, charset) {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function unquote(value) {
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1).replace(/\\(.)/g, "$1")
    : value;
}

function contentType(value = "text/plain") {
  const [name, ...fields] = value.match(/(?:[^";]|"(?:\\.|[^"\\])*")+/g) || [];
  const parameters = {};
  for (const field of fields) {
    const index = field.indexOf("=");
    if (index > 0) parameters[field.slice(0, index).trim().toLowerCase()] = unquote(field.slice(index + 1).trim());
  }
  return { name: name?.trim().toLowerCase(), parameters };
}

function quotedPrintable(value) {
  const raw = value.replace(/=\r?\n/g, "");
  const bytes = new Uint8Array(raw.length);
  let length = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const pair = raw.slice(index + 1, index + 3);
    if (raw[index] === "=" && /^[\da-f]{2}$/i.test(pair)) {
      bytes[length++] = Number.parseInt(pair, 16);
      index += 2;
    } else {
      bytes[length++] = raw.charCodeAt(index);
    }
  }
  return bytes.subarray(0, length);
}

function readBody(value, encoding) {
  switch (encoding?.trim().toLowerCase()) {
    case "base64":
      return fromBase64(value);
    case "quoted-printable":
      return quotedPrintable(value);
    default:
      return Uint8Array.from(value, (character) => character.charCodeAt(0));
  }
}

function decodeHeader(value = "") {
  // RFC 2047 ignores whitespace between adjacent encoded words.
  return value.replace(/(\?=)[ \t]+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (word, charset, encoding, body) => {
      try {
        const bytes = encoding.toLowerCase() === "b" ? fromBase64(body) : quotedPrintable(body.replace(/_/g, " "));
        return decodeText(bytes, charset);
      } catch {
        return word;
      }
    });
}

function readHeaders(raw) {
  const headers = new Map();
  for (const line of raw.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (field && !headers.has(field[1].toLowerCase())) headers.set(field[1].toLowerCase(), field[2]);
  }
  return headers;
}

function readEntity(raw) {
  const separator = /\r?\n\r?\n/.exec(raw);
  return separator
    ? { headers: readHeaders(raw.slice(0, separator.index)), body: raw.slice(separator.index + separator[0].length) }
    : { headers: new Map(), body: raw };
}

function multipartChildren(body, boundary) {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const delimiter = new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, "g");
  const children = [];
  let start = null;
  for (const match of body.matchAll(delimiter)) {
    if (start !== null) children.push(body.slice(start, match.index));
    if (match[1]) return children;
    start = match.index + match[0].length;
  }
  if (start !== null) children.push(body.slice(start));
  return children;
}

export function normaliseContentId(value = "") {
  const bare = value.trim().replace(/^cid:/i, "").replace(/^<|>$/g, "");
  try {
    return decodeURIComponent(bare).toLowerCase();
  } catch {
    return bare.toLowerCase();
  }
}

const allowedImageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

function readParts(entity, result, depth = 0) {
  if (depth > 50) throw new Error("This email is nested too deeply to read.");
  const { headers, body } = entity;
  const { name, parameters } = contentType(headers.get("content-type"));
  if (name?.startsWith("multipart/") && parameters.boundary) {
    for (const part of multipartChildren(body, parameters.boundary)) readParts(readEntity(part), result, depth + 1);
    return;
  }

  const id = normaliseContentId(headers.get("content-id"));
  const disposition = contentType(headers.get("content-disposition")).name;
  const textBody = disposition !== "attachment" && (name === "text/html" || name === "text/plain");
  const inlineImage = id && allowedImageTypes.has(name);
  if (!textBody && !inlineImage) return;

  const bytes = readBody(body, headers.get("content-transfer-encoding"));
  if (textBody) {
    const text = decodeText(bytes, parameters.charset);
    if (name === "text/html") result.html ||= text;
    else result.text ||= text;
  } else if (!result.images.has(id)) {
    result.images.set(id, { type: name, bytes });
  }
}

export function parseEmail(bytes) {
  // Use an identity byte-to-character mapping while splitting MIME parts.
  let raw = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    raw += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }

  const entity = readEntity(raw.replace(/^\xef\xbb\xbf/, ""));
  if (!entity.headers.size) throw new Error("This file doesn’t look like an email. Choose a SharePoint .eml file.");
  const encodedSubject = entity.headers.get("subject") ?? "";
  const headerBytes = Uint8Array.from(encodedSubject, (character) => character.charCodeAt(0));
  const utf8Subject = decodeText(headerBytes, "utf-8");
  const subject = decodeHeader(utf8Subject.includes("�") ? decodeText(headerBytes, "windows-1252") : utf8Subject);
  const result = { subject, html: "", text: "", images: new Map() };
  try {
    readParts(entity, result);
  } catch (error) {
    if (error.name === "InvalidCharacterError") throw new Error("Part of this email uses damaged MIME encoding.");
    throw error;
  }
  return result;
}

function base64Lines(bytes) {
  return (toBase64(bytes).match(/.{1,76}/g) || []).join(crlf);
}

function subjectHeader(value) {
  // Encode scalar values in independent words to avoid splitting UTF-8 bytes.
  const words = [];
  let chunk = "";
  let length = 0;
  for (const character of value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()) {
    const size = utf8.encode(character).length;
    if (length + size > 39) {
      words.push(chunk);
      chunk = "";
      length = 0;
    }
    chunk += character;
    length += size;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${toBase64(utf8.encode(word))}?=`).join(crlf + " ");
}

function emailPart(type, bytes, extra = []) {
  return [
    `Content-Type: ${type}`,
    "Content-Transfer-Encoding: base64",
    ...extra,
    "",
    base64Lines(bytes),
  ].join(crlf);
}

export function serializeEmail({ subject, recipient, html, text, images }, date = new Date()) {
  const id = crypto.randomUUID();
  const alternative = "alt-" + id;
  const related = "rel-" + id;
  const hasImages = images.length > 0;
  const boundary = (name, closing = false) => "--" + name + (closing ? "--" : "");
  const lines = [
    `Date: ${date.toUTCString().replace(/GMT$/, "+0000")}`,
    `Subject: ${subjectHeader(subject)}`,
    "MIME-Version: 1.0",
  ];
  if (recipient) lines.push("To: " + recipient);
  // Render as a draft when imported by clients that honour this header.
  lines.push("X-Unsent: 1");
  if (hasImages) {
    lines.push(`Content-Type: multipart/related; type="multipart/alternative"; boundary="${related}"`, "", boundary(related));
  }
  lines.push(
    `Content-Type: multipart/alternative; boundary="${alternative}"`,
    "",
    boundary(alternative),
    emailPart("text/plain; charset=UTF-8", utf8.encode(text.replace(/\r?\n/g, crlf))),
    boundary(alternative),
    emailPart("text/html; charset=UTF-8", utf8.encode(html.replace(/\r?\n/g, crlf))),
    boundary(alternative, true),
  );

  if (hasImages) {
    for (const { id: imageId, type, bytes } of images) {
      lines.push(boundary(related), emailPart(type, bytes, [`Content-ID: <${imageId}>`, "Content-Disposition: inline"]));
    }
    lines.push(boundary(related, true));
  }
  return lines.concat("").join(crlf);
}

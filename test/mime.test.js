// Small byte-level fixtures cover MIME formats used by exported Outlook mail.

import assert from "node:assert/strict";
import test from "node:test";
import { parseEmail } from "../dist/core/mime.js";

test("decodes a sliced MIME message with Windows-1252 text and a folded inline image", () => {
  const image = Uint8Array.of(0, 128, 160, 255);
  const encoded = Buffer.from(image).toString("base64");
  const body = [
    "Subject: Staff News \x96 November",
    'Content-Type: multipart/related; boundary="digest"',
    "",
    "--digest",
    "Content-Type: text/plain; charset=windows-1252",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Price =A35 =",
    "with an invalid escape =GG",
    "--digest",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <Logo@example.org>",
    "",
    encoded.slice(0, 4),
    " " + encoded.slice(4),
    "--digest--",
  ].join("\r\n");
  const prefix = Buffer.from("outside message");
  const message = Buffer.from("\xef\xbb\xbf" + body, "latin1");
  const enclosing = Buffer.concat([prefix, message, Buffer.from("outside message")]);
  const bytes = new Uint8Array(
    enclosing.buffer,
    enclosing.byteOffset + prefix.length,
    message.length,
  );

  const email = parseEmail(bytes);
  assert.equal(email.subject, "Staff News – November");
  assert.equal(email.text, "Price £5 with an invalid escape =GG");
  assert.deepEqual(email.images.get("logo@example.org"), { type: "image/png", bytes: image });
});

test("reports the same readable error for malformed base64 bodies", () => {
  const message = Buffer.from(
    "Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\nZg==!",
  );
  assert.throws(() => parseEmail(message), /Part of this email uses damaged MIME encoding/);
});

// One mailbox format is shared by SMTP, the admin forms and MIME headers.

const emailAddress =
  /^[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i;

// The formatter, SMTP listener and admin forms use an address without its display name.
export function normaliseAddress(value) {
  if (typeof value !== "string") return "";
  const address = value.trim();
  return address.length <= 254 && emailAddress.test(address) ? address : "";
}

// A From header can carry a display name. Extract the address inside angle brackets when present.
export function mailboxFromHeader(value) {
  if (!value) return "";
  // Accept a single name-addr, including a quoted display name with commas.
  const named = /^(?:[^<>,"]|"(?:[^"\\]|\\.)*")*<([^<>]+)>(?:\s*\([^()]*\))*\s*$/.exec(value);
  return normaliseAddress(named?.[1] ?? value);
}

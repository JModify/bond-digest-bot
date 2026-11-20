const emailAddress = /^[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i;

// Both the editor and MIME export use a single mailbox without a display name.
export function normaliseAddress(value) {
  if (typeof value !== "string") return "";
  const address = value.trim();
  return address.length <= 254 && emailAddress.test(address) ? address : "";
}

export function mailboxFromHeader(value) {
  if (!value) return "";
  // Accept a single name-addr, including a quoted display name with commas.
  const named = /^(?:[^<>,"]|"(?:[^"\\]|\\.)*")*<([^<>]+)>(?:\s*\([^()]*\))*\s*$/.exec(value);
  return normaliseAddress(named?.[1] ?? value);
}

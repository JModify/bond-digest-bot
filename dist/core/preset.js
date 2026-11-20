export const DEFAULT_PRESET = Object.freeze({
  subject: "Bond Staff News | DAY_OF_WEEK DATE_DAY DATE_MONTH DATE_YEAR",
  recipient: "",
});

const brisbaneDate = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Brisbane",
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const dateTokens = {
  DAY_OF_WEEK: "weekday",
  DATE_DAY: "day",
  DATE_MONTH: "month",
  DATE_YEAR: "year",
};

export function normalisePreset(input) {
  const subject = typeof input?.subject === "string"
    ? input.subject.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
    : "";
  const recipient = typeof input?.recipient === "string" ? input.recipient.trim() : "";
  return {
    subject: subject || DEFAULT_PRESET.subject,
    recipient: validRecipient(recipient) ? recipient : "",
  };
}

export function formatSubject(template, date) {
  const parts = Object.fromEntries(brisbaneDate.formatToParts(date).map(({ type, value }) => [type, value]));
  return template.replace(/\b(DAY_OF_WEEK|DATE_DAY|DATE_MONTH|DATE_YEAR)\b/g, (token) => parts[dateTokens[token]]);
}

export function validRecipient(value) {
  const email = value.trim();
  if (!email) return true;
  return email.length <= 254 &&
    /^[a-z\d.!#$%&'*+/=?^_{|}~-]+@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i.test(email);
}

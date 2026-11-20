import { normaliseAddress } from "./mailbox.js";

export const DEFAULT_PRESET = Object.freeze({
  subject: "Bond Staff News | DAY_OF_WEEK DATE_DAY DATE_MONTH DATE_YEAR",
  from: "bondstaffnews@bond.edu.au",
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
  return {
    subject: subject || DEFAULT_PRESET.subject,
    from: normaliseAddress(input?.from) || DEFAULT_PRESET.from,
    recipient: normaliseAddress(input?.recipient),
  };
}

export function formatSubject(template, date) {
  const parts = Object.fromEntries(brisbaneDate.formatToParts(date).map(({ type, value }) => [type, value]));
  return template.replace(/\b(DAY_OF_WEEK|DATE_DAY|DATE_MONTH|DATE_YEAR)\b/g, (token) => parts[dateTokens[token]]);
}

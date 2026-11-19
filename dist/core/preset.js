export const LAYOUTS = Object.freeze({
  rows: "Feature rows",
  cards: "Stacked cards",
  compact: "Compact list",
});

export const PALETTES = Object.freeze({
  cobalt: { headerColor: "#153657", accentColor: "#2866A6", backgroundColor: "#EEF3F8" },
  ocean: { headerColor: "#124967", accentColor: "#087A94", backgroundColor: "#EDF6F8" },
  forest: { headerColor: "#18483D", accentColor: "#27745C", backgroundColor: "#EDF5F0" },
  plum: { headerColor: "#472F67", accentColor: "#7644AA", backgroundColor: "#F2EDF8" },
});

export const DEFAULT_PRESET = Object.freeze({
  layout: "rows",
  font: "sans",
  ...PALETTES.cobalt,
  subject: "",
  title: "",
  label: "NEWS DIGEST",
  intro: "",
  footer: "",
  linkLabel: "Read article",
  recipient: "",
  showImages: true,
  showSummary: true,
  showAuthor: true,
  showDate: true,
  showViews: false,
  showOriginalIntro: false,
  showSiteLink: true,
  showNotice: true,
});

export function normalisePreset(input = {}) {
  const preset = { ...DEFAULT_PRESET };
  for (const key of Object.keys(preset)) {
    if (typeof input[key] === typeof preset[key]) preset[key] = input[key];
  }
  if (!Object.hasOwn(LAYOUTS, preset.layout)) preset.layout = DEFAULT_PRESET.layout;
  if (!["sans", "serif"].includes(preset.font)) preset.font = DEFAULT_PRESET.font;
  for (const key of ["headerColor", "accentColor", "backgroundColor"]) {
    if (!/^#[a-f\d]{6}$/i.test(preset[key])) preset[key] = DEFAULT_PRESET[key];
  }
  if (!validRecipient(preset.recipient)) preset.recipient = "";
  return preset;
}

export function validRecipient(value) {
  const email = value.trim();
  if (!email) return true;
  return email.length <= 254 &&
    /^[a-z\d.!#$%&'*+/=?^_{|}~-]+@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i.test(email);
}

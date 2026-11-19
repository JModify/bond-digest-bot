import { formatDigest, readDigest } from "./core/digest.js";
import { DEFAULT_PRESET, LAYOUTS, PALETTES, normalisePreset, validRecipient } from "./core/preset.js";
import { renderDigest } from "./core/render.js";

const STORAGE_KEY = "digest-bot.preset";
const SETTINGS_VERSION = 1;
const byId = (id) => document.getElementById(id);
const workspace = byId("workspace-view");
const editor = byId("editor-view");
const form = byId("editor-form");
const recipientField = form.elements.namedItem("recipient");
const preview = byId("preview-panel");
const previewFrame = byId("email-preview");
const fileInput = byId("file-input");
const dropZone = byId("drop-zone");
const download = byId("download");
const layoutControls = Array.from(form.querySelectorAll("[name=layout]"));
const palettes = Array.from(form.querySelectorAll("[data-palette]"));
const defaultKey = JSON.stringify(DEFAULT_PRESET);

const sample = {
  title: "Service Desk news",
  subject: "Service Desk news",
  intro: "Updates and reminders for the week ahead.",
  siteUrl: "https://www.sharepoint.com/",
  notice: "",
  articles: [
    {
      title: "New study spaces open Monday",
      href: "https://example.com/news/study-spaces",
      summary: "Book a quiet desk or group study room in the newly opened North Wing.",
      author: "Campus Services",
      date: "16 November 2026",
      views: "48 views",
      image: null,
    },
    {
      title: "Wi-Fi maintenance this Friday",
      href: "https://example.com/news/wi-fi-maintenance",
      summary: "A scheduled upgrade may briefly interrupt campus Wi-Fi between 6 and 7 pm.",
      author: "IT Services",
      date: "17 November 2026",
      views: "31 views",
      image: null,
    },
  ],
};

let preset = loadPreset();
let draft = { ...preset };
let source = null;
let screen = "";
let loading = false;
let fileRequest = 0;
let previewTimer = 0;
let toastTimer = 0;

function loadPreset() {
  try {
    const record = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (record?.version === SETTINGS_VERSION) return normalisePreset(record.preset);
  } catch {
    // Browser storage can be unavailable or contain a broken record.
  }
  return { ...DEFAULT_PRESET };
}

function announce(message) {
  const toast = byId("toast");
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4600);
}

function syncPresetDetail() {
  const name = JSON.stringify(preset) === defaultKey ? "Default preset" : "Saved preset";
  byId("preset-detail").textContent = name + " · " + LAYOUTS[preset.layout];
}

function syncFileDetail() {
  byId("drop-empty").hidden = Boolean(source);
  byId("file-detail").hidden = !source;
  byId("file-loading").hidden = !loading;
  dropZone.setAttribute("aria-busy", String(loading));
  download.disabled = loading || !source;
  if (source) {
    const count = source.digest.articles.length;
    byId("file-name").textContent = source.name;
    byId("file-meta").textContent = count + (count === 1 ? " article" : " articles");
  }
  byId("download-detail").textContent = source ? "Your formatted digest is ready." : "Add a source email to enable download.";
}

function renderPreview() {
  clearTimeout(previewTimer);
  const model = source?.digest || sample;
  const rendered = renderDigest(model, screen === "editor" ? draft : preset, { preview: true });
  byId("preview-source").textContent = source ? "Uploaded email" : "Sample email";
  byId("preview-caption").textContent = screen === "editor" ? "Updates as you edit" : "Previewing the saved preset";
  byId("preview-subject").textContent = rendered.subject;
  byId("preview-recipient-row").hidden = !rendered.recipient;
  byId("preview-recipient").textContent = rendered.recipient;
  previewFrame.srcdoc = rendered.html;
}

function openScreen(next, scroll) {
  if (next === screen) return;
  screen = next;
  const editing = next === "editor";
  workspace.hidden = editing;
  editor.hidden = !editing;
  const slot = byId(editing ? "editor-preview" : "workspace-preview");
  if (preview.parentElement !== slot) slot.append(preview);
  for (const link of document.querySelectorAll("[data-tab]")) {
    if (link.dataset.tab === next) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  renderPreview();
  if (scroll) window.scrollTo(0, 0);
}

function syncEditor() {
  for (const indicator of form.querySelectorAll("[data-colour]")) {
    indicator.textContent = draft[indicator.dataset.colour].toUpperCase();
  }
  for (const button of palettes) {
    const matches = Object.entries(PALETTES[button.dataset.palette]).every(
      ([key, value]) => value.toLowerCase() === draft[key].toLowerCase(),
    );
    button.setAttribute("aria-pressed", String(matches));
  }
  byId("draft-status").textContent = JSON.stringify(draft) === JSON.stringify(preset) ? "" : "Unsaved changes";
}

function writeForm(values) {
  draft = { ...values };
  for (const [key, value] of Object.entries(values)) {
    if (key === "layout") {
      for (const control of layoutControls) control.checked = control.value === value;
      continue;
    }
    const control = form.elements.namedItem(key);
    if (typeof value === "boolean") control.checked = value;
    else control.value = value;
  }
  recipientField.setCustomValidity("");
  syncEditor();
}

function readForm() {
  const values = {};
  for (const [key, value] of Object.entries(DEFAULT_PRESET)) {
    const control = form.elements.namedItem(key);
    values[key] = typeof value === "boolean" ? control.checked : control.value;
  }
  for (const key of ["headerColor", "accentColor", "backgroundColor"]) values[key] = values[key].toUpperCase();
  return values;
}

function changeForm() {
  draft = readForm();
  recipientField.setCustomValidity("");
  syncEditor();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
}

function savePreset(event) {
  event.preventDefault();
  if (!validRecipient(recipientField.value)) {
    recipientField.setCustomValidity("Enter one email address, such as name@example.com.");
    recipientField.reportValidity();
    return;
  }
  preset = normalisePreset(readForm());
  preset.recipient = preset.recipient.trim();
  writeForm(preset);
  syncPresetDetail();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: SETTINGS_VERSION, preset }));
    announce("Preset saved.");
  } catch {
    announce("Preset saved for this session. Browser storage is unavailable.");
  }
  location.hash = "workspace";
}

function showFileError(message) {
  const error = byId("file-error");
  error.textContent = message;
  error.hidden = !message;
}

async function acceptFile(file) {
  const request = ++fileRequest;
  showFileError("");
  if (!/\.eml$/i.test(file.name)) {
    loading = false;
    syncFileDetail();
    showFileError("Choose a SharePoint digest with the .eml file extension.");
    return;
  }

  loading = true;
  syncFileDetail();
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    if (request !== fileRequest) return;
    const digest = readDigest(data, document);
    source = { name: file.name, digest };
    renderPreview();
  } catch (error) {
    if (request === fileRequest) showFileError(error.message || "This email couldn’t be read.");
  } finally {
    if (request === fileRequest) {
      loading = false;
      syncFileDetail();
    }
  }
}

function removeFile() {
  fileRequest += 1;
  source = null;
  loading = false;
  showFileError("");
  syncFileDetail();
  renderPreview();
  byId("choose-file").focus();
}

function fileDrop(event) {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  const files = event.dataTransfer.files;
  if (files.length === 1) acceptFile(files[0]);
  else if (files.length > 1) showFileError("Drop one .eml file at a time.");
}

function downloadEmail() {
  if (!source || loading) return;
  try {
    const content = formatDigest(source.digest, preset);
    const blob = new Blob([content], { type: "message/rfc822" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = source.name.replace(/\.eml$/i, "") + "-formatted.eml";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    announce("The formatted email couldn’t be downloaded. Try again.");
  }
}

async function loadSampleImages() {
  const files = ["sample-study.webp", "sample-wifi.webp"];
  await Promise.allSettled(files.map(async (file, index) => {
    const response = await fetch(new URL(file, import.meta.url));
    if (!response.ok) return;
    const bytes = new Uint8Array(await response.arrayBuffer());
    sample.articles[index].image = { kind: "inline", id: file, type: "image/webp", bytes };
  }));
  if (!source) renderPreview();
}

for (const id of ["choose-file", "replace-file"]) {
  byId(id).addEventListener("click", () => fileInput.click());
}
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (file) acceptFile(file);
});
byId("remove-file").addEventListener("click", removeFile);
dropZone.addEventListener("dragover", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  dropZone.classList.add("is-dragging");
});
dropZone.addEventListener("dragleave", (event) => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("is-dragging");
});
dropZone.addEventListener("drop", fileDrop);
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (event) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
}
download.addEventListener("click", downloadEmail);

for (const button of palettes) {
  button.addEventListener("click", () => {
    writeForm({ ...readForm(), ...PALETTES[button.dataset.palette] });
    renderPreview();
  });
}
form.addEventListener("input", changeForm);
form.addEventListener("submit", savePreset);
byId("reset-preset").addEventListener("click", () => {
  writeForm(DEFAULT_PRESET);
  renderPreview();
});
window.addEventListener("hashchange", () => {
  if (!location.hash || location.hash === "#workspace") openScreen("workspace", true);
  if (location.hash === "#editor") openScreen("editor", true);
});

writeForm(preset);
syncPresetDetail();
syncFileDetail();
openScreen(location.hash === "#editor" ? "editor" : "workspace", false);
loadSampleImages();

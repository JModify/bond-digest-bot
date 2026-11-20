import { formatDigest, readDigest } from "./core/digest.js";
import { normaliseAddress } from "./core/mailbox.js";
import { DEFAULT_PRESET, normalisePreset } from "./core/preset.js";
import { renderDigest } from "./core/render.js";

const STORAGE_KEY = "digest-bot.preset";
const SETTINGS_VERSION = 1;
const byId = (id) => document.getElementById(id);
const workspaceIntro = byId("workspace-intro");
const workspaceControls = byId("workspace-controls");
const editorIntro = byId("editor-intro");
const grid = byId("work-grid");
const form = byId("editor-form");
const subjectField = form.elements.namedItem("subject");
const fromField = form.elements.namedItem("from");
const recipientField = form.elements.namedItem("recipient");
const previewFrame = byId("email-preview");
const fileInput = byId("file-input");
const dropZone = byId("drop-zone");
const downloadMessage = byId("download");
const downloadDraft = byId("download-draft");

const example = {
  articles: [
    {
      title: "Example campus update",
      href: "https://example.com/news/example-campus-update",
      summary: "A short summary of a fictional campus announcement appears here.",
      author: "Example author",
      date: "19/11/2026",
      views: "12 views",
      image: null,
    },
    {
      title: "Example service announcement",
      href: "https://example.com/news/example-service-announcement",
      summary: "This example shows how a second article and its image fit into the digest.",
      author: "Example author",
      date: "19/11/2026",
      views: "8 views",
      image: null,
    },
  ],
};

let preset = loadPreset();
let draft = { ...preset };
let source = null;
let logo = null;
let logoRequest;
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
  byId("preset-detail").textContent = preset.subject === DEFAULT_PRESET.subject
    ? "Default subject line"
    : "Custom subject line";
}

function syncFileDetail() {
  byId("drop-empty").hidden = Boolean(source);
  byId("file-detail").hidden = !source;
  byId("file-loading").hidden = !loading;
  dropZone.setAttribute("aria-busy", String(loading));
  downloadMessage.disabled = loading || !source;
  downloadDraft.disabled = downloadMessage.disabled;
  if (source) {
    const count = source.digest.articles.length;
    byId("file-name").textContent = source.name;
    byId("file-meta").textContent = count + (count === 1 ? " article" : " articles");
  }
  byId("download-detail").textContent = source ? "Your formatted digest is ready." : "Add a source email to enable download.";
}

function renderPreview(date = new Date()) {
  clearTimeout(previewTimer);
  const model = source?.digest || example;
  const rendered = renderDigest(model, screen === "editor" ? draft : preset, { date, logo, preview: true });
  byId("preview-source").textContent = source ? "Uploaded email" : "Example articles";
  byId("preview-caption").textContent = screen === "editor" ? "Updates as you edit" : "Previewing the saved preset";
  byId("preview-subject").textContent = rendered.subject;
  byId("preview-from").textContent = rendered.from;
  byId("preview-recipient-row").hidden = !rendered.recipient;
  byId("preview-recipient").textContent = rendered.recipient;
  if (previewFrame.srcdoc !== rendered.html) previewFrame.srcdoc = rendered.html;
}

function openScreen(next, scroll) {
  if (next === screen) return;
  screen = next;
  const editing = next === "editor";
  workspaceIntro.hidden = editing;
  workspaceControls.hidden = editing;
  editorIntro.hidden = !editing;
  form.hidden = !editing;
  grid.classList.toggle("editor-grid", editing);
  // Keep the preview mounted while switching screens so its document and scroll position survive.
  for (const link of document.querySelectorAll("[data-tab]")) {
    if (link.dataset.tab === next) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  renderPreview();
  if (scroll) window.scrollTo(0, 0);
}

function syncEditor() {
  const dirty = Object.keys(DEFAULT_PRESET).some((key) => draft[key] !== preset[key]);
  byId("draft-status").textContent = dirty ? "Unsaved changes" : "";
}

function syncRecipientField() {
  recipientField.value = draft.recipient || source?.digest.suggestedRecipient || "";
}

function clearAddressErrors() {
  fromField.setCustomValidity("");
  recipientField.setCustomValidity("");
}

function writeForm(values) {
  draft = { ...values };
  subjectField.value = draft.subject;
  fromField.value = draft.from;
  syncRecipientField();
  clearAddressErrors();
  syncEditor();
}

function readForm() {
  const entered = recipientField.value.trim();
  const inferred = source?.digest.suggestedRecipient || "";
  // Persist manual overrides only. Each upload has its own inferred recipient.
  return {
    subject: subjectField.value,
    from: fromField.value.trim(),
    recipient: entered === inferred ? "" : entered,
  };
}

function changeForm() {
  draft = readForm();
  clearAddressErrors();
  syncEditor();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 120);
}

function savePreset(event) {
  event.preventDefault();
  for (const field of [fromField, recipientField]) {
    if (field.value.trim() && !normaliseAddress(field.value)) {
      field.setCustomValidity("Enter one email address, such as name@example.com.");
      field.reportValidity();
      return;
    }
  }
  preset = normalisePreset(readForm());
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
    syncRecipientField();
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
  syncRecipientField();
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

async function downloadEmail(editable) {
  if (!source || loading) return;
  const selected = source;
  const savedPreset = preset;
  try {
    const brandImage = await loadLogo();
    if (source !== selected) return;
    const date = new Date();
    const content = formatDigest(selected.digest, savedPreset, date, brandImage, { editable });
    renderPreview(date);
    const blob = new Blob([content], { type: "message/rfc822" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = selected.name.replace(/\.eml$/i, "") + (editable ? "-draft.eml" : "-formatted.eml");
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    announce("The formatted email couldn’t be downloaded. Try again.");
  }
}

async function loadImage(path, type) {
  const response = await fetch(new URL(path, import.meta.url));
  if (!response.ok) throw new Error("Couldn’t load a digest image.");
  return { kind: "inline", type, bytes: new Uint8Array(await response.arrayBuffer()) };
}

function loadLogo() {
  if (!logoRequest) {
    logoRequest = loadImage("assets/bond-logo.png", "image/png").then((image) => {
      logo = image;
      renderPreview();
      return image;
    }).catch((error) => {
      logoRequest = null;
      throw error;
    });
  }
  return logoRequest;
}

async function loadExampleImages() {
  const files = ["sample-study.webp", "sample-wifi.webp"];
  await Promise.allSettled(files.map(async (file, index) => {
    example.articles[index].image = await loadImage(file, "image/webp");
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
downloadMessage.addEventListener("click", () => downloadEmail(false));
downloadDraft.addEventListener("click", () => downloadEmail(true));

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
// Keep the preview usable and retry the asset when downloading if this initial request fails.
loadLogo().catch(() => {});
loadExampleImages();

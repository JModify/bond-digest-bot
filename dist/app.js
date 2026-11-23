import { formatDigest, readDigest } from "./core/digest.js";
import { DEFAULT_PRESET } from "./core/preset.js";
import { renderDigest } from "./core/render.js";

const byId = (id) => document.getElementById(id);
const fileInput = byId("file-input");
const chooseFile = byId("choose-file");
const dropZone = byId("drop-zone");
const fileStatus = byId("file-status");
const fileError = byId("file-error");
const preview = byId("preview");
const previewFrame = byId("email-preview");
const download = byId("download");
const emailType = "message/rfc822";

let requestId = 0;
let logoRequest;

function showError(message = "") {
  fileError.hidden = !message;
  fileError.textContent = message;
}

function setLoading(loading) {
  dropZone.setAttribute("aria-busy", String(loading));
  fileStatus.classList.toggle("visually-hidden", !loading);
  fileStatus.textContent = loading ? "Formatting email…" : "";
}

function showFile(file, articleCount) {
  const selected = Boolean(file);
  dropZone.classList.toggle("has-file", selected);
  byId("drop-icon").className = "icon " + (selected ? "icon-mail" : "icon-upload");
  byId("drop-title").textContent = file?.name || "Drop your .eml file here";
  byId("file-meta").hidden = !selected;
  byId("file-meta").textContent = selected ? `${articleCount} ${articleCount === 1 ? "article" : "articles"}` : "";
  byId("choose-label").textContent = selected ? "Replace" : "Choose file";
  byId("remove-file").hidden = !selected;
  byId("save-help").hidden = selected;
  byId("result").hidden = !selected;
  preview.hidden = !selected;
}

function resetResult() {
  if (download.href) URL.revokeObjectURL(download.href);
  download.removeAttribute("href");
  download.removeAttribute("download");
  previewFrame.removeAttribute("srcdoc");
  preview.open = false;
  showFile(null);
}

function loadLogo() {
  logoRequest ??= fetch(new URL("assets/bond-logo.png", import.meta.url)).then(async (response) => {
    if (!response.ok) throw new Error("Couldn’t load the Staff News logo. Try again.");
    return { kind: "inline", type: "image/png", bytes: new Uint8Array(await response.arrayBuffer()) };
  }).catch((error) => {
    logoRequest = undefined;
    throw error;
  });
  return logoRequest;
}

async function formatFile(file) {
  const currentRequest = ++requestId;
  resetResult();
  showError();
  setLoading(true);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (currentRequest !== requestId) return;
    const digest = readDigest(bytes, document, { inferRecipient: false });
    const logo = await loadLogo();
    if (currentRequest !== requestId) return;

    const date = new Date();
    const formatted = renderDigest(digest, DEFAULT_PRESET, { date, logo, preview: true });
    const eml = formatDigest(digest, DEFAULT_PRESET, date, logo);
    download.download = formatted.subject.replace(" | ", " - ") + ".eml";
    download.href = URL.createObjectURL(new Blob([eml], { type: emailType }));
    byId("preview-subject").textContent = formatted.subject;
    byId("preview-from").textContent = formatted.from;
    previewFrame.srcdoc = formatted.html;
    showFile(file, digest.articles.length);
  } catch (error) {
    if (currentRequest === requestId) showError(error.message || "This email couldn’t be formatted.");
  } finally {
    if (currentRequest === requestId) {
      setLoading(false);
      if (download.hasAttribute("href")) fileStatus.textContent = "The formatted email is ready to download.";
    }
  }
}

function acceptFiles(files) {
  if (files.length === 1) {
    const file = files[0];
    if (/\.eml$/i.test(file.name) || file.type === emailType) {
      formatFile(file);
      return;
    }
  }
  requestId += 1;
  setLoading(false);
  showError(files.length > 1
    ? "Choose one .eml file at a time."
    : "Choose a SharePoint digest saved as an .eml file. In new Outlook, use More actions → Save as first.");
}

chooseFile.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) acceptFiles(fileInput.files);
  fileInput.value = "";
});
byId("remove-file").addEventListener("click", () => {
  requestId += 1;
  resetResult();
  showError();
  setLoading(false);
  chooseFile.focus();
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  dropZone.classList.add("is-dragging");
});
dropZone.addEventListener("dragleave", (event) => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("is-dragging");
});
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  acceptFiles(event.dataTransfer.files);
});
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (event) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  });
}

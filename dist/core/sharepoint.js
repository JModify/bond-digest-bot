import { normaliseContentId } from "./mime.js";

const datePattern = /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}\s+[\p{L}.]+\s+\d{4}|[\p{L}.]+\s+\d{1,2},?\s+\d{4})(?:,?\s+\d{1,2}:\d{2}.*)?$/u;
const viewPattern = /^[\d.,\s]+\s+views?$/i;
const bylinePattern = /(?:author|byline)/i;
const siteLinkPattern = /^(?:go to (?:the )?site|view (?:the )?site|visit (?:the )?site)$/i;

function textOf(element) {
  return (element?.textContent || "").replace(/\s+/g, " ").trim();
}

export function httpUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function linkDestination(href) {
  const url = new URL(href);
  if (url.hostname.endsWith(".safelinks.protection.outlook.com")) {
    return httpUrl(url.searchParams.get("url")) || href;
  }
  return href;
}

function isNewsPage(target) {
  const { pathname } = new URL(target);
  return /\/(?:sitepages|pages)\/.+\.aspx(?:\/|$)/i.test(pathname);
}

function splitFields(element) {
  if (!element.matches("div, p, td, span, time, section, ul, ol, li")) return [];
  if (!textOf(element)) return [];
  const children = Array.from(element.children);
  const hasOwnText = Array.from(element.childNodes).some((child) => child.nodeType === 3 && child.textContent.trim());
  const grouped = children.length > 1 && !hasOwnText && children.every((child) => child.matches("div, p, time, li, span"));
  if (grouped) return children.flatMap(splitFields);
  return [{
    text: textOf(element),
    kind: element.matches("time") ? "date" :
      bylinePattern.test(element.className || "") ? "author" : "",
  }];
}

function articleFields(anchor) {
  const fields = [];
  const container = anchor.closest("td, article, [role=listitem]");
  for (let node = anchor; node && node !== container; node = node.parentElement) {
    if (!node.parentElement || node.parentElement.matches("body, html")) break;
    for (let sibling = node.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      fields.push(...splitFields(sibling));
    }
    if (!container && node.matches("h1, h2, h3, h4")) break;
  }
  return fields;
}

function readMetadata(fields) {
  const details = { summary: "", author: "", date: "", views: "" };
  const descriptionFields = [];
  for (const field of fields) {
    const { text, kind } = field;
    if (!details.date && (kind === "date" || datePattern.test(text))) details.date = text;
    else if (!details.views && viewPattern.test(text)) details.views = text;
    else if (!details.author && (kind === "author" || /^by\s+/i.test(text))) details.author = text.replace(/^by\s+/i, "");
    else descriptionFields.push(text);
  }
  if (!details.author && details.date && descriptionFields.length === 2) details.author = descriptionFields.pop();
  details.summary = descriptionFields.join("\n");
  return details;
}

function readThumbnail(anchor, title, inlineImages) {
  const row = anchor.closest("tr, article, [role=listitem]");
  const images = Array.from(row?.querySelectorAll("img") || []);
  const image = images.find((candidate) => candidate.alt.trim().toLowerCase() === title.toLowerCase()) ||
    images.find((candidate) => candidate.getAttribute("src") && candidate.width !== 1);
  const source = image?.getAttribute("src")?.trim();
  if (!source) return null;
  if (/^cid:/i.test(source)) {
    const id = normaliseContentId(source);
    const attachment = inlineImages.get(id);
    return attachment ? { kind: "inline", id, ...attachment } : null;
  }
  const url = httpUrl(source);
  return url ? { kind: "remote", url } : null;
}

function htmlArticles(root, inlineImages) {
  const candidates = [];
  const seen = new Set();
  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = httpUrl(anchor.getAttribute("href"));
    const title = textOf(anchor);
    if (!href || !title || siteLinkPattern.test(title)) continue;
    const destination = linkDestination(href);
    if (seen.has(destination)) continue;
    const fields = articleFields(anchor);
    const details = readMetadata(fields);
    const structuredRow = Boolean(anchor.closest("tr, article, [role=listitem]")) && Boolean(details.date || details.views);
    if (!isNewsPage(destination) && !structuredRow) continue;

    seen.add(destination);
    candidates.push({ anchor, article: { title, href, ...details, image: readThumbnail(anchor, title, inlineImages) } });
  }
  return candidates;
}

function digestHeader(root, firstAnchor, subject) {
  const newsCell = Array.from(root.querySelectorAll("td, th")).find(
    (cell) => /^news$/i.test(textOf(cell)) && (!firstAnchor || cell.compareDocumentPosition(firstAnchor) & 4),
  );
  const titleRow = newsCell?.closest("tr")?.nextElementSibling;
  const heading = Array.from(root.querySelectorAll("h1")).find(
    (item) => !firstAnchor || item.compareDocumentPosition(firstAnchor) & 4,
  );
  const quoted = subject.match(/\bshared\s+["“](.+?)["”]\s+with you/i)?.[1];
  return {
    title: textOf(titleRow) || textOf(heading) || quoted || subject || "News digest",
    intro: textOf(titleRow?.nextElementSibling),
  };
}

function readTextDigest(text) {
  const lines = text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  const articles = [];
  let index = 0;
  while (index < lines.length) {
    const title = /^\[([^\]]+)\]$/.exec(lines[index])?.[1];
    const href = httpUrl(lines[index + 1]?.replace(/^<|>$/g, ""));
    if (!title || !href || !isNewsPage(linkDestination(href))) {
      index += 1;
      continue;
    }

    const fields = [];
    index += 2;
    while (index < lines.length && !/^(?:\[|<|https?:\/\/|_{3,}|This email is generated through)/i.test(lines[index])) {
      fields.push({ text: lines[index++] });
    }
    articles.push({ title, href, ...readMetadata(fields), image: null });
  }
  return articles;
}

export function extractSharePointDigest(email, document) {
  // A template's contents are inert. Only selected text, URLs and MIME image
  // bytes are passed to the renderer. The uploaded markup is never displayed.
  const template = document.createElement("template");
  template.innerHTML = email.html;
  const root = template.content;
  const candidates = htmlArticles(root, email.images);
  const articles = candidates.length ? candidates.map(({ article }) => article) : readTextDigest(email.text);
  if (articles.length === 0) {
    throw new Error("No SharePoint news articles were found. Export an email created with ‘Email a news digest’ and try again.");
  }

  const header = digestHeader(root, candidates[0]?.anchor, email.subject);
  const siteLink = Array.from(root.querySelectorAll("a[href]")).find((anchor) => siteLinkPattern.test(textOf(anchor)));
  const notice = Array.from(root.querySelectorAll("p")).map(textOf).find((line) =>
    /^(?:this (?:e-?mail|message) is generated through|this (?:e-?mail|message) was generated by)/i.test(line),
  ) || email.text.split(/\r?\n/).map((line) => line.trim()).find((line) =>
    /^this (?:e-?mail|message) is generated through/i.test(line),
  );
  return {
    ...header,
    subject: email.subject || header.title,
    articles,
    siteUrl: httpUrl(siteLink?.getAttribute("href")),
    notice: notice || "",
  };
}

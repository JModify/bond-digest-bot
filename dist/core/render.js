import { toBase64 } from "./mime.js";
import { formatSubject, normalisePreset } from "./preset.js";

const title = "Staff News";
const introduction = "See the latest Showcase News items";
const footer = "View all news and upcoming events";
const defaultSiteUrl = "https://bonduni.sharepoint.com/sites/News";
const font = "'Segoe UI',Tahoma,Arial,sans-serif";
const imageCache = new WeakMap();
const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text) => String(text).replace(/[&<>"']/g, (character) => entities[character]);

function imageSource(image, context, label = "article") {
  if (!image) return "";
  if (image.kind === "remote") return context.preview ? "" : image.url;
  const { bytes, type } = image;
  if (context.preview) {
    if (!imageCache.has(bytes)) imageCache.set(bytes, `data:${type};base64,${toBase64(bytes)}`);
    return imageCache.get(bytes);
  }
  if (!context.attachments.has(bytes)) {
    const id = `${label}-${context.attachments.size + 1}@digest-bot.local`;
    context.attachments.set(bytes, { id, type, bytes });
  }
  return "cid:" + context.attachments.get(bytes).id;
}

function link(href, label, style, preview) {
  if (preview) return `<span style="${style}">${escape(label)}</span>`;
  return `<a href="${escape(href)}" style="${style}">${escape(label)}</a>`;
}

function renderLogo(logo, context) {
  const src = imageSource(logo, context, "bond-logo");
  return src
    ? `<img src="${escape(src)}" alt="Bond University" width="214" height="82" style="display:block;width:214px;max-width:100%;height:auto;margin:0 auto;border:0;">`
    : `<p style="margin:0;line-height:82px;font-weight:600;color:#153657;">Bond University</p>`;
}

function renderThumbnail(article, context) {
  if (!article.image) return "";
  const src = imageSource(article.image, context);
  return src
    ? `<img src="${escape(src)}" alt="${escape(article.title)}" width="210" style="display:block;width:210px;max-width:100%;height:auto;border:0;">`
    : `<div style="width:210px;max-width:100%;background:#eee;color:#666;text-align:center;font-size:11px;line-height:116px;">Remote image</div>`;
}

function renderArticle(article, context) {
  const articleTitle = link(article.href, article.title, "color:#333;text-decoration:none;", context.preview);
  const image = renderThumbnail(article, context);
  const summary = escape(article.summary ?? "").replace(/\r?\n/g, "<br>");
  const html = `
    <tr>
      ${image ? `<td class="article-image" width="220" valign="top" style="width:220px;padding:20px 0;">${image}</td>` : ""}
      <td class="article-copy${image ? " with-image" : ""}" ${image ? "" : 'colspan="2"'} valign="top" style="padding:20px 0 20px ${image ? "20px" : "0"};overflow-wrap:anywhere;">
        <h2 style="margin:0 0 10px;font-size:17px;line-height:20px;font-weight:400;">${articleTitle}</h2>
        ${summary ? `<p style="margin:0 0 12px;font-size:14px;line-height:1.4;color:#666;">${summary}</p>` : ""}
        ${article.author ? `<p style="margin:0 0 3px;font-size:12px;line-height:13.5px;color:#231f20;">${escape(article.author)}</p>` : ""}
        ${article.date ? `<p style="margin:0;font-size:11px;line-height:13.5px;color:#767676;">${escape(article.date)}</p>` : ""}
        ${article.views ? `<p style="margin:10px 0 0;font-size:10px;line-height:1.4;color:#a6a6a6;">${escape(article.views)}</p>` : ""}
      </td>
    </tr>`;
  const text = [article.title, article.href, article.summary, article.author, article.date, article.views]
    .filter(Boolean).join("\n");
  return { html, text };
}

const divider = '<tr><td colspan="2" style="border-top:1px solid #d6d6d6;font-size:0;line-height:1px;height:1px;">&nbsp;</td></tr>';

export function renderDigest(digest, input, { date = new Date(), logo, preview = false } = {}) {
  const preset = normalisePreset(input);
  const subject = formatSubject(preset.subject, date);
  const siteUrl = digest.siteUrl || defaultSiteUrl;
  const context = { preview, attachments: new Map() };
  const headerLogo = renderLogo(logo, context);
  const articles = digest.articles.map((article) => renderArticle(article, context));

  const html = `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${preview ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">` : ""}
<title>${preview ? "Formatted email" : escape(subject)}</title>
<style>
  @media only screen and (max-width: 460px) {
    .digest-outer { padding: 16px 10px !important; }
    .digest-articles { table-layout: auto !important; }
    .digest-articles colgroup { display: none !important; }
    .article-image, .article-copy { display: block !important; width: 100% !important; box-sizing: border-box; }
    .article-image { padding-bottom: 0 !important; }
    .article-copy.with-image { padding: 14px 0 20px !important; }
  }
</style>
</head>
<body style="margin:0;background-color:#fff;color:#222;font-family:${font};" dir="ltr">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fff;font-family:${font};">
    <tr><td align="center" class="digest-outer" style="padding:22px 0 0;">
      <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
        style="max-width:600px;border:1px solid #dedede;border-collapse:collapse;margin:0 auto;">
        <tr><td align="center" style="padding:20px 20px 36px;border-bottom:1px solid #c8c8c8;background-color:#fff;">
          ${headerLogo}
          <h1 style="margin:30px 0 10px;font-size:24px;line-height:32px;font-weight:600;color:#222;">${title}</h1>
          <p style="margin:0;font-size:17px;line-height:1.35;color:#95989a;">${introduction}</p>
        </td></tr>
        <tr><td style="padding:0 20px;background-color:#f8f8f8;">
          <table role="presentation" class="digest-articles" width="100%" cellpadding="0" cellspacing="0" border="0"
            style="table-layout:fixed;border-collapse:collapse;">
            <colgroup><col width="220" style="width:220px;"><col></colgroup>${articles.map((article) => article.html).join(divider)}</table>
        </td></tr>
        <tr><td align="center" style="padding:30px;border-top:1px solid #dedede;background-color:#fff;font-size:14px;line-height:1.4;">
          ${link(siteUrl, footer, "color:#0000ee;text-decoration:underline;", preview)}
        </td></tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    `${title}\n${introduction}`,
    ...articles.map((article) => article.text),
    `${footer}\n${siteUrl}`,
  ].join("\n\n");

  return {
    subject,
    from: preset.from,
    recipient: preset.recipient || digest.suggestedRecipient || "",
    html,
    text,
    images: Array.from(context.attachments.values()),
  };
}

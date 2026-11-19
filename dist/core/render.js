import { toBase64 } from "./mime.js";
import { normalisePreset } from "./preset.js";

const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text) => String(text).replace(/[&<>"']/g, (character) => entities[character]);
const paragraphs = (text) => escape(text).replace(/\r?\n/g, "<br>");
const imageCache = new WeakMap();
const ink = "#142340";
const muted = "#4F5F78";
const sans = "'Segoe UI',Arial,sans-serif";
const serif = "Georgia,'Times New Roman',serif";

function foreground(background) {
  const channels = background.slice(1).match(/../g).map((hex) => {
    const channel = Number.parseInt(hex, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance >= 0.179 ? "#000000" : "#FFFFFF";
}

function imageSource(image, context) {
  if (!image) return "";
  if (context.preview) {
    if (image.kind === "remote") return "";
    // The same attachment is reused when the editor updates the preview.
    if (!imageCache.has(image.bytes)) {
      imageCache.set(image.bytes, `data:${image.type};base64,${toBase64(image.bytes)}`);
    }
    return imageCache.get(image.bytes);
  }
  if (image.kind === "remote") return image.url;
  const { id, type, bytes } = image;
  if (!context.attachments.has(id)) {
    const newId = `article-${context.attachments.size + 1}@digest-bot.local`;
    context.attachments.set(id, { id: newId, type, bytes });
  }
  return "cid:" + context.attachments.get(id).id;
}

function link(href, label, style, preview) {
  const tag = preview ? "span" : "a";
  const attributes = preview ? "" : ` href="${escape(href)}"`;
  return `<${tag}${attributes} style="${style}">${escape(label)}</${tag}>`;
}

function imageMarkup(article, context, width, height, stacked) {
  const source = imageSource(article.image, context);
  if (!source && !article.image) return "";
  if (!source) {
    return `<div style="width:100%;height:${height}px;line-height:${height}px;background:#e8eef9;color:#4f5f78;font-size:11px;text-align:center;">Remote image</div>`;
  }
  const max = stacked ? "width:100%;max-width:552px;" : "width:100%;";
  return `<img src="${escape(source)}" alt="${escape(article.title)}" width="${width}" height="${height}"
    style="display:block;${max}height:${height}px;object-fit:cover;border:0;border-radius:7px;">`;
}

function renderArticle(article, context) {
  const { preset, preview } = context;
  const compact = preset.layout === "compact";
  const stacked = preset.layout === "cards";
  const hasImage = preset.showImages && Boolean(article.image);
  const density = compact ? 12 : 17;
  const heading = compact ? 16 : 19;
  const width = stacked ? 552 : compact ? 64 : 137;
  const height = stacked ? 188 : compact ? 56 : 105;
  const articleTitle = link(article.href, article.title, `color:${ink};text-decoration:none;`, preview);
  const metadata = [
    preset.showAuthor && article.author,
    preset.showDate && article.date,
    preset.showViews && article.views,
  ].filter(Boolean);
  const image = hasImage ? imageMarkup(article, context, width, height, stacked) : "";
  const html = `
    <tr><td style="padding:0 0 ${compact ? 8 : 12}px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fff;border:1px solid #DCE5F3;border-radius:10px;">
        ${image && stacked ? `<tr><td style="padding:${density}px ${density}px 0;">${image}</td></tr>` : ""}
        <tr>
          ${image && !stacked ? `<td class="article-image ${compact ? "compact-image" : ""}" width="${width}" valign="top" style="width:${width}px;padding:${density}px 0 ${density}px ${density}px;">${image}</td>` : ""}
          <td valign="top" style="padding:${density}px;">
            <h2 style="margin:0;font-size:${heading}px;line-height:1.27;font-weight:700;color:${ink};">${articleTitle}</h2>
            ${metadata.length ? `<p style="margin:6px 0 0;color:${muted};font-size:11px;line-height:1.5;">${escape(metadata.join(" · "))}</p>` : ""}
            ${preset.showSummary && article.summary ? `<p style="margin:7px 0 0;color:${ink};font-size:13px;line-height:1.55;">${paragraphs(article.summary)}</p>` : ""}
            ${preset.linkLabel.trim() ? `<p style="margin:8px 0 0;line-height:1.45;">${link(article.href, preset.linkLabel.trim(),
    `font-size:12px;font-weight:700;color:${context.linkColour};text-decoration:underline;`, preview)}</p>` : ""}
          </td>
        </tr>
      </table>
    </td></tr>`;
  const text = [
    article.title,
    metadata.join(" · "),
    preset.showSummary ? article.summary : "",
    (preset.linkLabel.trim() ? preset.linkLabel.trim() + " " : "") + article.href,
  ].filter(Boolean).join("\n");
  return { html, text };
}

export function renderDigest(digest, input, { preview = false } = {}) {
  const preset = normalisePreset(input);
  const subject = preset.subject.trim() || digest.subject || digest.title;
  const title = preset.title.trim() || digest.title;
  const intro = preset.intro.trim() || (preset.showOriginalIntro ? digest.intro : "");
  const siteUrl = preset.showSiteLink && digest.siteUrl;
  const notice = preset.showNotice && digest.notice;
  const footer = preset.footer.trim();
  const font = preset.font === "serif" ? serif : sans;
  const headerInk = foreground(preset.headerColor);
  const linkColour = foreground(preset.accentColor) === "#FFFFFF" ? preset.accentColor : "#193E85";
  const context = { preset, preview, linkColour, attachments: new Map() };
  const articles = digest.articles.map((article) => renderArticle(article, context));

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${preview ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">` : ""}
<title>${escape(subject)}</title>
<style>
  @media only screen and (max-width: 460px) {
    .outer { padding: 12px !important; }
    .digest-head { padding: 24px 18px !important; }
    .article-image:not(.compact-image) { width: 86px !important; }
    .article-image:not(.compact-image) img { height: 74px !important; }
  }
  @media only screen and (max-width: 350px) {
    .article-image:not(.compact-image) { display: block; width: auto !important; padding-bottom: 0 !important; }
    .article-image:not(.compact-image) img { max-width: 118px; }
    .article-image:not(.compact-image) + td { display: block; }
  }
</style>
</head>
<body style="margin:0;background-color:${preset.backgroundColor};color:${ink};font-family:${font};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${preset.backgroundColor};font-family:${font};">
    <tr><td class="outer" align="center" style="padding:18px;">
      <!--[if mso]><table role="presentation" width="600"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr><td class="digest-head" style="padding:25px 23px;background-color:${preset.headerColor};color:${headerInk};border-top:3px solid ${preset.accentColor};border-radius:10px;">
          ${preset.label.trim() ? `<p style="margin:0 0 7px;font-size:10px;font-weight:700;letter-spacing:2px;line-height:1.5;">${escape(preset.label.trim())}</p>` : ""}
          <h1 style="margin:0;color:${headerInk};font-size:29px;font-weight:700;line-height:1.18;">${escape(title)}</h1>
          ${intro ? `<p style="margin:10px 0 0;font-size:14px;line-height:1.5;">${paragraphs(intro)}</p>` : ""}
        </td></tr>
        <tr><td style="padding-top:13px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${articles.map((article) => article.html).join("")}</table>
        </td></tr>
        ${siteUrl || footer || notice ? `<tr><td align="center" style="padding:3px 18px 4px;color:${muted};font-size:11px;line-height:1.55;">
          ${siteUrl ? `<p style="margin:0 0 7px;">${link(siteUrl, "Visit SharePoint site", `font-size:12px;font-weight:700;color:${linkColour};text-decoration:underline;`, preview)}</p>` : ""}
          ${footer ? `<p style="margin:0 0 7px;">${paragraphs(footer)}</p>` : ""}
          ${notice ? `<p style="margin:0;">${escape(notice)}</p>` : ""}
        </td></tr>` : ""}
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
  const text = [
    [preset.label.trim(), title, intro].filter(Boolean).join("\n"),
    ...articles.map((article) => article.text),
    siteUrl ? "Visit SharePoint site " + siteUrl : "",
    footer,
    notice,
  ].filter(Boolean).join("\n\n");

  return { subject, recipient: preset.recipient.trim(), html, text, images: Array.from(context.attachments.values()) };
}

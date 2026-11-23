import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { normaliseAddress } from "../dist/core/mailbox.js";
import { normalisePreset } from "../dist/core/preset.js";
import { recipientAllowed } from "./config.js";

const statusKeyPattern = /^[0-9a-f]{48}$/;
const statusPath = /^\/api\/email\/requests\/([0-9a-f]{32})$/;
const staticPath = /^\/(?:(?:assets|core)\/)?[a-z0-9][a-z0-9-]*\.(html|css|js|png|webp)$/;
const contentTypes = {
  html: "text/html; charset=UTF-8",
  css: "text/css; charset=UTF-8",
  js: "text/javascript; charset=UTF-8",
  png: "image/png",
  webp: "image/webp",
};
const dist = new URL("../dist/", import.meta.url);
const jsonLimit = 8192;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function bodyJson(req) {
  if (Number(req.headers["content-length"]) > jsonLimit) return null;
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > jsonLimit) {
        req.resume();
        return null;
      }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export function createWebServer(config, store, log = console) {
  function showJob(job) {
    return { ...job, inbox: `digest-${job.id}@${config.inboxDomain}`, from: config.from };
  }

  async function route(req, res) {
    const path = new URL(req.url, config.origin).pathname;
    const isRead = req.method === "GET" || req.method === "HEAD";
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (path === "/healthz" && isRead) return json(res, 200, { ok: true });
    if (!config.emailDeliveryEnabled && (path === "/api/email" || path.startsWith("/api/email/"))) {
      return json(res, 404, { message: "Page not found." });
    }
    if (path === "/api/email" && isRead) return json(res, 200, { from: config.from });
    if (path === "/api/email/requests" && req.method === "POST") {
      if (req.headers.origin !== config.origin) return json(res, 403, { message: "Open Digest Bot at its configured address." });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
        return json(res, 415, { message: "Expected a JSON request." });
      }
      const input = await bodyJson(req);
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return json(res, 400, { message: "The request is missing or too large." });
      }
      const recipient = normaliseAddress(input.recipient).toLowerCase();
      if (!recipientAllowed(recipient, config)) {
        return json(res, 400, { message: "This return email address is outside the server’s allowlist." });
      }
      if (typeof input.subject === "string" && input.subject.length > 300) {
        return json(res, 400, { message: "The subject preset must be 300 characters or fewer." });
      }
      const { subject } = normalisePreset(input);
      const created = store.create({ recipient, subject });
      if (!created) return json(res, 429, { message: "Too many requests. Try again later." });
      return json(res, 201, { ...showJob(store.status(created.id, created.statusKey)), statusKey: created.statusKey });
    }

    const id = isRead && statusPath.exec(path)?.[1];
    if (id) {
      const key = req.headers["x-digest-status"];
      const job = typeof key === "string" && statusKeyPattern.test(key) && store.status(id, key);
      return job
        ? json(res, 200, showJob(job))
        : json(res, 404, { message: "This request has expired or is unavailable." });
    }
    const file = path === "/" ? "/index.html" : path;
    if (isRead && staticPath.test(file)) {
      try {
        const content = await readFile(new URL(file.slice(1), dist));
        const extension = file.split(".").at(-1);
        res.writeHead(200, { "Content-Type": contentTypes[extension], "Cache-Control": "no-cache" });
        return res.end(req.method === "HEAD" ? undefined : content);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return json(res, 404, { message: "Page not found." });
  }

  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (req, res) => {
    route(req, res).catch(() => {
      log.error("Digest Bot could not handle a web request");
      if (!res.headersSent) json(res, 500, { message: "Digest Bot is temporarily unavailable." });
      else res.destroy();
    });
  });
}

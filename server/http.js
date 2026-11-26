// Serves the public browser app, health check, group address and optional admin routes.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

// Serve known file types under dist, core and assets. This pattern excludes arbitrary paths and
// filenames.
const staticPath = /^\/(?:(?:assets|core)\/)?[a-z0-9][a-z0-9-]*\.(html|css|js|png|webp)$/;
const contentTypes = {
  html: "text/html; charset=UTF-8",
  css: "text/css; charset=UTF-8",
  js: "text/javascript; charset=UTF-8",
  png: "image/png",
  webp: "image/webp",
};
const dist = new URL("../dist/", import.meta.url);

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=UTF-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export function createWebServer(config, log = console, admin) {
  async function route(req, res) {
    const url = new URL(req.url, config.origin);
    const { pathname: path } = url;
    const isRead = req.method === "GET" || req.method === "HEAD";
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (path === "/admin" || path.startsWith("/admin/")) {
      return admin
        ? admin.handle(req, res, url)
        : json(res, 404, { message: "Administration is not configured." });
    }
    if (path === "/healthz" && isRead) return json(res, 200, { ok: true });
    // Expose just the address the Automatic tab needs to show.
    if (path === "/api/email" && isRead && config.emailDeliveryEnabled) {
      return json(res, 200, { groupAddress: config.groupAddress });
    }
    const file = path === "/" ? "/index.html" : path;
    if (isRead && staticPath.test(file)) {
      try {
        const content = await readFile(new URL(file.slice(1), dist));
        const extension = file.split(".").at(-1);
        res.writeHead(200, {
          "Content-Type": contentTypes[extension],
          "Cache-Control": "no-cache",
        });
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

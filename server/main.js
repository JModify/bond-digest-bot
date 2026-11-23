import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createSecureContext } from "node:tls";
import { loadConfig } from "./config.js";
import { createSesTransport, startDeliveryWorker } from "./delivery.js";
import { createWebServer } from "./http.js";
import { createSmtpServer } from "./smtp.js";
import { openStore } from "./store.js";

process.umask(0o077);
const config = loadConfig();

function readSmtpTls() {
  return {
    key: readFileSync(config.tlsKeyPath),
    cert: readFileSync(config.tlsCertPath),
  };
}

let tls = readSmtpTls();

mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
const store = openStore(config.databasePath);
chmodSync(config.databasePath, 0o600);
store.recover();

const transport = createSesTransport(config.region);
const web = createWebServer(config, store);
const smtp = createSmtpServer(config, store, tls);
const tlsRefresh = setInterval(() => {
  try {
    const next = readSmtpTls();
    if (next.key.equals(tls.key) && next.cert.equals(tls.cert)) return;
    // Caddy writes the two files separately. Validate the pair before replacing the live context.
    createSecureContext(next);
    smtp.updateSecureContext(next);
    tls = next;
    console.log("Reloaded the SMTP certificate");
  } catch (error) {
    console.warn("SMTP certificate reload deferred:", error.code || error.name);
  }
}, 60_000).unref();
let stopWorker = async () => {};
let finishing = false;
const stopServer = (server) => new Promise((resolve) => server.close(resolve));

async function shutdown(exitCode = 0) {
  if (finishing) return;
  finishing = true;
  process.exitCode = exitCode;
  clearInterval(tlsRefresh);
  await Promise.all([stopServer(web), stopServer(smtp), stopWorker()]);
  transport.close();
  store.close();
}

config.onWorkerError = () => shutdown(1);
for (const [name, server] of [["SMTP", smtp], ["HTTP", web]]) {
  server.on("error", (error) => {
    console.error(`${name} listener error:`, error.code || error.name);
    shutdown(1);
  });
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown());

smtp.listen(2525, "0.0.0.0", () => {
  web.listen(8080, "0.0.0.0", () => {
    stopWorker = startDeliveryWorker(config, store, transport);
    console.log("Digest Bot is listening on HTTP 8080 and SMTP 2525");
  });
});

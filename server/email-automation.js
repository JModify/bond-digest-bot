import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createSecureContext } from "node:tls";
import { createSesTransport, startDeliveryWorker } from "./delivery.js";
import { createSmtpServer } from "./smtp.js";
import { openStore } from "./store.js";

export function prepareEmailDelivery(config, onError) {
  function readSmtpTls() {
    return { key: readFileSync(config.tlsKeyPath), cert: readFileSync(config.tlsCertPath) };
  }

  let tls = readSmtpTls();
  mkdirSync(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  const store = openStore(config.databasePath);
  chmodSync(config.databasePath, 0o600);
  store.recover();

  const transport = createSesTransport(config.region);
  const smtp = createSmtpServer(config, store, tls);
  let stopWorker = async () => {};
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

  config.onWorkerError = onError;
  smtp.on("error", (error) => {
    console.error("SMTP listener error:", error.code || error.name);
    onError();
  });

  return {
    store,
    start(onListening) {
      smtp.listen(2525, "0.0.0.0", () => {
        stopWorker = startDeliveryWorker(config, store, transport);
        console.log("Digest Bot is listening on SMTP 2525");
        onListening();
      });
    },
    async close() {
      clearInterval(tlsRefresh);
      await Promise.all([new Promise((resolve) => smtp.close(resolve)), stopWorker()]);
      transport.close();
      store.close();
    },
  };
}

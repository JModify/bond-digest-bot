// Starts the HTTP listener and any enabled services inside the Digest Bot container.

import { loadConfig } from "./config.js";
import { createWebServer } from "./http.js";

process.umask(0o077);
const config = loadConfig();
let finishing = false;
let delivery;
// Open the delivery queue before wiring the admin panel so both use the same connection.
if (config.emailDeliveryEnabled) {
  const { prepareEmailDelivery } = await import("./email-automation.js");
  delivery = prepareEmailDelivery(config, () => shutdown(1));
}
let admin;
if (config.admin) {
  const { createAdminPanel } = await import("./admin/routes.js");
  admin = createAdminPanel(config, delivery?.store);
}
const web = createWebServer(config, console, admin);

// Drain HTTP and mail before closing their databases. An admin request can still need the queue
// while it finishes.
async function shutdown(exitCode = 0) {
  if (finishing) return;
  finishing = true;
  process.exitCode = exitCode;
  const webDrained = new Promise((resolve) => web.close(resolve));
  await Promise.all([webDrained, delivery?.close(webDrained)]);
  admin?.close();
}

web.on("error", (error) => {
  console.error("HTTP listener error:", error.code || error.name);
  shutdown(1);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown());

function startWeb() {
  web.listen(8080, "0.0.0.0", () => console.log("Digest Bot is listening on HTTP 8080"));
}
// Start serving the site once SMTP is listening when automatic delivery is enabled.
if (delivery) {
  delivery.start(startWeb, {
    outgoingPaused: admin?.outgoingPaused,
    careersDay: admin?.careersDay,
  });
} else startWeb();

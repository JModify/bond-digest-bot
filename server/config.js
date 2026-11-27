// Validates environment settings at startup and gives each enabled service the settings it needs.

import { join } from "node:path";
import { normaliseAddress } from "../dist/core/mailbox.js";

export const processingMethodLabels = Object.freeze({ server: "Server", other: "Other" });

const hostnamePattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const list = (value) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

function hostname(value, name) {
  const host = value?.trim().toLowerCase();
  if (!host || !hostnamePattern.test(host)) throw new Error(`${name} must be a DNS hostname.`);
  return host;
}

function adminConfig(env) {
  if (env.SDC_ADMIN_ENABLED !== "true") return undefined;
  const origin = new URL(env.SDC_ADMIN_ORIGIN ?? "https://bond-sdc.com");
  if (origin.protocol !== "https:" || origin.href !== origin.origin + "/") {
    throw new Error("SDC_ADMIN_ORIGIN must be an HTTPS origin without a path.");
  }
  const instanceId = env.SDC_ADMIN_EC2_INSTANCE_ID?.trim();
  if (instanceId && !/^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(instanceId)) {
    throw new Error("SDC_ADMIN_EC2_INSTANCE_ID must be an EC2 instance ID.");
  }
  return {
    origin: origin.origin,
    host: origin.host,
    instanceId,
    region: env.AWS_REGION || "ap-southeast-2",
    updateDir: env.SDC_ADMIN_UPDATE_DIR,
    databasePath: env.SDC_ADMIN_DATABASE ?? "./var/admin.sqlite",
  };
}

export function loadConfig(env = process.env) {
  const origin = new URL(env.DIGEST_PUBLIC_ORIGIN ?? "https://digest.bond-sdc.com");
  if (origin.protocol !== "https:" || origin.href !== origin.origin + "/") {
    throw new Error("DIGEST_PUBLIC_ORIGIN must be an HTTPS origin without a path.");
  }
  const mailConfigured = env.DIGEST_EMAIL_DELIVERY_ENABLED === "true";
  // Existing deployments without a saved method still take their default from the Compose files.
  const processingMethod = env.DIGEST_PROCESSING_METHOD || (mailConfigured ? "server" : "other");
  if (!Object.hasOwn(processingMethodLabels, processingMethod)) {
    throw new Error("DIGEST_PROCESSING_METHOD must be server or other.");
  }
  const emailDeliveryEnabled = processingMethod === "server";
  if (emailDeliveryEnabled && !mailConfigured) {
    throw new Error("Server processing requires compose.delivery.yaml.");
  }
  // The website can show the group address without opening the mail database or SMTP listener.
  const groupAddress = normaliseAddress(env.DIGEST_GROUP_ADDRESS).toLowerCase();
  const webConfig = {
    origin: origin.origin,
    processingMethod,
    groupAddress,
    emailDeliveryEnabled,
    admin: adminConfig(env),
  };
  if (!emailDeliveryEnabled) return webConfig;

  if (!groupAddress)
    throw new Error("Set DIGEST_GROUP_ADDRESS to the Microsoft 365 group email address.");
  const inboxDomain = hostname(
    env.DIGEST_INBOX_DOMAIN ?? "inbox.bond-sdc.com",
    "DIGEST_INBOX_DOMAIN",
  );
  const from = normaliseAddress(env.DIGEST_FROM ?? "digest@bond-sdc.com");
  if (!from) throw new Error("DIGEST_FROM must be an email address verified in SES.");
  const sharepointHosts = list(env.DIGEST_SHAREPOINT_HOSTS);
  if (!sharepointHosts.every((host) => hostnamePattern.test(host))) {
    throw new Error("DIGEST_SHAREPOINT_HOSTS must contain valid hostnames.");
  }
  const tlsDir = env.DIGEST_TLS_DIR ?? "./var/smtp-tls";
  return {
    ...webConfig,
    inboxAddress: "digest@" + inboxDomain,
    mailHost: hostname(env.DIGEST_MAIL_HOST ?? "mail.bond-sdc.com", "DIGEST_MAIL_HOST"),
    from,
    sharepointHosts,
    region: env.AWS_REGION || "ap-southeast-2",
    databasePath: env.DIGEST_DATABASE ?? "./var/digest.sqlite",
    tlsKeyPath: env.DIGEST_TLS_KEY_FILE ?? join(tlsDir, "privkey.pem"),
    tlsCertPath: env.DIGEST_TLS_CERT_FILE ?? join(tlsDir, "fullchain.pem"),
    maxMessageBytes: 10 * 1024 * 1024,
  };
}

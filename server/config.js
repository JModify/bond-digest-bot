import { join } from "node:path";
import { normaliseAddress } from "../dist/core/mailbox.js";

const hostnamePattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const list = (value) => (value ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);

function hostname(value, name) {
  const host = value?.trim().toLowerCase();
  if (!host || !hostnamePattern.test(host)) throw new Error(`${name} must be a DNS hostname.`);
  return host;
}

export function loadConfig(env = process.env) {
  const origin = new URL(env.DIGEST_PUBLIC_ORIGIN ?? "https://digest.bond-sdc.com");
  if (origin.protocol !== "https:" || origin.href !== origin.origin + "/") {
    throw new Error("DIGEST_PUBLIC_ORIGIN must be an HTTPS origin without a path.");
  }
  const emailDeliveryEnabled = env.DIGEST_EMAIL_DELIVERY_ENABLED === "true";
  const webConfig = { origin: origin.origin, emailDeliveryEnabled };
  if (!emailDeliveryEnabled) return webConfig;

  const groupAddress = normaliseAddress(env.DIGEST_GROUP_ADDRESS).toLowerCase();
  if (!groupAddress) throw new Error("Set DIGEST_GROUP_ADDRESS to the Microsoft 365 group email address.");
  const inboxDomain = hostname(env.DIGEST_INBOX_DOMAIN ?? "inbox.bond-sdc.com", "DIGEST_INBOX_DOMAIN");
  const from = normaliseAddress(env.DIGEST_FROM ?? "digest@bond-sdc.com");
  if (!from) throw new Error("DIGEST_FROM must be an email address verified in SES.");
  const sharepointHosts = list(env.DIGEST_SHAREPOINT_HOSTS);
  if (!sharepointHosts.every((host) => hostnamePattern.test(host))) {
    throw new Error("DIGEST_SHAREPOINT_HOSTS must contain valid hostnames.");
  }
  const tlsDir = env.DIGEST_TLS_DIR ?? "./var/smtp-tls";
  return {
    ...webConfig,
    groupAddress,
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

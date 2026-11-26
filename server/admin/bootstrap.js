// EC2 terminal command to provision the admin owner or reset the owner's password and sessions.

import { randomBytes } from "node:crypto";
import { loadConfig } from "../config.js";
import { hashPassword, openAccounts, ownerName } from "./accounts.js";

process.umask(0o077);
const { admin } = loadConfig();
if (!admin)
  throw new Error("Set SDC_ADMIN_ENABLED=true and recreate the Digest Bot container first.");
const accounts = openAccounts(admin.databasePath);
try {
  // Print the generated password only when this command creates or resets the account.
  const temporaryPassword = randomBytes(24).toString("base64url");
  const created = accounts.provision(
    await hashPassword(temporaryPassword),
    process.argv.includes("--reset"),
  );
  if (!created) {
    console.log(
      `The ${ownerName} account already exists. Use --reset to reset its password and sign it out.`,
    );
  } else {
    console.log(
      `Username: ${ownerName}\nPassword: ${temporaryPassword}\nSign in at ${admin.origin}/admin and change the password in Account.`,
    );
  }
} finally {
  accounts.close();
}

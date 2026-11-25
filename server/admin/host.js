import { randomUUID } from "node:crypto";
import { access, link, readFile, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

export function createHostActions(config) {
  const updateDir = config.updateDir;
  const requestPath = updateDir && join(updateDir, "requests", "request.json");
  const statusPath = updateDir && join(updateDir, "status", "update.json");
  let ec2;

  async function updateStatus() {
    if (!requestPath) return { state: "disabled", detail: "Host updater is not configured." };
    try {
      const exists = await access(requestPath, constants.F_OK).then(() => true, () => false);
      const result = JSON.parse(await readFile(statusPath, "utf8"));
      if (typeof result.state !== "string" || typeof result.detail !== "string") throw new Error("Invalid host status");
      if (exists && result.state !== "running") return { state: "queued", detail: "Waiting for the host to start the request." };
      if (!exists && result.state === "running") return { ...result, state: "unknown", detail: "The host did not record a final result." };
      return result;
    } catch {
      return { state: "unavailable", detail: "Could not read the host updater status." };
    }
  }

  return {
    updateStatus,
    async readSettings() {
      if (!updateDir) return null;
      try {
        return JSON.parse(await readFile(join(updateDir, "status", "settings.json"), "utf8"));
      } catch {
        return null;
      }
    },
    async request(payload) {
      const status = await updateStatus();
      if (["disabled", "unavailable", "running", "queued"].includes(status.state)) return false;
      const staging = join(updateDir, "requests", `${randomUUID()}.tmp`);
      await writeFile(staging, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
      try {
        // Publish all bytes at once and leave any pending request in place.
        await link(staging, requestPath);
        return true;
      } catch (error) {
        if (error.code === "EEXIST") return false;
        throw error;
      } finally {
        await unlink(staging);
      }
    },
    async reboot() {
      const { EC2Client, RebootInstancesCommand } = await import("@aws-sdk/client-ec2");
      ec2 ??= new EC2Client({ region: config.region, maxAttempts: 1 });
      return ec2.send(new RebootInstancesCommand({ InstanceIds: [config.instanceId] }), { abortSignal: AbortSignal.timeout(10_000) });
    },
    close: () => ec2?.destroy(),
  };
}

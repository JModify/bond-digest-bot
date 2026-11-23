const storageKey = "digest-bot.active-delivery";
const inProgress = new Set(["waiting", "queued", "processing", "sending"]);
const statusText = {
  waiting: "Waiting for the SharePoint email",
  queued: "Email received. Waiting to format or send it.",
  processing: "Formatting the digest",
  sending: "Sending the formatted digest",
  sent: "Amazon SES accepted the formatted digest for delivery.",
  expired: "This request has expired.",
  uncertain: "Delivery could not be confirmed. Check your inbox before starting another request.",
};
const failures = {
  recipient: "This return address is no longer allowed.",
  format: "The email could not be read as a SharePoint news digest.",
  source_host: "The digest contains news links outside the configured SharePoint site.",
  provider_limit: "Amazon SES was still rate-limiting delivery after retries.",
  provider_rejected: "Amazon SES rejected delivery. Check the sender identity, permissions and sandbox status.",
};
const localDate = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Brisbane",
  dateStyle: "medium",
  timeStyle: "short",
});
const byId = (id) => document.getElementById(id);

function restoreRequest() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (/^[0-9a-f]{32}$/.test(saved?.id) && /^[0-9a-f]{48}$/.test(saved?.statusKey)) return saved;
  } catch {
    // The current page can still track a request when storage is unavailable.
  }
  return null;
}

export function mountEmailDelivery(getPreset, announce) {
  const form = byId("delivery-form");
  const recipient = byId("delivery-recipient");
  const start = byId("start-delivery");
  const availability = byId("delivery-availability");
  const error = byId("delivery-error");
  let active = false;
  let enabled = false;
  let lastPrefill = "";
  let job = restoreRequest();
  let statusRequest;
  let timer;

  async function api(path, options = {}) {
    const response = await fetch("/api/email" + path, {
      ...options,
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new Error("Email delivery is available on the EC2 deployment.");
    }
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message), { status: response.status });
    return result;
  }

  function showError(message = "") {
    error.hidden = !message;
    error.textContent = message;
  }

  function setJob(value) {
    job = value;
    try {
      if (job) sessionStorage.setItem(storageKey, JSON.stringify({ id: job.id, statusKey: job.statusKey }));
      else sessionStorage.removeItem(storageKey);
    } catch {
      // The status remains in memory.
    }
  }

  function show() {
    byId("delivery-subject").textContent = job?.subject ?? getPreset().subject;
    form.hidden = !enabled || Boolean(job);
    byId("delivery-request").hidden = !job;
    if (!job) return;
    const state = job.state;
    const waiting = state === "waiting";
    byId("delivery-sharepoint").hidden = !waiting;
    byId("delivery-reset").hidden = !state || inProgress.has(state);
    const label = state === "failed" ? (failures[job.reason] || "The digest could not be sent.") : statusText[state];
    if (byId("delivery-state").textContent !== (label ?? "Checking request status…")) {
      byId("delivery-state").textContent = label ?? "Checking request status…";
    }
    byId("delivery-return").textContent = job.recipient ? "Return email " + job.recipient : "";
    if (waiting) {
      byId("delivery-inbox").value = job.inbox;
      byId("delivery-code").value = job.titleCode;
      byId("delivery-expiry").textContent = "This address expires at " + localDate.format(job.expiresAt) + " Brisbane time.";
    }
  }

  async function poll() {
    if (!active || !enabled || !job || statusRequest || (job.state && !inProgress.has(job.state))) return;
    const { id, statusKey } = job;
    statusRequest = api("/requests/" + id, { headers: { "X-Digest-Status": statusKey } });
    try {
      const result = await statusRequest;
      if (job?.id !== id) return;
      setJob({ ...result, statusKey });
      showError();
      show();
    } catch (cause) {
      if (job?.id !== id) return;
      if (cause.status === 404) {
        setJob(null);
        show();
      }
      showError(cause.message || "Could not refresh the request status.");
    } finally {
      statusRequest = undefined;
      if (active && job && (!job.state || inProgress.has(job.state))) timer = setTimeout(poll, 3000);
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearTimeout(timer);
    start.disabled = true;
    showError();
    try {
      const created = await api("/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient: recipient.value, subject: getPreset().subject }),
      });
      setJob(created);
      show();
      poll();
    } catch (cause) {
      showError(cause.message || "Could not start the request.");
    } finally {
      start.disabled = false;
    }
  });

  byId("delivery-reset").addEventListener("click", () => {
    setJob(null);
    showError();
    show();
    recipient.focus();
  });

  for (const button of document.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", async () => {
      const field = byId(button.dataset.copy);
      try {
        await navigator.clipboard.writeText(field.value);
        announce(field.id === "delivery-code" ? "Title copied." : "Email address copied.");
      } catch {
        field.select();
      }
    });
  }

  return {
    async setActive(open) {
      active = open;
      clearTimeout(timer);
      if (!active) return;
      if (recipient.value === lastPrefill) {
        recipient.value = getPreset().recipient;
        lastPrefill = recipient.value;
      }
      if (enabled) {
        show();
        poll();
        return;
      }
      try {
        const { from } = await api("");
        enabled = true;
        availability.textContent = "Create a one-time address for your next digest.";
        byId("delivery-from").textContent = from;
        byId("delivery-settings").hidden = false;
        show();
        poll();
      } catch {
        availability.textContent = "Email delivery is unavailable here. You can upload an .eml in Workspace.";
      }
    },
  };
}

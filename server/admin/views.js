// Renders admin pages and forms on the server. The route handler performs the corresponding access
// checks.

import { randomUUID } from "node:crypto";
import { defaultCareersDay, weekdays } from "../careers.js";
import { passwordHint } from "./accounts.js";
import { adminPages, can, canManageRole, permissions } from "./permissions.js";

const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
// Escape values from emails, settings and accounts before inserting them into HTML.
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
const brisbaneTime = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Australia/Brisbane",
});
function time(value) {
  const date = new Date(value);
  return `<time datetime="${date.toISOString()}">${brisbaneTime.format(date)}</time>`;
}
const post = (path, fields, button, className = "") =>
  `<form method="post" action="/admin/${path}" class="${className}">${fields}${button}</form>`;
const submit = (text, className = "") =>
  `<button type="submit" class="${className}">${text}</button>`;
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;

// Translate queue states into user-facing labels. A sent record means SES accepted the request.
export const statuses = {
  queued: "Queued",
  processing: "Preparing",
  sending: "Sending to SES",
  sent: "Accepted by SES",
  retry_wait: "Waiting to retry",
  failed: "Failed",
  uncertain: "Unconfirmed",
  rejected: "SMTP rejected",
  deferred: "SMTP deferred",
  waiting: "Waiting",
  expired: "Expired",
};
export const settingsFields = {
  ACME_EMAIL: "Certificate contact email",
  DIGEST_GROUP_ADDRESS: "Microsoft 365 digest group",
  SDC_ADMIN_EC2_INSTANCE_ID: "EC2 instance ID",
};

const eventLabels = {
  received: "Received",
  duplicate: "Duplicate received",
  imported: "History imported",
  ...statuses,
};
const kinds = { incoming: "Automatic digest", resend: "Resend", smtp_attempt: "SMTP attempt" };
const badge = (state) =>
  `<span class="status" data-state="${esc(state)}">${esc(statuses[state] ?? state)}</span>`;
const displayed = (value) => (value ? esc(value) : "—");

function navigation(user, current) {
  if (!user) return "";
  return `<nav aria-label="Administration">${adminPages(user)
    .map(
      ([key, label]) =>
        `<a href="/admin/${key}"${current === key ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("")}</nav>`;
}

// Wrap each page with the shared header, role-aware navigation and optional confirmation notice.
export function page(title, content, { user, current, notice } = {}) {
  return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${esc(title)} | Service Desk Central Admin</title>
  <link rel="icon" href="/service-desk-mark.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/admin/admin.css">
  ${notice ? '<script src="/admin/notice.js" defer></script>' : ""}
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="site-header">
    <div class="shell header-inner">
      <a class="brand" href="/"><img src="/service-desk-mark.svg" alt="" width="32" height="32">Service Desk Central</a>
      ${user ? `<div class="identity"><span>${esc(user.username)} · ${esc(user.role_name ?? "Owner")}</span>${post("logout", "", submit("Sign out", "secondary"))}</div>` : ""}
    </div>
    <div class="shell">${navigation(user, current)}</div>
  </header>
  <main class="shell main" id="main">
    ${notice ? `<p class="notice" role="status">${esc(notice)}</p>` : ""}
    ${content}
  </main>
</body>
</html>`;
}

export function signIn({ ready, error } = {}) {
  const form = `<label>Username<input name="username" autocomplete="username" maxlength="32" required autofocus></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" maxlength="256" required></label>`;
  return page(
    "Sign in",
    `<section class="panel sign-in">
    <h1>Admin sign-in</h1>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
    ${ready ? post("login", form, submit("Sign in"), "fields") : "<p>Set up the owner account from the EC2 terminal to sign in.</p>"}
  </section>`,
  );
}

export function messagePage(title, message, user) {
  return page(
    title,
    `<section class="panel"><h1>${esc(title)}</h1><p>${esc(message)}</p>
    <p><a href="/admin">Return to admin</a></p></section>`,
    { user },
  );
}

function table(headers, contents) {
  return `<div class="table-scroll"><table><thead><tr>${headers.map((header) => `<th scope="col">${header}</th>`).join("")}</tr></thead><tbody>${contents}</tbody></table></div>`;
}

export function mailPage(user, history, state, notice) {
  const body = history
    ? mailTable(history, state)
    : "<p>Automatic email delivery is disabled. Start the mail-enabled Compose stack to access its history.</p>";
  return page(
    "Email History",
    `<h1>Digest Bot Email History</h1><p class="lede">SMTP submissions and outgoing SES requests. Times are shown in Brisbane time.</p>${body}`,
    { user, current: "mail", notice },
  );
}

function mailTable({ rows, page: current, pages, total }, state) {
  const options = Object.entries(statuses)
    .map(
      ([key, name]) => `<option value="${key}"${state === key ? " selected" : ""}>${name}</option>`,
    )
    .join("");
  const link = (number) =>
    `/admin/mail?${esc(new URLSearchParams({ page: number, ...(state ? { state } : {}) }).toString())}`;
  const records = rows
    .map(
      (row) => `<tr>
    <td><a class="record-id" href="/admin/mail/${row.public_id}">${row.public_id}</a></td><td>${time(row.created_at)}</td>
    <td>${displayed(row.output_subject)}</td><td>${displayed(row.recipient)}</td><td>${badge(row.state)}</td>
  </tr>`,
    )
    .join("");
  return `<section class="panel">
    <form class="filter" method="get" action="/admin/mail"><label>Status<select name="state"><option value="">All statuses</option>${options}</select></label>${submit("Filter", "secondary")}</form>
    ${records ? table(["ID", "Queued", "Subject", "Send To", "Status"], records) : "<p>No records match this view.</p>"}
    <nav class="pagination" aria-label="Email History pages">
      <span>${total} ${total === 1 ? "record" : "records"} · Page ${current} of ${pages}</span>
      <div>${current > 1 ? `<a href="${link(current - 1)}" rel="prev">Previous</a>` : ""}${current < pages ? `<a href="${link(current + 1)}" rel="next">Next</a>` : ""}</div>
    </nav>
  </section>`;
}

export function mailDetail(user, row, notice) {
  const labels = [
    ["ID", row.public_id],
    ["Incoming subject", row.kind === "incoming" ? row.subject : ""],
    [
      "Source",
      row.source ? row.source + (row.kind === "smtp_attempt" ? " (SMTP envelope)" : "") : "",
    ],
    ["Send To", row.recipient],
    ["Outgoing subject", row.output_subject],
    ["SES message ID", row.ses_message_id],
    ["Requested by", row.actor],
  ];
  const events = row.events
    .map(
      ({ at, event, detail }) =>
        `<tr><td>${time(at)}</td><td>${esc(eventLabels[event] ?? event)}</td><td>${displayed(detail)}</td></tr>`,
    )
    .join("");
  // Each rendered resend form gets a request key so a repeated submission points at the same queued
  // copy.
  const resend =
    row.can_resend && can(user, "resend")
      ? post(
          `mail/${row.public_id}/resend`,
          `${hidden("request", randomUUID())}<label>Recipient email<input type="email" name="recipient" autocomplete="off" maxlength="254" placeholder="${esc(row.recipient)}" required></label>`,
          submit("Send a copy"),
          "inline-form",
        )
      : row.can_resend
        ? ""
        : "<p>No formatted copy is available to resend.</p>";
  return page(
    "Email record",
    `<a class="back-link" href="/admin/mail">Email History</a><h1>${esc(row.output_subject || `Email record ${row.public_id}`)}</h1>
    <section class="panel"><div class="panel-heading"><h2>${kinds[row.kind]}</h2>${badge(row.state)}</div>
      <dl class="facts">${labels
        .filter(([, value]) => value)
        .map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`)
        .join("")}</dl>
      ${row.original_public_id ? `<p><a href="/admin/mail/${row.original_public_id}">View original email record</a></p>` : ""}
      ${row.state === "sent" ? "<p>Amazon SES accepted the send request. Mailbox delivery is unverified.</p>" : ""}
      ${resend}
    </section>
    <section class="panel"><h2>Timeline</h2>${table(["Brisbane time", "Event", "Details"], events)}</section>`,
    { user, current: "mail", notice },
  );
}

export function systemPage(
  user,
  {
    pending,
    paused,
    careersDay = defaultCareersDay,
    activity = [],
    update = { state: "disabled" },
    settings,
    instanceId,
  },
  notice,
) {
  const runningUpdate = ["queued", "running"].includes(update.state);
  const updateAvailable = !runningUpdate && !["disabled", "unavailable"].includes(update.state);
  return page(
    "System",
    `<h1>System</h1>
    ${digestPanel(user, pending, paused, careersDay)}
    ${can(user, "site_updates") ? siteUpdatesPanel(update, updateAvailable) : ""}
    ${can(user, "environment") ? environmentSettings(settings, updateAvailable, pending !== undefined) : ""}
    ${can(user, "reboot") ? rebootPanel(instanceId, settings?.SDC_ADMIN_EC2_INSTANCE_ID, runningUpdate, can(user, "site_updates") && updateAvailable) : ""}
    ${can(user, "activity") ? activityPanel(activity) : ""}`,
    { user, current: "system", notice },
  );
}

function digestPanel(user, pending, paused, careersDay) {
  // The status and Careers controls have separate permissions, so either section can appear on its
  // own.
  const showStatus = can(user, "digest_status") || can(user, "freeze");
  const showSchedule = can(user, "careers_schedule");
  if (!showStatus && !showSchedule) return "";
  const state = pending === undefined ? "Disabled" : paused ? "Frozen" : "Listening";
  const controls =
    pending !== undefined && can(user, "freeze")
      ? post(
          "system/mail",
          hidden("pause", String(!paused)),
          submit(paused ? "Resume" : "Freeze", "secondary"),
        )
      : "";
  return `<section class="panel">
    <div class="panel-heading"><h2>Digest Bot</h2>${controls}</div>
    ${
      showStatus
        ? `<dl class="digest-metrics">
      <div><dt>State</dt><dd class="digest-state" data-state="${state.toLowerCase()}">${state}</dd></div>
      <div><dt>Queued</dt><dd>${pending ?? 0}</dd></div>
    </dl>`
        : ""
    }
    ${showSchedule ? careersSchedule(careersDay) : ""}
  </section>`;
}

function careersSchedule(day) {
  const options = weekdays
    .map(
      (weekday) =>
        `<option value="${weekday}"${weekday === day ? " selected" : ""}>${weekday}</option>`,
    )
    .join("");
  const field = `<label>Include on<select name="weekday" aria-describedby="careers-schedule-hint" required>${options}</select></label>`;
  return `<div class="digest-schedule">
    <div><h3>Careers at Bond</h3><p id="careers-schedule-hint">Appends the article to automatic Staff News emails on this day (Brisbane time).</p></div>
    ${post("system/careers", field, submit("Save schedule"), "inline-form")}
  </div>`;
}

function siteUpdatesPanel(update, available) {
  const controls = available
    ? `<div class="inline-form">${post("system/update", "", submit("Pull latest and restart sites"))}
    ${post("system/restart", "", submit("Rebuild current code", "secondary"))}</div>`
    : "";
  return `<section class="panel"><h2>Site updates</h2><p>Pulls <code>main</code> from both repositories and rebuilds the two Compose services. Both rebuild actions briefly interrupt the sites.</p>
    <p><strong>${esc(update.state.charAt(0).toUpperCase() + update.state.slice(1))}</strong> · ${esc(update.detail)}</p>
    ${update.updatedAt ? `<p>Last update ${time(update.updatedAt)}</p>` : ""}${controls}</section>`;
}

function activityPanel(activity) {
  const rows = activity
    .map(
      ({ at, actor, action, detail }) =>
        `<tr><td>${time(at)}</td><td>${esc(actor)}</td><td>${esc(action)}</td><td>${esc(detail)}</td></tr>`,
    )
    .join("");
  return `<section class="panel"><h2>Admin Activity</h2>${rows ? table(["Time", "User", "Action", "Details"], rows) : "<p>No admin activity yet.</p>"}</section>`;
}

function rebootPanel(instanceId, savedId, runningUpdate, updateAvailable) {
  let content;
  if (instanceId) {
    const controls = runningUpdate
      ? "<p>Wait for site maintenance to finish before rebooting.</p>"
      : post(
          "system/reboot",
          '<label>Type REBOOT to confirm<input name="confirmation" maxlength="6" required autocomplete="off"></label>',
          submit("Reboot EC2", "danger"),
          "inline-form",
        );
    content = `<p>Reboots <code>${esc(instanceId)}</code> and temporarily interrupts both sites and mail processing.</p>${controls}`;
  } else if (savedId) {
    const nextStep = runningUpdate
      ? "Wait for the host request to finish and refresh this page."
      : updateAvailable
        ? "Select <strong>Rebuild current code</strong> under Site updates to apply it."
        : "Recreate the Digest Bot container with Docker Compose to apply it.";
    content = `<p><code>${esc(savedId)}</code> is saved in <code>.env</code> and is waiting to be applied. ${nextStep}</p>`;
  } else {
    content =
      "<p>The running Digest Bot container has an empty <code>SDC_ADMIN_EC2_INSTANCE_ID</code>. Set it in <code>.env</code> and recreate the Digest Bot container.</p>";
  }
  return `<section class="panel"><h2>EC2 reboot</h2>${content}</section>`;
}

function environmentSettings(settings, available, automatic) {
  const fields = Object.entries(settingsFields)
    .map(([key, label]) => {
      const instance = key === "SDC_ADMIN_EC2_INSTANCE_ID";
      const required = key === "ACME_EMAIL" || (key === "DIGEST_GROUP_ADDRESS" && automatic);
      return `<label>${label}<input name="${key}" type="${instance ? "text" : "email"}" maxlength="${instance ? 19 : 254}" value="${esc(settings?.[key])}"${required ? " required" : ""}></label>`;
    })
    .join("");
  const editor =
    settings && available
      ? `<div class="settings-actions">
    ${post("system/settings", fields, submit("Save .env"), "inline-form")}
    ${post("system/refresh-settings", "", submit("Reload values from EC2", "secondary"))}</div>`
      : "<p>The host must finish its current request and provide the settings before you can edit them.</p>";
  return `<section class="panel"><h2>Environment settings</h2><p>Save changes to the EC2 <code>.env</code> file, then rebuild the sites to apply them.</p>${editor}</section>`;
}

const roleSelect = (roles, selected) =>
  `<label>Role<select name="role" required>${roles
    .map(
      ({ id, name }) =>
        `<option value="${id}"${id === selected ? " selected" : ""}>${esc(name)}</option>`,
    )
    .join("")}</select></label>`;
const passwordField = (name, label, required = true) =>
  `<label>${label}<input type="password" name="${name}" maxlength="128" ${name === "current" ? 'autocomplete="current-password"' : 'minlength="14" autocomplete="new-password"'}${required ? " required" : ""}></label>`;
const usernameField = (username = "") =>
  `<label>Username<input name="username" value="${esc(username)}" maxlength="32" minlength="3" autocomplete="off" required></label>`;

export function usersPage(user, users, roles, notice) {
  const allowedRoles = new Set(roles.map(({ id }) => id));
  const list = users
    .map(
      (account) => `<tr><td>${esc(account.username)}</td><td>${esc(account.role_name)}</td>
    <td>${allowedRoles.has(account.role) ? `<a href="/admin/users/${account.id}">Edit<span class="sr-only"> ${esc(account.username)}</span></a>` : ""}</td></tr>`,
    )
    .join("");
  return page(
    "Users",
    `<h1>Users</h1>
    <section class="panel"><h2>Accounts</h2>${table(["Username", "Role", "Actions"], list)}</section>
    <section class="panel"><h2>Add a user</h2>
      ${
        roles.length
          ? `<p>${passwordHint} Share the password with the user privately.</p>
        ${post("users", usernameField() + roleSelect(roles) + passwordField("password", "Initial password"), submit("Add user"), "inline-form")}`
          : "<p>No roles are available to assign.</p>"
      }</section>`,
    { user, current: "users", notice },
  );
}

const confirmDeletion =
  '<label><input type="checkbox" name="confirm" value="yes" required> Confirm deletion</label>';

export function editUserPage(user, account, roles, notice) {
  return page(
    "Edit user",
    `<a class="back-link" href="/admin/users">Users</a><h1>Edit ${esc(account.username)}</h1>
    <section class="panel"><p>${passwordHint} Leave the password field blank to keep the existing password.</p>
      ${post(`users/${account.id}`, usernameField(account.username) + roleSelect(roles, account.role) + passwordField("password", "New password", false), submit("Save changes"), "inline-form")}</section>
    <section class="panel"><h2>Delete account</h2><p>Deleting the account immediately signs the user out.</p>
      ${post(`users/${account.id}/delete`, confirmDeletion, submit("Delete user", "danger"), "fields stacked-form")}</section>`,
    { user, current: "users", notice },
  );
}

// Show every permission so managers can see the full role. Controls they cannot grant are disabled.
function roleFields(user, role) {
  const checks = Object.entries(permissions)
    .map(
      ([key, label]) =>
        `<label><input type="checkbox" name="permission" value="${key}"${role?.permissions.includes(key) ? " checked" : ""}${can(user, key) ? "" : " disabled"}> ${label}</label>`,
    )
    .join("");
  return `<label>Role name<input name="name" value="${esc(role?.name)}" maxlength="40" required></label>
    <fieldset class="permissions"><legend>Permissions</legend><div>${checks}</div></fieldset>`;
}

export function rolesPage(user, roles, notice) {
  const rows = roles
    .map(
      (role) => `<tr><td>${esc(role.name)}</td><td>${role.user_count}</td>
    <td>${canManageRole(user, role) ? `<a href="/admin/roles/${role.id}">Edit<span class="sr-only"> ${esc(role.name)}</span></a>` : ""}</td></tr>`,
    )
    .join("");
  return page(
    "Roles",
    `<h1>Roles</h1><p class="lede">Owner has every permission. Role managers can grant permissions they already have.</p>
    <section class="panel">${table(["Role", "Users", "Actions"], rows)}</section>
    <section class="panel"><h2>Add a role</h2>
      ${post("roles", roleFields(user), submit("Add role"), "fields stacked-form")}</section>`,
    { user, current: "roles", notice },
  );
}

export function editRolePage(user, role, notice) {
  return page(
    "Edit role",
    `<a class="back-link" href="/admin/roles">Roles</a><h1>Edit ${esc(role.name)}</h1>
    <section class="panel">${post(`roles/${role.id}`, roleFields(user, role), submit("Save changes"), "fields stacked-form")}</section>
    <section class="panel"><h2>Delete role</h2><p>Reassign any users with this role before deleting it.</p>
      ${post(`roles/${role.id}/delete`, confirmDeletion, submit("Delete role", "danger"), "fields stacked-form")}</section>`,
    { user, current: "roles", notice },
  );
}

export function accountPage(user, notice) {
  return page(
    "Account",
    `<h1>Account</h1><section class="panel"><h2>Change password</h2><p>${passwordHint} Changing it signs you out of existing sessions.</p>
    ${post("account", passwordField("current", "Current password") + passwordField("password", "New password"), submit("Change password"), "inline-form")}
  </section>`,
    { user, current: "account", notice },
  );
}

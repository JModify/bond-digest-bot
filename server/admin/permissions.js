// Defines permission keys for role settings, routes and controls shown in the admin panel.

export const permissions = Object.freeze({
  email_history: "Email History",
  resend: "Resend email",
  digest_status: "Digest Bot status",
  freeze: "Freeze and resume Digest Bot",
  careers_schedule: "Manage Careers at Bond schedule",
  activity: "Admin Activity",
  site_updates: "Site updates",
  environment: "Environment settings",
  reboot: "EC2 reboot",
  users: "User management",
  roles: "Role management",
});

export const defaultRoles = [
  ["owner", "Owner", []],
  ["viewer", "Viewer", ["email_history", "digest_status"]],
  ["operator", "Operator", ["email_history", "digest_status", "resend"]],
];

const systemPermissions = [
  "digest_status",
  "freeze",
  "careers_schedule",
  "activity",
  "site_updates",
  "environment",
  "reboot",
];

export function can(user, permission) {
  return user.role === "owner" || Boolean(user.permissions?.includes(permission));
}

export function canViewSystem(user) {
  return systemPermissions.some((permission) => can(user, permission));
}

// A manager may edit or assign a role only if they already hold all of its permissions. The owner
// role is reserved.
export function canManageRole(user, role) {
  return Boolean(
    role && role.id !== "owner" && role.permissions.every((permission) => can(user, permission)),
  );
}

export function adminPages(user) {
  return [
    ["mail", "Email History", can(user, "email_history")],
    ["system", "System", canViewSystem(user)],
    ["users", "Users", can(user, "users")],
    ["roles", "Roles", can(user, "roles")],
    ["account", "Account", true],
  ].filter(([, , allowed]) => allowed);
}

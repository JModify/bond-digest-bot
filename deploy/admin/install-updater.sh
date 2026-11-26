#!/bin/sh
# Install the optional EC2 maintenance worker beside a pair of Compose checkouts.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' 'Run this installer with sudo.' >&2
  exit 1
fi

scripts=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
root=$(CDPATH='' cd -- "$scripts/../../.." && pwd -P)
deploy_user=${SUDO_USER:-ubuntu}
mode=${1:-automatic}
case "$mode" in
  automatic|manual) ;;
  *)
    printf '%s\n' 'Use automatic or manual as the deployment mode.' >&2
    exit 1
    ;;
esac

if ! test -f "$root/bond-digest-bot/.env" || ! test -d "$root/bond-service-desk-central/.git"; then
  printf '%s\n' 'Use sibling bond-digest-bot and bond-service-desk-central checkouts and set up .env first.' >&2
  exit 1
fi
case "$root" in
  *[!a-zA-Z0-9_./-]*)
    printf '%s\n' 'Use a deployment path without spaces or special characters.' >&2
    exit 1
    ;;
esac

# The Node container uses group 1000 to place a request. The status directory is host-owned.
install -d -o root -g root -m 0711 /var/lib/bond-sdc-admin
install -d -o root -g 1000 -m 0730 /var/lib/bond-sdc-admin/requests
install -d -o root -g root -m 0755 /var/lib/bond-sdc-admin/status
install -d -m 0755 /usr/local/libexec
install -m 0755 "$scripts/host-admin.py" /usr/local/libexec/bond-sdc-host-admin.py
install -m 0644 "$scripts/bond-sdc-admin.service" "$scripts/bond-sdc-admin.path" /etc/systemd/system/
install -m 0600 /dev/null /etc/default/bond-sdc-admin
printf 'BOND_SDC_DEPLOY_ROOT=%s\nBOND_SDC_DEPLOY_USER=%s\nBOND_SDC_COMPOSE_MODE=%s\n' "$root" "$deploy_user" "$mode" > /etc/default/bond-sdc-admin
# Seed the settings and readiness files before accepting maintenance requests.
BOND_SDC_DEPLOY_ROOT=$root BOND_SDC_DEPLOY_USER=$deploy_user BOND_SDC_COMPOSE_MODE=$mode \
  /usr/bin/python3 /usr/local/libexec/bond-sdc-host-admin.py --snapshot
systemctl daemon-reload
systemctl enable --now bond-sdc-admin.path

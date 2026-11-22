#!/bin/sh
set -eu

case "${RENEWED_LINEAGE:-}" in
    /etc/letsencrypt/live/bond-sdc.com)
        systemctl reload nginx
        ;;
    /etc/letsencrypt/live/mail.bond-sdc.com)
        root=/opt/digest-bot
        target="$root/var/smtp-tls"
        install -d -m 0750 -o root -g 1000 "$target"
        install -m 0644 "$RENEWED_LINEAGE/fullchain.pem" "$target/fullchain.pem.new"
        install -m 0640 -o root -g 1000 "$RENEWED_LINEAGE/privkey.pem" "$target/privkey.pem.new"
        mv "$target/fullchain.pem.new" "$target/fullchain.pem"
        mv "$target/privkey.pem.new" "$target/privkey.pem"
        cd "$root"
        if [ -n "$(docker compose ps --status running -q digest-bot)" ]; then
            docker compose restart digest-bot
        fi
        ;;
esac

# Optional email delivery infrastructure

The standard Digest Bot deployment formats `.eml` files in the browser. The former email-delivery interface is retained in [`automation-ui/`](../automation-ui/) outside the files the website serves. Restoring the interface requires wiring it back into the page. The SMTP listener, request APIs, SQLite queue, certificate renewal and SES transport are available for future integration.

## Run the mail backend when needed

1. Confirm SharePoint can send a test digest to the external inbox domain before enabling delivery.
2. At your DNS provider, create a DNS-only **A** record for `mail.bond-sdc.com` pointing to the EC2 Elastic IP. Add inbound TCP `25` to the EC2 security group so mail servers can reach the listener.
3. In [Amazon SES](https://console.aws.amazon.com/ses/) in Sydney, verify `bond-sdc.com` with Easy DKIM and verify the test recipient’s mailbox if you’re in the sandbox. Give the EC2 role the permissions in [the SES policy template](iam-ses-send.template.json), with the actual AWS account ID and verified return address. Enable IMDSv2 and set the metadata hop limit to `2` so the container can use the role.
4. Put the same mailbox in `DIGEST_ALLOWED_RECIPIENTS` in `.env`. From the Digest Bot checkout, create the SQLite directory. Run the two Compose files together with Docker Engine 26+ and Compose 2.39+.

```bash
sudo install -d -m 0700 -o 1000 -g 1000 var/data
sudo docker compose -f compose.yaml -f compose.delivery.yaml up -d --build --wait --wait-timeout 420
```

5. Once SMTP is ready, create the **MX** record for `inbox.bond-sdc.com` with priority `10` and target `mail.bond-sdc.com`. Confirm both DNS and SMTP.

```bash
dig +short MX inbox.bond-sdc.com
openssl s_client -starttls smtp -connect 127.0.0.1:25 \
  -servername mail.bond-sdc.com -verify_hostname mail.bond-sdc.com \
  -verify_return_error -brief </dev/null
```

The optional configuration activates `/api/email`, publishes the SMTP port and mounts the mail certificate. Digest Bot reloads renewed certificates for new connections. The old UI remains outside the public site in both deployment modes. Run `sudo docker compose up -d --force-recreate --wait` with the base file to return to manual mode. The data directory and certificate volumes are preserved.

[AWS sender identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) · [Attach a role to EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/attach-iam-role.html) · [IMDS settings](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-IMDS-new-instances.html)

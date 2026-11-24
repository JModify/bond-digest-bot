# Enable automatic digests on your existing EC2 server

Digest Bot v1.1.2 has public **Manual** and **Automatic** tabs. Automatic displays the Microsoft 365 group address. A user sends a SharePoint news digest to the group and receives the formatted version in their original inbox. The bot uses SQLite to track which messages it has processed.

| Address | Where to use it |
| --- | --- |
| Your Microsoft 365 group address | `DIGEST_GROUP_ADDRESS` in `.env`. The **Automatic** tab displays this address for SharePoint’s **To** field. |
| `digest@inbox.bond-sdc.com` | The bot’s fixed SMTP address. Add it as an external member of the group. |
| `digest@bond-sdc.com` | The address Amazon SES uses to send the formatted reply. |

Microsoft documents that group guests receive conversations by email. Test **Email a news digest** in your tenant with non-sensitive articles. The group’s outgoing copy must preserve the original From address and pass either DKIM for the From domain or SPF for an SMTP envelope domain that matches it. The group’s Microsoft 365 posting rules still control who can deliver messages through the group. [Microsoft 365 group guests](https://support.microsoft.com/en-us/outlook/people/adding-guests-to-groups-in-outlook) · [Microsoft sender rewriting](https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/using-sender-rewriting-scheme)

## 1. Set up a private Microsoft 365 group

1. Confirm Bond ITS approves delivering staff news to the EC2-hosted bot. In new Outlook, go to **Groups → New group** and create a **Private** group dedicated to this workflow. Copy the group’s actual email address. It needs to appear in SharePoint’s **To** picker.
2. Keep shared files and unrelated conversations out of this group. Add the bot address in Step 5, after the SMTP listener is ready. Your tenant must permit external membership. Bond ITS can advise whether to add the address as a guest or an external mail contact.

[Create a group in Outlook](https://support.microsoft.com/en-us/outlook/people/create-a-group-in-outlook) · [Add guests to a group](https://support.microsoft.com/en-us/outlook/people/adding-guests-to-groups-in-outlook)

## 2. Update the Digest Bot checkout and `.env`

SSH into the existing EC2 instance. Use the app directory from the original setup. The commands below use the `digest-bot-public` branch. Once the update is merged, use `main`.

```bash
cd ~/bond-sdc/bond-digest-bot
git status --short
git fetch origin
git switch digest-bot-public
git pull --ff-only
sudo nano .env
```

Keep `ACME_EMAIL` and set `DIGEST_GROUP_ADDRESS` to the actual email of the group from Step 1. Clean up old `DIGEST_AUTH_USER`, `DIGEST_AUTH_HASH`, `DIGEST_ALLOWED_RECIPIENTS` and `DIGEST_ALLOWED_RECIPIENT_DOMAINS` entries if present.

```dotenv
DIGEST_GROUP_ADDRESS=your-digest-group@bond.edu.au
```

Save in Nano with **Ctrl+O**, **Enter**, then **Ctrl+X**. Keep any existing SQLite files in `var/data`.

## 3. Check DNS, the EC2 security group and SES

### DNS and inbound mail

Reuse these records if you already set them up for the original mail deployment. At your DNS provider, create or verify them when needed.

| Record type | Name in `bond-sdc.com` | Value |
| --- | --- | --- |
| A | `mail` | Your existing EC2 Elastic IP. Use **DNS only** on Cloudflare. |
| MX | `inbox` | Priority `10`, target `mail.bond-sdc.com`. |

In the AWS Sydney region, open **EC2 → Instances → your instance → Security**. Open the attached security group and choose **Edit inbound rules**. Add **Custom TCP**, port **25**, source **Anywhere-IPv4** for inbound mail. Keep the existing SSH, HTTP and HTTPS rules and the existing A records for both sites. SES replies use the HTTPS API. [EC2 security groups](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html)

### Outgoing mail through Amazon SES

1. In **Amazon SES → Verified identities** in **Asia Pacific (Sydney)**, check that `bond-sdc.com` is **Verified**. If missing, create a domain identity with **Easy DKIM** and add its CNAME records to DNS.
2. Update the existing EC2 role’s SES permission with the [policy template](iam-ses-send.template.json). Replace `YOUR_AWS_ACCOUNT_ID`. The revised statement permits `ses:SendEmail` from `digest@bond-sdc.com` to any recipient. If you create a role, attach it in **EC2 → Instances → Actions → Security → Modify IAM role**.
3. In the EC2 metadata options, check **IMDSv2 required** and set **Metadata response hop limit** to `2` so the Docker container can use the role. In **SES → Account dashboard**, request production access in Sydney to send to any inbox. For a sandbox pilot, use an address you have already verified in SES.

[SES verified identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) · [SES sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) · [Attach a role to EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/attach-iam-role.html) · [Set EC2 metadata options](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html)

## 4. Start the automatic deployment

Run from the Digest Bot checkout with Docker Engine 26+ and Compose 2.39+. Use both Compose files for this deployment. Caddy obtains the certificate for `mail.bond-sdc.com` and Digest Bot starts its SMTP listener on port `25`.

```bash
cd ~/bond-sdc/bond-digest-bot
sudo install -d -m 0700 -o 1000 -g 1000 var/data
sudo docker compose -f compose.yaml -f compose.delivery.yaml config --quiet
sudo docker compose -f compose.yaml -f compose.delivery.yaml up -d --build --force-recreate --wait --wait-timeout 420
sudo docker compose -f compose.yaml -f compose.delivery.yaml ps
```

Check the DNS records and the local SMTP certificate. The MX response should be `10 mail.bond-sdc.com.` and the certificate check should show `Verification: OK`.

```bash
dig +short A mail.bond-sdc.com
dig +short MX inbox.bond-sdc.com
openssl s_client -starttls smtp -connect 127.0.0.1:25 \
  -servername mail.bond-sdc.com -verify_hostname mail.bond-sdc.com \
  -verify_return_error -brief </dev/null
```

## 5. Add the bot address and send one test digest

1. Add `digest@inbox.bond-sdc.com` to the group from Step 1. Confirm that the bot address is subscribed to receive group conversations by email. If guest membership needs redemption or subscription changes, ask Bond ITS to configure the group delivery or use an approved external mail contact.
2. Open Digest Bot in a private browser window and select **Automatic → Copy address**. No login is needed. In SharePoint, select **Email a news digest**, pick a couple of non-sensitive articles and paste the group address into **To**. Enter your usual title and send it. [Digest Bot](https://digest.bond-sdc.com/)
3. Check that mailbox for a single formatted email from `digest@bond-sdc.com`. Digest Bot uses the same default Staff News layout and Brisbane-date subject as Manual.

```bash
sudo docker compose -f compose.yaml -f compose.delivery.yaml logs --tail=80 digest-bot
```

| What you see | What to check |
| --- | --- |
| **Automatic delivery is not configured** | Start Compose with both files and check `DIGEST_GROUP_ADDRESS` in `.env`. |
| Nothing reaches the group or bot | Ask Bond ITS to trace the message to the group and the external member. Check that the guest can receive the group’s mail, that `inbox.bond-sdc.com` has the right MX target, and that inbound TCP `25` is open. |
| **Digest Bot could not authenticate the original sender** | Check the `Digest authentication rejected` log. It reports the From domain, SMTP envelope domain, DKIM selector results and SPF result. Inspect the final forwarded copy or ask Exchange administrators to trace it. |
| DKIM `none` or `domain-mismatch` and SPF `domain-mismatch` | Ask the outbound email administrator to sign the guest copy for the original From domain. The SPF result is bound to the SMTP envelope domain. |
| DKIM `body-changed` | Have the outbound gateway DKIM-sign the final message after it applies group footers, disclaimers or link rewriting. |
| DKIM `unsigned-mime-header` | Ask the outbound gateway to cover From, Content-Type and any Content-Transfer-Encoding header in its DKIM signature. |
| **Authenticated digest queued** followed by an SES error | Check the SES region, sender identity, role policy, sandbox status and metadata hop limit. |
| **Formatted digest accepted by SES** | Check the recipient’s inbox, Junk Email and Exchange quarantine. SES acceptance records a successful handoff. |

The bot replies to the authenticated `From` address. It records the Message-ID or verified signature key for seven days to suppress repeat deliveries, and clears the source content when a job reaches a final state. [Microsoft DKIM documentation](https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dkim-configure) · [Exchange message trace](https://learn.microsoft.com/en-us/exchange/monitoring/trace-an-email-message/message-trace-modern-eac)

## Pause automatic delivery

Use the base Compose file to return to manual formatting while keeping the queue and certificates on disk.

```bash
sudo docker compose up -d --build --force-recreate --wait
```

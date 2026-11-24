# Enable automatic digests on your existing EC2 server

Digest Bot v1.1.0 has **Manual** and **Automatic** tabs. Automatic displays the Microsoft 365 group address. A user sends a SharePoint news digest to the group and receives the formatted version in the same Bond inbox. The bot uses SQLite to track which messages it has processed.

| Address | Where to use it |
| --- | --- |
| Your Microsoft 365 group address | `DIGEST_GROUP_ADDRESS` in `.env`. The **Automatic** tab displays this address for SharePoint’s **To** field. |
| `digest@inbox.bond-sdc.com` | The bot’s fixed SMTP address. Add it as an external member of the group. |
| `digest@bond-sdc.com` | The address Amazon SES uses to send the formatted reply. |

The Microsoft community post demonstrates group delivery for an individual news post. Microsoft documents that group guests receive conversations by email. Test **Email a news digest** in the Bond tenant with non-sensitive articles. The group must deliver the digest externally and preserve the original sender with a verifiable DKIM signature from the sender’s domain. [Community example](https://techcommunity.microsoft.com/discussions/sharepoint_general/can-sharepoint-365-news-posts-be-emailed-to-external-users/4188247) · [Microsoft 365 group guests](https://support.microsoft.com/en-us/outlook/people/adding-guests-to-groups-in-outlook)

## 1. Set up a private Microsoft 365 group

1. Confirm Bond ITS approves delivering staff news to the EC2-hosted bot. In new Outlook, go to **Groups → New group** and create a **Private** group dedicated to this workflow. Copy the group’s actual email address. It needs to appear in SharePoint’s **To** picker.
2. Keep shared files and unrelated conversations out of this group. Add the bot address in Step 5, after the SMTP listener is ready. Your tenant must permit external membership. Bond ITS can advise whether to add the address as a guest or an external mail contact.

[Create a group in Outlook](https://support.microsoft.com/en-us/outlook/people/create-a-group-in-outlook) · [Add guests to a group](https://support.microsoft.com/en-us/outlook/people/adding-guests-to-groups-in-outlook)

## 2. Update the Digest Bot checkout and `.env`

SSH into the existing EC2 instance. Use the app directory from the original setup. The commands below use the v1.1.0 review branch. Once v1.1.0 is merged, switch to `main` and pull instead.

```bash
cd ~/bond-sdc/bond-digest-bot
git status --short
git fetch origin
git switch digest-bot-v1.1.0
git pull --ff-only
sudo nano .env
```

Keep the existing `ACME_EMAIL`, `DIGEST_AUTH_USER` and `DIGEST_AUTH_HASH` entries. Add or update the two lines below. Replace the first value with the actual email of the group from Step 1. Replace the second value with the Bond mailbox used to send your first test digest. You can use a comma-separated list of exact addresses when you add more approved senders.

```dotenv
DIGEST_GROUP_ADDRESS=your-digest-group@bond.edu.au
DIGEST_ALLOWED_RECIPIENTS=your.name@bond.edu.au
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

1. In **Amazon SES → Verified identities** in **Asia Pacific (Sydney)**, check that `bond-sdc.com` is **Verified**. If missing, create a domain identity with **Easy DKIM** and add its CNAME records to DNS. If SES is in the sandbox, also create a verified email identity for the exact Bond test mailbox in `.env`.
2. Reuse the existing EC2 IAM role if it already allows `ses:SendEmail` from `digest@bond-sdc.com` to that test mailbox. Otherwise, edit the role’s policy or create an EC2 role with the [policy template](iam-ses-send.template.json). Replace `YOUR_AWS_ACCOUNT_ID` and `YOUR_VERIFIED_RETURN_ADDRESS`. Attach it in **EC2 → Instances → Actions → Security → Modify IAM role**.
3. In the EC2 metadata options, check **IMDSv2 required** and set **Metadata response hop limit** to `2` so the Docker container can use the role. When adding more staff, add each address to both `.env` and the IAM policy. Verify those recipients in SES while in the sandbox.

[SES verified identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) · [SES sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) · [Attach a role to EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/attach-iam-role.html) · [Set EC2 metadata options](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html)

## 4. Start the automatic deployment

Run from the Digest Bot checkout with Docker Engine 26+ and Compose 2.39+. Use both Compose files for this deployment. Caddy obtains the certificate for `mail.bond-sdc.com` and Digest Bot starts its SMTP listener on port `25`.

```bash
cd ~/bond-sdc/bond-digest-bot
sudo install -d -m 0700 -o 1000 -g 1000 var/data
sudo docker compose -f compose.yaml -f compose.delivery.yaml config --quiet
sudo docker compose -f compose.yaml -f compose.delivery.yaml up -d --build --wait --wait-timeout 420
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
2. Open [Digest Bot](https://digest.bond-sdc.com/) and select **Automatic → Copy address**. In SharePoint, select **Email a news digest**, pick a couple of non-sensitive articles and paste the group address into **To**. Enter your usual title. Send from the Bond mailbox listed in `.env`.
3. Check that mailbox for a single formatted email from `digest@bond-sdc.com`. Digest Bot uses the same default Staff News layout and Brisbane-date subject as Manual.

```bash
sudo docker compose -f compose.yaml -f compose.delivery.yaml logs --tail=80 digest-bot
```

| What you see | What to check |
| --- | --- |
| **Automatic delivery is not configured** | Start Compose with both files and check `DIGEST_GROUP_ADDRESS` in `.env`. |
| Nothing reaches the group or bot | Ask Bond ITS to trace the message to the group and the external member. Check that the guest can receive the group’s mail, that `inbox.bond-sdc.com` has the right MX target, and that inbound TCP `25` is open. |
| **Original From address is not approved** | Ask Bond ITS to confirm the forwarded message still has the real Bond sender in its visible `From` header. The app matches that address to `.env`. |
| **Digest Bot could not verify the original sender with DKIM** | Ask Bond ITS to check whether the guest copy is signed for the original `From` domain and whether the group or a mail gateway modified the message after signing. Microsoft can rewrite the envelope sender during group forwarding. |
| **Authenticated digest queued** followed by an SES error | Check the SES region, verified identities, exact recipient in the role, sandbox status and metadata hop limit. |
| **Formatted digest accepted by SES** | Check the recipient’s inbox, Junk Email and Exchange quarantine. SES acceptance records a successful handoff. |

The bot replies to the authenticated `From` address. It verifies DKIM against public DNS, records signed Message-IDs for seven days to suppress repeat deliveries, and clears the source content when a job reaches a final state. The queue replaces mailbox read/unread flags in this SMTP setup. [Microsoft sender rewriting](https://learn.microsoft.com/en-us/exchange/mail-flow-best-practices/using-sender-rewriting-scheme) · [Microsoft DKIM documentation](https://learn.microsoft.com/en-us/defender-office-365/email-authentication-dkim-configure) · [Exchange message trace](https://learn.microsoft.com/en-us/exchange/monitoring/trace-an-email-message/message-trace-modern-eac)

## Pause automatic delivery

Use the base Compose file to return to manual formatting while keeping the queue and certificates on disk.

```bash
sudo docker compose up -d --build --force-recreate --wait
```

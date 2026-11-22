# Deploy Digest Bot and Service Desk Central on EC2

This setup uses one Ubuntu EC2 instance in Sydney. Nginx serves the landing page and protects Digest Bot with HTTPS and a login. Digest Bot receives SMTP on port 25, queues valid SharePoint messages, and delivers the formatted digest through Amazon SES over HTTPS. The site still supports manual `.eml` upload and download.

| Purpose | Address |
| --- | --- |
| Service Desk Central | `https://bond-sdc.com/` |
| Digest Bot | `https://digest.bond-sdc.com/` |
| Temporary SharePoint recipient | `digest-<request-id>@inbox.bond-sdc.com` |
| SMTP hostname | `mail.bond-sdc.com` |
| Automated From address | `digest@bond-sdc.com` |

## 1. Launch EC2 and allocate an Elastic IP

In the [EC2 console](https://console.aws.amazon.com/ec2/), select **Asia Pacific (Sydney)** (`ap-southeast-2`). Launch an **Ubuntu Server 24.04 LTS** x86_64 instance. A **t3.small** with a **20 GiB encrypted gp3** root volume is a reasonable starting point for the two sites and the mail queue. Use a public subnet with a route to an internet gateway.

Allocate and associate an **Elastic IP** with the instance. Use it as `YOUR_ELASTIC_IPV4` throughout this guide. In **Advanced details**, require **IMDSv2**, keep the metadata endpoint enabled, and set the metadata response hop limit to **2** so the app container can use the instance role.

Create or attach a security group with these IPv4 inbound rules. The default outbound rules work for setup and SES. [EC2 security group rules](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-rules-reference.html) · [Elastic IP addresses](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html) · [Instance metadata settings](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html)

| TCP port | Source | Use |
| --- | --- | --- |
| 22 | Your public IPv4 address with `/32` | SSH administration |
| 80 | `0.0.0.0/0` | Certificate validation and HTTP redirects |
| 443 | `0.0.0.0/0` | The websites |
| 25 | `0.0.0.0/0` | Incoming SMTP with STARTTLS |

The app's HTTP port 8080 listens on host loopback. Incoming mail uses port 25 and replies use the SES API over port 443. Your EC2 instance can keep AWS’s default outbound SMTP restriction. [AWS port 25 restrictions](https://repost.aws/knowledge-center/ec2-port-25-throttle)

## 2. Publish DNS records

Use the DNS provider for `bond-sdc.com`. If it is Cloudflare, set the A records to **DNS only**. Replace `YOUR_ELASTIC_IPV4` with the associated address. Start with a TTL of 300 seconds where supported.

| Type | Name | Value | When |
| --- | --- | --- | --- |
| A | `@` | `YOUR_ELASTIC_IPV4` | Before requesting certificates |
| A | `www` | `YOUR_ELASTIC_IPV4` | Before requesting certificates |
| A | `digest` | `YOUR_ELASTIC_IPV4` | Before requesting certificates |
| A | `mail` | `YOUR_ELASTIC_IPV4` | Before requesting certificates |
| MX | `inbox` | `mail.bond-sdc.com` with priority **10** | After the SMTP listener is running |
| CNAME | Three names supplied by SES | The matching targets supplied by SES | As part of the SES identity setup |

The MX record is for `inbox.bond-sdc.com`. The root domain can keep any existing mail records. SES handles the return path for outgoing mail. If you already have DNS records for the website hostnames, update them at cutover. [Cloudflare DNS proxy status](https://developers.cloudflare.com/dns/proxy-status/)

## 3. Set up SES and attach an EC2 role

1. In the [Amazon SES console](https://console.aws.amazon.com/ses/), stay in **Sydney** and choose **Verified identities → Create identity → Domain**. Enter `bond-sdc.com` and choose **Easy DKIM**. Publish the three displayed CNAMEs, then wait for identity verification.
2. For an initial sandbox test, add your return mailbox as a verified email address in Sydney and use its verification link. For use with other approved return mailboxes, choose **Account dashboard → Request production access**. Describe it as transactional mail sent to staff who request a digest, and include the handling of bounces and complaints in your request.
3. In Amazon SNS, create a Standard topic in Sydney and subscribe a monitored email address. Confirm the subscription. In SES, open the verified domain’s **Notifications** tab and set the feedback notifications for **Bounce** and **Complaint** to that topic. Review these notifications before resending to a failed address.
4. In IAM, create a role using the **EC2** use case and the `deploy/iam-ses-send.template.json` inline permissions policy. Replace `YOUR_AWS_ACCOUNT_ID` with your 12-digit AWS account ID. The policy permits sending from `digest@bond-sdc.com` to the `bond.edu.au` domain. Restrict its recipients further if you only need individual mailboxes. If you use a different return domain, update both the policy and the application allowlist.
5. Attach the instance profile from **EC2 → Instances → Actions → Security → Modify IAM role**. The SDK uses the role’s temporary credentials.

[SES domain verification](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) · [SES sandbox and production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) · [SES permissions](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html) · [Bounce and complaint notifications](https://docs.aws.amazon.com/ses/latest/dg/configure-sns-notifications.html) · [Attach an EC2 IAM role](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/attach-iam-role.html)

## 4. Install both applications on the instance

From your SSH client:

```bash
ssh -i ~/.ssh/bond-sdc.pem ubuntu@YOUR_ELASTIC_IPV4
```

Run the rest on EC2. The commands use Ubuntu’s Docker and Compose packages. If you already installed Docker from Docker’s apt repository, use its Compose plugin and omit `docker.io` and `docker-compose-v2` from the package list. [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates git nginx apache2-utils certbot dnsutils docker.io docker-compose-v2
sudo systemctl enable --now docker nginx

sudo git clone https://github.com/JModify/bond-digest-bot.git /opt/digest-bot
sudo git clone https://github.com/JModify/bond-service-desk-central.git /opt/service-desk-central
sudo install -d -m 0755 /var/www/service-desk-central /var/www/acme
sudo install -m 0644 /opt/service-desk-central/index.html /opt/service-desk-central/styles.css /opt/service-desk-central/network-switch.webp /opt/service-desk-central/service-desk-mark.svg /var/www/service-desk-central/

cd /opt/digest-bot
sudo install -m 0600 deploy/digest.env.example .env
sudoedit /opt/digest-bot/.env
sudo install -d -m 0700 -o 1000 -g 1000 /opt/digest-bot/var/data
```

In `.env`, replace `your.name@bond.edu.au` with the actual address you verified or want to allow. Use a comma-separated list for multiple exact mailboxes. Leave `DIGEST_ALLOWED_RECIPIENT_DOMAINS` blank for an exact allowlist. `DIGEST_SHAREPOINT_HOSTS` defaults to `bonduni.sharepoint.com` and can contain multiple exact hostnames.

Add a username and password for Digest Bot. `-c` creates the password file on the first run. Use `sudo htpasswd -B /etc/nginx/digest-users another-user` for extra users.

```bash
sudo htpasswd -cB /etc/nginx/digest-users josh
sudo chown root:www-data /etc/nginx/digest-users
sudo chmod 0640 /etc/nginx/digest-users
```

## 5. Issue certificates and start the service

Install the HTTP-only configuration first. Disable the stock Nginx site on a fresh dedicated instance by unlinking its enabled symlink, if present.

```bash
cd /opt/digest-bot
sudo install -m 0644 deploy/nginx-bootstrap.conf /etc/nginx/sites-available/bond-sdc
sudo ln -sfn /etc/nginx/sites-available/bond-sdc /etc/nginx/sites-enabled/bond-sdc
if [ -L /etc/nginx/sites-enabled/default ]; then sudo unlink /etc/nginx/sites-enabled/default; fi
sudo nginx -t
sudo systemctl reload nginx

sudo certbot certonly --webroot -w /var/www/acme --cert-name bond-sdc.com \
  -d bond-sdc.com -d www.bond-sdc.com -d digest.bond-sdc.com
sudo certbot certonly --webroot -w /var/www/acme --cert-name mail.bond-sdc.com \
  -d mail.bond-sdc.com

sudo install -m 0755 deploy/renew-certificates.sh /etc/letsencrypt/renewal-hooks/deploy/bond-sdc
sudo env RENEWED_LINEAGE=/etc/letsencrypt/live/mail.bond-sdc.com /etc/letsencrypt/renewal-hooks/deploy/bond-sdc
sudo docker compose up -d --build
curl --fail http://127.0.0.1:8080/healthz

sudo install -m 0644 deploy/nginx.conf /etc/nginx/sites-available/bond-sdc
sudo nginx -t
sudo systemctl reload nginx
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

The renewal hook reloads Nginx for the web certificate and copies the separate mail certificate into the container’s mounted directory before restarting the mail service. The SQLite queue persists across restarts. [Certbot webroot and renewal hooks](https://eff-certbot.readthedocs.io/en/stable/using.html#renewing-certificates)

## 6. Publish the inbox MX and test delivery

1. Add the `inbox` MX record from step 2 and confirm it resolves with `dig +short MX inbox.bond-sdc.com`. You can test SMTP TLS from an external connection that allows outbound port 25 with the command below.
2. Open `https://bond-sdc.com/` and `https://digest.bond-sdc.com/`. Use the Digest Bot username and password. Confirm the manual upload and both `.eml` downloads work.
3. Open **Digest editor** and save the subject preset. Go to **Email delivery**, enter your approved mailbox as **Return email address**, and select **Start email delivery**.
4. In SharePoint, choose **Email a news digest**, select articles, and paste the generated address into **To** and the generated code into **Title**. Send the digest and keep the page open or return to the same browser tab to check status. The request accepts one email and expires after two hours. Confirm your mailbox receives the formatted digest from `digest@bond-sdc.com`. For automated delivery, this configured SES identity takes precedence over the manual export’s From field.
5. For the first test, use non-sensitive articles and a mailbox you control. Check with Bond ITS that SharePoint/Exchange can send this digest to your external domain. If the picker or mail policy rejects the external address, use **Workspace** to upload the `.eml` while you confirm the permitted delivery route.

```bash
openssl s_client -starttls smtp -connect mail.bond-sdc.com:25 \
  -servername mail.bond-sdc.com -verify_hostname mail.bond-sdc.com -verify_return_error </dev/null
```

[Create and send a SharePoint news digest](https://support.microsoft.com/en-us/sharepoint/sites-pages/create-and-send-a-news-digest)

The landing page is deployed from its own repository. To connect the existing **SD Staff News Bot** card when you go live, edit `/var/www/service-desk-central/index.html`. Remove `tool-card-planned` from that card and replace its **Coming soon** button with:

```html
<a class="tool-action" href="https://digest.bond-sdc.com/">Open Digest Bot</a>
```

Make the same change in the landing page repository if you want it to persist when you redeploy its files.

## Updates and troubleshooting

```bash
cd /opt/digest-bot
sudo docker compose ps
sudo docker compose logs --tail=100 digest-bot
sudo git pull --ff-only
sudo docker compose up -d --build
```

| What you see | What to check |
| --- | --- |
| No connection on port 25 | Resolve the inbox MX and its target A, check the EC2 security group, and confirm the container started with its mail certificate. |
| SMTP rejects the address or title | Copy both values from a currently waiting request. A processed or expired address is closed. |
| Digest contains links outside the configured site | Confirm the hostname in the SharePoint article URLs and check `DIGEST_SHAREPOINT_HOSTS`. |
| SES rejects delivery | Check that the Sydney identity is verified, the instance role is attached, and the recipient is verified if the account is in the sandbox. |
| Amazon SES accepted the digest, but it hasn’t arrived | Check junk and any Exchange quarantine. Check SES delivery events or bounce notifications. |
| Delivery could not be confirmed | Check the inbox before starting another request. The worker avoids an automatic resend when SES might already have accepted it. |

The service accepts messages up to **10 MiB** for one-time recipients and uses a local queue under `/opt/digest-bot/var/data`. It clears the stored message body at terminal status and prunes completed request metadata after the expiry window plus 24 hours. Limit EC2 access and apply your data retention policy to any EBS backups. Both the queue and private SMTP key are outside the Git repository.

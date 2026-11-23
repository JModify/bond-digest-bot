# Deploy Service Desk Central and Digest Bot on AWS EC2

Run both apps on one Ubuntu server in **Asia Pacific (Sydney)** (`ap-southeast-2`). Docker Compose builds their images and starts them together. You’ll use the AWS console, your domain’s DNS settings and PowerShell on your computer.

| Container | What it does | Public address |
| --- | --- | --- |
| `service-desk-central` | Caddy serves the static site, obtains and renews TLS certificates, and forwards the password-protected Digest Bot website to its container. | `https://bond-sdc.com` and `https://www.bond-sdc.com` |
| `digest-bot` | Node.js serves the Digest Bot interface, receives SharePoint mail over SMTP, stores requests in SQLite and sends formatted replies through Amazon SES. | `https://digest.bond-sdc.com` via Caddy. Mail arrives at `mail.bond-sdc.com` on port `25`. |

Caddy publishes ports `80` and `443`. Digest Bot publishes port `25` for inbound mail. Its web server is reachable by Caddy over Docker’s private network. Caddy renews the mail certificate automatically, and Digest Bot loads the renewed certificate for new SMTP connections. The SQLite data lives in `var/data` on the server.

## Before you start

- Sign in to [AWS](https://console.aws.amazon.com/) with an administrator account. For a new AWS account, [set up MFA and an administrator sign-in](https://docs.aws.amazon.com/IAM/latest/UserGuide/getting-started-account-iam.html).
- Have access to the DNS settings for `bond-sdc.com` and a return email address you can verify for the first digest test.
- On Windows, check that `Get-Command ssh` works in PowerShell. Other systems with an SSH client can use the same Ubuntu commands after connecting.
- EC2, storage, public IPv4 and SES usage can incur charges. Check the [AWS Pricing Calculator](https://calculator.aws/) and [public IPv4 pricing](https://aws.amazon.com/vpc/pricing/).

## 1. Create the EC2 server

1. Open the [EC2 console](https://console.aws.amazon.com/ec2/) and select **Asia Pacific (Sydney)** in the region menu. Go to **Instances → Launch instances**.
2. Enter `bond-sdc` for the name. Choose **Ubuntu Server 24.04 LTS** from Canonical, **64-bit (x86)**, and instance type `t3.small`.
3. Under **Key pair**, choose **Create new key pair**. Name it `bond-sdc`, select **RSA** and **.pem**, and keep the downloaded `bond-sdc.pem` private. You’ll use it to sign in to Ubuntu.
4. Under **Network settings → Edit**, choose the default VPC and a default subnet. Enable **Auto-assign public IP**. Create a security group, which is the server’s AWS firewall, with the inbound rules below. Leave the default outbound rules in place.

| Type | Port | Source | Purpose |
| --- | --- | --- | --- |
| SSH | 22 | **My IP** | Your terminal |
| HTTP | 80 | **Anywhere-IPv4** | Certificate validation and redirects |
| HTTPS | 443 | **Anywhere-IPv4** | Both websites |
| Custom TCP | 25 | **Anywhere-IPv4** | Incoming SharePoint email |

5. Set storage to **20 GiB gp3** and enable encryption. Under **Advanced details**, enable the instance metadata service, select **V2 only (token required)** and set **Metadata response hop limit** to `2`. This lets the Digest Bot container obtain temporary SES credentials from the EC2 role.
6. Choose **Launch instance**. Wait for the instance to show **Running** and pass its status checks.
7. In the EC2 sidebar go to **Elastic IPs → Allocate Elastic IP address → Allocate**. Select the new address and choose **Actions → Associate Elastic IP address**. Pick the `bond-sdc` instance and choose **Associate**. Copy the Elastic IP. Use it for DNS and SSH so the address survives a stop and start of the instance.

[AWS launch settings](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-launch-parameters.html) · [Metadata options for containers](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-IMDS-new-instances.html) · [Elastic IPs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/working-with-eips.html)

## 2. Point the domains to EC2

At your DNS provider, add the following **A** records, each with your EC2 Elastic IP as the value. If a record already exists, update it when you’re ready for EC2 to take over that hostname. With Cloudflare, set these records to **DNS only**. If any of the four hostnames has an old **AAAA** record, clear it when cutting over to this IPv4-only server.

| Name | Full hostname | Value |
| --- | --- | --- |
| `@` | `bond-sdc.com` | EC2 Elastic IP |
| `www` | `www.bond-sdc.com` | EC2 Elastic IP |
| `digest` | `digest.bond-sdc.com` | EC2 Elastic IP |
| `mail` | `mail.bond-sdc.com` | EC2 Elastic IP |

The inbox MX record goes in Step 6, once Digest Bot can accept mail.

## 3. Connect and install Docker

In **Windows PowerShell**, run the commands below. Adjust the key path if you saved the file somewhere else.

```powershell
$Ec2Key = "$HOME\Downloads\bond-sdc.pem"
$Ec2Ip = Read-Host "Enter your EC2 Elastic IP"
ssh -i $Ec2Key "ubuntu@$Ec2Ip"
```

On first connection, check the host key fingerprint against **EC2 → Instances → your instance → Actions → Monitor and troubleshoot → Get system log**, then enter `yes` when the fingerprints match. After you see a prompt starting with `ubuntu@`, run the following in **Ubuntu over SSH**.

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 docker-buildx git dnsutils openssl nano
sudo systemctl enable --now docker
sudo docker version --format '{{.Server.Version}}'
sudo docker compose version
```

Use current Ubuntu 24.04 packages. The stack needs Docker Engine 26 or later and Compose 2.39 or later for the certificate mount. If your packages are older, use [Docker’s Ubuntu installation instructions](https://docs.docker.com/engine/install/ubuntu/).

[AWS SSH instructions](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-to-linux-instance.html) · [Ubuntu’s Compose package](https://packages.ubuntu.com/noble-updates/docker-compose-v2)

## 4. Enable outgoing email in Amazon SES

### Verify the sender and test mailbox

1. Open [Amazon SES](https://console.aws.amazon.com/ses/) in **Sydney**. Go to **Verified identities → Create identity → Domain**, enter `bond-sdc.com` and use **Easy DKIM**. After you create the identity, copy the three DKIM **CNAME** records SES shows into your DNS provider. Use **DNS only** for these CNAMEs on Cloudflare. Wait for the domain to show **Verified**. This authorises the sender `digest@bond-sdc.com`.
2. In **Verified identities**, create a second identity of type **Email address**. Enter your return email address and click the verification link SES sends you. A single verified test mailbox works in the Sydney SES sandbox.

### Give EC2 permission to send

1. Open [IAM](https://console.aws.amazon.com/iam/). Go to **Roles → Create role → AWS service → EC2** and choose the **EC2** use case. Continue without selecting a permissions policy. Name the role `BondDigestBotEc2Role` and create it.
2. Open the new role. In **Permissions**, choose **Add permissions → Create inline policy → JSON**. Paste the policy below. Replace `YOUR_AWS_ACCOUNT_ID` with your 12-digit account ID from the console account menu. Replace `YOUR_VERIFIED_RETURN_ADDRESS` with your verified return address in lowercase. Choose **Next**, name the policy `SendDigestEmail` and save it.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendDigestMail",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": "arn:aws:ses:ap-southeast-2:YOUR_AWS_ACCOUNT_ID:identity/bond-sdc.com",
      "Condition": {
        "StringEquals": { "ses:FromAddress": "digest@bond-sdc.com" },
        "ForAllValues:StringEquals": { "ses:Recipients": ["YOUR_VERIFIED_RETURN_ADDRESS"] },
        "Null": { "ses:Recipients": "false" }
      }
    }
  ]
}
```

3. In the EC2 console in Sydney, select `bond-sdc` and choose **Actions → Security → Modify IAM role**. Select `BondDigestBotEc2Role` and choose **Update IAM role**. Digest Bot uses this role to send via the SES HTTPS API.

[AWS sender identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html) · [SES permissions](https://docs.aws.amazon.com/ses/latest/dg/control-user-access.html) · [Attach a role to EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/attach-iam-role.html)

## 5. Configure and start both containers

Run these commands in the SSH terminal. They check out the `docker-ec2` branches. After both changes merge into `main`, you can omit `--branch docker-ec2` in both clone commands.

```bash
mkdir -p ~/bond-sdc
cd ~/bond-sdc
git clone --branch docker-ec2 https://github.com/JModify/bond-service-desk-central.git
git clone --branch docker-ec2 https://github.com/JModify/bond-digest-bot.git
cd bond-digest-bot
sudo install -d -m 0700 -o 1000 -g 1000 var/data
sudo install -m 0600 .env.example .env
sudo docker run --rm -it --entrypoint caddy caddy:2.11.9-alpine hash-password
```

Enter and confirm the web password you want for Digest Bot. Copy the resulting hash, which starts with `$2`. Open the settings file with `sudo nano .env` and fill it in as follows.

| Setting | Enter |
| --- | --- |
| `ACME_EMAIL` | Your email for the certificate account |
| `DIGEST_AUTH_USER` | Your web login username. The template uses `josh`. |
| `DIGEST_AUTH_HASH` | The hash you just copied, inside the existing single quotes |
| `DIGEST_ALLOWED_RECIPIENTS` | The same verified return address you put in the IAM policy |

In Nano, press **Ctrl+O**, **Enter**, then **Ctrl+X**. If you used the previous Nginx setup, see the migration note below before starting the stack.

Check that all four DNS names show your Elastic IP. Once they do, start both apps with Compose.

```bash
for host in bond-sdc.com www.bond-sdc.com digest.bond-sdc.com mail.bond-sdc.com; do
  printf '%s ' "$host"
  dig +short "$host" A
done

sudo docker compose config --quiet
sudo docker compose up -d --build --wait --wait-timeout 420
sudo docker compose ps
```

The first run builds both images and waits for the certificates. Expect two healthy services. Open [Service Desk Central](https://bond-sdc.com/) and [Digest Bot](https://digest.bond-sdc.com/). Use your web login for Digest Bot. For a quick test, open **Workspace**, upload a SharePoint `.eml` you can use for testing and check the preview and download.

## 6. Route SharePoint mail and test a digest

1. In the SSH terminal, check that the SMTP listener presents a valid certificate. Look for `Verification: OK`.

   ```bash
   openssl s_client -starttls smtp -connect 127.0.0.1:25 \
     -servername mail.bond-sdc.com -verify_hostname mail.bond-sdc.com \
     -verify_return_error -brief </dev/null
   ```

2. In DNS, add an **MX** record with name `inbox` (`inbox.bond-sdc.com`), priority `10` and target `mail.bond-sdc.com`. Run `dig +short MX inbox.bond-sdc.com` and look for `10 mail.bond-sdc.com.`.
3. In Digest Bot’s **Digest editor**, save a subject. Open **Email delivery**, enter your verified return address and click **Start email delivery**. Copy the generated **To** address and **Title** code.
4. In SharePoint, open the News section, choose **See all → Email a news digest**, select test articles and choose **Next**. Put the generated address in **To** and the code in **Title**, then send the digest. SharePoint needs to be allowed to mail the external inbox domain. You can use **Workspace** for manual `.eml` formatting if external delivery is blocked.
5. Check the status in Digest Bot, then check your mailbox for the formatted reply from `digest@bond-sdc.com`. A status that SES accepted the message means it was handed off for delivery.

[Microsoft’s SharePoint news digest instructions](https://support.microsoft.com/en-us/sharepoint/sites-pages/create-and-send-a-news-digest)

## Troubleshooting and updates

Run `sudo docker compose logs --tail=80` from `~/bond-sdc/bond-digest-bot` to see both services’ logs.

| Symptom | Check |
| --- | --- |
| Caddy stays unhealthy or a browser shows a certificate error | Check the four A records, the security group’s ports `80` and `443`, and `sudo docker compose logs service-desk-central`. |
| Digest Bot rejects the login | Check the username and the single-quoted hash in `.env`. Run `sudo docker compose up -d` after editing it. |
| Digest Bot keeps waiting for SharePoint mail | Check the MX target and inbound TCP `25`. Confirm you used the **To** address and **Title** code from the same request. |
| Digest Bot cannot send through SES | Check both verified identities in Sydney, the role on EC2, the exact return address in the policy and `.env`, and the metadata hop limit of `2`. |
| Compose reports a port is already in use | Check whether Nginx or the old Digest Bot container owns `80`, `443` or `25`. |

To deploy later code changes, pull both repos and recreate the containers. Compose preserves the certificate volumes and `var/data`.

```bash
cd ~/bond-sdc/bond-digest-bot
git -C ../bond-service-desk-central pull --ff-only
git pull --ff-only
sudo docker compose up -d --build --force-recreate --wait --wait-timeout 420
```

**Migrating from the previous guide.** On the existing EC2 server, complete Step 5 up to the first Compose start. Stop the old Digest Bot with `sudo docker compose --project-directory /opt/digest-bot stop digest-bot`, then copy its SQLite files with `sudo cp -a /opt/digest-bot/var/data/. var/data/` from the new checkout. If Nginx hosted just these two sites, disable it and the old Certbot timer with `sudo systemctl disable --now nginx certbot.timer`. Then start the new stack using Step 5. Reuse the existing Elastic IP, DNS records and SES role.

**Adding recipients later.** Add each address to the IAM `ses:Recipients` list and the comma-separated `DIGEST_ALLOWED_RECIPIENTS` setting, then run `sudo docker compose up -d`. Verify each new address in SES while in the sandbox. If you need to send to unverified recipients, see [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) and [bounce and complaint notifications](https://docs.aws.amazon.com/ses/latest/dg/configure-sns-notifications.html).

**Pausing or retiring the stack.** `sudo docker compose stop` pauses the apps and keeps the data. AWS can still charge for allocated resources. If you retire the server, back up `var/data` and your settings, then [terminate the instance](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/terminating-instances.html) and [release its Elastic IP](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/working-with-eips.html#using-instance-addressing-eips-releasing).

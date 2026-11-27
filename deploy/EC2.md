# Deploy Service Desk Central and Digest Bot on AWS EC2

Use one Ubuntu server in **Asia Pacific (Sydney)** (`ap-southeast-2`). Docker Compose builds and starts both apps.

| Container | What it does | Address |
| --- | --- | --- |
| `service-desk-central` | Caddy serves the static site, manages HTTPS and proxies the public Digest Bot site. | `https://bond-sdc.com` and `https://www.bond-sdc.com` |
| `digest-bot` | Node.js serves the formatter. Visitors format and download `.eml` files in their own browser. | `https://digest.bond-sdc.com` |

The default deployment uses **Other** processing with ports `80` and `443` for web traffic. Set `DIGEST_GROUP_ADDRESS` in `.env` to show the Microsoft 365 group on the public **Automatic** tab. [Enable Server processing](email-delivery.md) to add the fixed SMTP inbox and SES replies.

## 1. Launch the EC2 server

You’ll need an AWS administrator sign-in and access to DNS for `bond-sdc.com`. AWS charges can include the instance, disk and public IPv4 address. [AWS account setup](https://docs.aws.amazon.com/IAM/latest/UserGuide/getting-started-account-iam.html) · [Pricing calculator](https://calculator.aws/)

1. Open the [EC2 console](https://console.aws.amazon.com/ec2/), choose **Asia Pacific (Sydney)**, then go to **Instances → Launch instances**.
2. Name it `bond-sdc`. Choose **Ubuntu Server 24.04 LTS** from Canonical, **64-bit (x86)** and a `t3.small` instance.
3. Under **Key pair**, choose **Create new key pair**. Use the name `bond-sdc`, choose **RSA** and **.pem**, and keep `bond-sdc.pem` for SSH.
4. Under **Network settings → Edit**, select the default VPC and a default subnet. Enable **Auto-assign public IP**. Create a security group with the following inbound rules and leave the default outbound rules.

| Type | Port | Source | Purpose |
| --- | --- | --- | --- |
| SSH | `22` | **My IP** | Connect from your terminal |
| HTTP | `80` | **Anywhere-IPv4** | Certificate validation and redirects |
| HTTPS | `443` | **Anywhere-IPv4** | Both sites |

5. Choose a **20 GiB gp3** root disk with encryption enabled. Launch the instance and wait for the status checks to pass.
6. Go to **Elastic IPs → Allocate Elastic IP address → Allocate**. Select the IP and choose **Actions → Associate Elastic IP address**. Pick your `bond-sdc` instance and copy the associated address for DNS and SSH.

[AWS launch settings](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-launch-parameters.html) · [Elastic IPs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/working-with-eips.html)

## 2. Point the sites to EC2

At your DNS provider, add or update these **A** records with the EC2 Elastic IP. On Cloudflare, use **DNS only**. If these names have old **AAAA** records, remove them when switching over to this IPv4-only server.

| Record name | Full hostname |
| --- | --- |
| `@` | `bond-sdc.com` |
| `www` | `www.bond-sdc.com` |
| `digest` | `digest.bond-sdc.com` |

## 3. Connect and install Docker

Run this in **Windows PowerShell**, adjusting the key path if needed.

```powershell
$Ec2Key = "$HOME\Downloads\bond-sdc.pem"
$Ec2Ip = Read-Host "Enter your EC2 Elastic IP"
ssh -i $Ec2Key "ubuntu@$Ec2Ip"
```

On first connection, match the host key fingerprint against **EC2 → Instances → your instance → Actions → Monitor and troubleshoot → Get system log**. Once your terminal shows `ubuntu@`, run the following on the server.

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 docker-buildx git dnsutils nano
sudo systemctl enable --now docker
sudo docker compose version
```

[AWS SSH instructions](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-to-linux-instance.html) · [Docker’s Ubuntu installation instructions](https://docs.docker.com/engine/install/ubuntu/)

## 4. Configure the apps and start them

For a new installation, run the commands below. For an existing Compose installation, use [Update both sites](#update-both-sites) to retain the current settings.

```bash
mkdir -p ~/bond-sdc
cd ~/bond-sdc
git clone https://github.com/JModify/bond-service-desk-central.git
git clone https://github.com/JModify/bond-digest-bot.git
cd bond-digest-bot
sudo install -m 0600 .env.example .env
sudo nano .env
```

Set `ACME_EMAIL` to an email address you check. In Nano, press **Ctrl+O**, **Enter**, then **Ctrl+X** to save and exit.

Once the three DNS names resolve to the Elastic IP, run the following from `~/bond-sdc/bond-digest-bot`.

```bash
sudo docker compose config --quiet
sudo docker compose up -d --build --wait
sudo docker compose ps
```

Open Service Desk Central and Digest Bot. Caddy may take a few minutes to obtain the first HTTPS certificates. Check that anyone can open Digest Bot and that a saved SharePoint `.eml` formats and downloads. [Service Desk Central](https://bond-sdc.com/) · [Digest Bot](https://digest.bond-sdc.com/)

## Update both sites

These commands update a deployment using **Other**. For **Server** processing, follow the [upgrade steps](email-delivery.md#2-update-the-digest-bot-checkout-and-env) and include `compose.delivery.yaml`. If the admin host updater is installed, use [Site updates](admin.md#manage-the-sites). If you originally cloned the `docker-ec2` branches, switch both repositories to `main` before pulling.

```bash
cd ~/bond-sdc/bond-digest-bot
git -C ../bond-service-desk-central pull --ff-only
git pull --ff-only
sudo docker compose up -d --build --force-recreate --wait
sudo docker compose ps
```

The standard Compose command publishes only the web ports. It uses the existing `.env` and Caddy volumes. If the older mail setup created SQLite files under `var/data`, they stay on disk.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| HTTPS certificate error | Confirm the three A records and ports `80` and `443` in the EC2 security group. Run `sudo docker compose logs --tail=80 service-desk-central`. |
| Old Digest Bot password prompt | Check out the public release and recreate the Caddy container with the Compose files you use for deployment. |
| Port already in use | Check for an older web server on ports `80` or `443`. |
| Outlook drag doesn’t provide an email file | Open the message in new Outlook, choose **More actions → Save as**, then drag the saved `.eml` from its folder. |

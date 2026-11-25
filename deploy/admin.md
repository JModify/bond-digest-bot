# Service Desk Central administration

Open **Admin** on Service Desk Central to review Digest Bot mail, manage panel accounts and run maintenance. The owner starts as `jlavagna` and manages access from **Users** and **Roles**.

## Enable the panel on EC2

These commands use the existing `~/bond-sdc/bond-digest-bot` deployment and its sibling `bond-service-desk-central` checkout. Run them after both repositories contain the v1.1.0 changes.

```bash
cd ~/bond-sdc/bond-digest-bot
git pull --ff-only
git -C ../bond-service-desk-central pull --ff-only
sudo nano .env
```

Add `SDC_ADMIN_ENABLED=true` to the existing `.env`. If the name is already present, edit that entry. Leave the existing certificate contact and Microsoft 365 group values in place.

The host updater adds the **Pull latest and restart sites**, **Rebuild current code** and `.env` controls. Install it once on EC2 before starting Compose with its override.

```bash
sudo sh deploy/admin/install-updater.sh
sudo docker compose -f compose.yaml -f compose.delivery.yaml -f compose.updater.yaml up -d --build --force-recreate --wait --wait-timeout 420
sudo docker compose -f compose.yaml -f compose.delivery.yaml -f compose.updater.yaml exec -T digest-bot node server/admin/bootstrap.js
```

The final command prints the generated password to that terminal. Sign in at [bond-sdc.com/admin](https://bond-sdc.com/admin), then change it in **Account** or save it in your password manager. To recover access, run the same command with `--reset` after `bootstrap.js`. It issues a new password and revokes the owner's existing sessions.

For a panel without host maintenance, skip the installer and use `-f compose.yaml -f compose.delivery.yaml` in both Docker commands. For a manual-only installation, use `install-updater.sh manual` and omit `-f compose.delivery.yaml` from the Docker commands.

## Read the email history

Select an ID in **Email History** to open its timeline. **Subject** shows the subject of the formatted email once available. The incoming subject appears in the record details. Use the status filter and page links to find earlier entries. Times appear in Brisbane time.

| Status | What happened |
| --- | --- |
| Queued or Preparing | The bot accepted the SMTP message, or an operator queued an archived copy. |
| SMTP rejected or deferred | The bot replied with a 5xx or 4xx status after the incoming `DATA` command. The timeline includes the SMTP reply and authentication result when available. |
| Waiting to retry | SES throttled the request. The bot will retry after the recorded delay. |
| Failed | The bot could not format the digest or SES explicitly rejected the request. |
| Accepted by SES | AWS accepted the send request. Use the SES message ID for tracing. |
| Unconfirmed | The send ended without a reliable answer from SES. The worker avoids an automatic repeat. |

**Send a copy** takes one email address and queues the archived subject, body and inline images. Each resend gets its own record and points to the original. If a previous send is unconfirmed, check the recipient’s mailbox before resending.

The history and archived formatted messages live in `var/data/digest.sqlite`. Queue cleanup leaves that history in place. The upgrade imports metadata still present in the old queue. Entries already pruned and previously discarded message content cannot be reconstructed. Manual `.eml` formatting takes place in the browser, so it creates no server history. An SES acceptance does not establish inbox delivery.

Include `var/data/digest.sqlite` and the `bond-sdc_sdc-admin-data` Docker volume in your EC2 backup plan. Take a consistent SQLite or filesystem snapshot. The database contains staff email addresses and formatted email content, so restrict access to its copies and account for its disk growth.

## Manage access

**Viewer** starts with Email History and Digest Bot status. **Operator** also starts with resend access. In **Roles**, edit either role or add a new one by selecting its permissions. Assign roles in **Users**. Reassign their users before deleting a role.

Owner has every permission. People with **Role management** can edit roles and grant permissions they already have. **User management** lets people manage accounts whose roles they can assign.

## Manage the sites

- **Freeze** lets the active send finish and holds remaining jobs. Incoming SMTP can still queue mail while space is available. **Resume** starts processing the queue again.
- **Careers at Bond** appends the article to automatic Staff News emails formatted on the selected day in Brisbane time. Wednesday is the default. **Save schedule** takes effect for newly formatted digests and records the change in **Admin Activity**. Use **Manage Careers at Bond schedule** in **Roles** to grant access.
- **Pull latest and restart sites** fetches and fast-forwards both `main` checkouts, builds both images and waits for Compose startup checks. It stops if a checkout has tracked changes, uses a different remote or cannot fast-forward.
- **Save .env** updates the certificate contact, digest group address and reboot instance ID. The host validates the resulting Compose configuration before replacing the file. **Rebuild current code** applies the saved values from your existing checkouts.
- **Reload values from EC2** refreshes the three fields after an edit in the terminal.

Check **Admin Activity** under **System** for the latest 20 events. Site updates and rebuilds log the request and its final result, including failure details. For more detail on a failed request, inspect `sudo journalctl -u bond-sdc-admin.service -n 60 --no-pager`. If the host updater itself changes in a later release, rerun its installer from the new checkout.

If the updater reports local changes, use `git status --short --untracked-files=no` in the named checkout. Review those changes and preserve any deployment settings before cleaning the checkout and retrying. The updater checks both repositories before advancing either checkout or rebuilding the services.

The panel submits fixed requests to a host `systemd` service. The container can write a request and read its result. The host holds the Docker access and only shares the three editable settings with the panel.

## Enable EC2 reboot

1. Add [the instance-scoped policy](admin/iam-reboot-instance.template.json) to the existing EC2 IAM role. Fill in the AWS account and instance IDs and confirm the region. `RebootInstances` queues the reboot request in AWS. [AWS API reference](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_RebootInstances.html)
2. Set `SDC_ADMIN_EC2_INSTANCE_ID` in `.env` or save it under **System → Environment settings**. Select **Rebuild current code** under **System → Site updates** to apply it. From the terminal, `docker compose up` recreates the container with its updated environment. `docker compose restart` reuses its existing environment.
3. Confirm `sudo systemctl is-enabled docker` prints `enabled` so the Compose restart policy can bring the containers up after reboot. Open **System**, type `REBOOT` and select **Reboot EC2** when you are ready for a brief outage.

If the setup message still appears, check the running container from the Digest Bot checkout. This prints only the instance ID, or `(unset)`.

```bash
sudo docker compose -f compose.yaml -f compose.delivery.yaml -f compose.updater.yaml exec -T digest-bot \
  node -p 'process.env.SDC_ADMIN_EC2_INSTANCE_ID?.trim() || "(unset)"'
```

If `.env` has an admin-managed settings block at the end, set the instance ID in that block. Compose uses its value when the same key appears earlier. The reboot form appears once the running container loads the ID. AWS evaluates the instance role's reboot permission when it receives the request.

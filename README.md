# Digest Bot v1.1.3

Digest Bot formats SharePoint news digests in the Bond Staff News layout with a Brisbane-date subject.

- **Automatic.** Digest Bot opens on this tab. Copy the Microsoft 365 group address and use it in SharePoint’s **To** field. The group forwards the digest to the bot, and Amazon SES sends the formatted reply to the original sender.
- **Manual.** Send the digest to your inbox. In Outlook, choose **More actions → Save as** and drop the `.eml` into Digest Bot. Download the formatted file, open it in Outlook and choose **Forward**. The browser processes the file locally. The download sets the From header to `bondstaffnews@bond.edu.au` and leaves the recipient blank.

Both tabs are public. Automatic replies use the original From address after a passing, domain-aligned DKIM or SPF check.

- [How Digest Bot works](docs/how-it-works.md) shows the two workflows and the automatic delivery flow.
- [Code map](docs/code-map.md) shows which files work together and where to make common changes.
- [Data model](docs/data-model.md) diagrams the two SQLite databases.
- [Opening a saved .eml in new Outlook](https://support.microsoft.com/en-us/outlook/mail/open-eml-msg-and-oft-files-in-new-outlook-and-outlook-on-the-web)

## Deploy and test

Follow the [EC2 setup guide](deploy/EC2.md) to run Service Desk Central and Digest Bot with Docker Compose. See [Enable automatic digests on EC2](deploy/email-delivery.md) for the Microsoft 365 group, DNS, SES and upgrade steps. Automatic delivery is enabled by adding `compose.delivery.yaml` to the Compose command.

The [Service Desk Central administration guide](deploy/admin.md) covers the private email history, resends and EC2 maintenance controls.

Install dependencies with `npm ci` on Node.js 24+. Run `npm start` and open `http://localhost:8080/#manual` to use the manual formatter locally. Run `npm test` to exercise the manual export, HTTP and signed SMTP flow with an in-process mail transport.

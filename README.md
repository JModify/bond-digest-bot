# Digest Bot v1.1.2

Digest Bot formats SharePoint news digests in the Bond Staff News layout with a Brisbane-date subject.

- **Manual.** Send a SharePoint news digest to your inbox. In Outlook, choose **More actions → Save as** and drop the `.eml` into Digest Bot. Download the formatted email, open it in Outlook and choose **Forward**. The file sets the From header to `bondstaffnews@bond.edu.au` and leaves the recipient blank. The browser processes the file locally.
- **Automatic.** Copy the Microsoft 365 group address from the **Automatic** tab and use it in SharePoint’s **To** field. The group forwards the email to the bot’s fixed SMTP address. Digest Bot accepts authenticated senders from any domain, formats the digest and replies through Amazon SES.

Both tabs are public. Automatic replies use the original From address after a passing, domain-aligned DKIM or SPF check.

[Opening a saved .eml in new Outlook](https://support.microsoft.com/en-us/outlook/mail/open-eml-msg-and-oft-files-in-new-outlook-and-outlook-on-the-web)

## Deploy and test

Follow the [EC2 setup guide](deploy/EC2.md) to run Service Desk Central and Digest Bot with Docker Compose. See [Enable automatic digests on EC2](deploy/email-delivery.md) for the Microsoft 365 group, DNS, SES and upgrade steps. Automatic delivery is enabled by adding `compose.delivery.yaml` to the Compose command.

To run the manual formatter locally, use `npm start` on Node.js 24+ and open `http://localhost:8080`. Run `npm ci` and `npm test` to exercise the manual export, HTTP and signed SMTP flow. Tests use an in-process mail transport.

# Digest Bot v1.0.4

Digest Bot formats SharePoint news digests in the Bond Staff News layout.

1. In SharePoint, choose **Email a news digest** and send it to your Bond inbox.
2. In new Outlook, save the received message with **More actions → Save as**. Drop the `.eml` file into Digest Bot or choose it with the file picker.
3. Choose **Download .eml**, open the file in Outlook and select **Forward**. The file has `bondstaffnews@bond.edu.au` as its From header and leaves the recipient blank. Select a sender and recipients in Outlook as needed.

The standard layout and Brisbane-date subject apply to every file. The browser reads and formats the email locally. [Opening a saved .eml in new Outlook](https://support.microsoft.com/en-us/outlook/mail/open-eml-msg-and-oft-files-in-new-outlook-and-outlook-on-the-web)

## Deploy and test

Follow the [EC2 setup guide](deploy/EC2.md) to run Service Desk Central and Digest Bot with Docker Compose. To run Digest Bot on its own, use `npm start` on Node.js 24+ and open `http://localhost:8080`.

Run `npm ci` and `npm test` to exercise the manual export, HTTP and retained email-delivery flows. The tests use an in-process delivery transport.

[Email delivery infrastructure](deploy/email-delivery.md) is retained for future use and disabled in the standard deployment.

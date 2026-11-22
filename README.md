# Digest Bot v1.0.3

Digest Bot formats SharePoint news emails using the Bond Staff News layout.

- **Email delivery.** Save the subject preset, enter the return address, then copy the temporary address and title into SharePoint. Digest Bot receives the message via SMTP and sends the formatted digest back through Amazon SES.
- **Workspace.** Upload a SharePoint `.eml` to preview and download it as a viewing copy or as an editable Outlook draft. The manual From and To settings apply to these downloads.

## Deploy and test

Follow the [EC2 setup guide](deploy/EC2.md) to deploy Digest Bot at `digest.bond-sdc.com`, serve Service Desk Central on the same instance, and configure DNS, HTTPS and SES.

Run `npm ci` and `npm test` with Node.js 24+ to exercise the HTTP, SMTP, processing and export flows. The tests use an in-process delivery transport. To test just the manual interface, serve the `dist/` directory with a static web server.

## Formatting pipeline

The browser workspace and mail worker share the parser, preset and email renderer in `dist/core/`. The EC2 process stores time-limited requests and queued messages in SQLite. The outgoing mail adapter uses the EC2 instance role.

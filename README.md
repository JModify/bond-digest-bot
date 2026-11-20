# Digest Bot v1.0.2

Digest Bot is a standalone website for styling SharePoint news digest emails. Choose or drop a SharePoint `.eml` file, then download it in the Bond Staff News format.

The Digest editor lets you change the subject and the From and To addresses. The default subject inserts the current Brisbane date. From defaults to `bondstaffnews@bond.edu.au`. To picks up the uploaded email’s sender unless you save a custom address. Clear the custom address to restore autofill.

Choose **Download .eml** to open the formatted message for viewing. Choose **Download editable draft** to compose and send it in Outlook. Outlook can apply a signature when it opens a draft. To turn that off, change the default signature for new messages in Outlook.

## Run locally

Serve the static files using any HTTP server. From the repository root:

```sh
python3 -m http.server --bind 127.0.0.1 --directory dist 8000
```

Open `http://127.0.0.1:8000` in a browser.

## Formatting pipeline

- `dist/app.js` handles browser interactions and preset storage.
- `dist/core/digest.js` exposes `readDigest(bytes, document)` and `formatDigest(digest, preset, date, logo, { editable })`. The first uses a DOM-compatible document to extract SharePoint articles. The second serializes the formatted digest as a MIME email with the supplied logo embedded.
- `dist/core/preset.js` defines the preset schema and defaults. `dist/core/render.js` renders the fixed Bond Staff News template and produces HTML and plain-text versions.

A future mail service can pass received email bytes and a stored preset through the same pipeline, then hand the output to its mail transport.

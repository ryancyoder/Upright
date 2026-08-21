# Upright — Site Session

iPad field tool for Ricci's Landscape Management (Hebron, IN).

Single-file web app. No build step, no dependencies to install — `index.html`
is the entire application. Leaflet and JSZip load from CDN at runtime.

## Running locally

Open `index.html` over `https://` or `localhost` (camera, microphone, geolocation
and device-orientation APIs all require a secure context):

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

On device, open in **real Safari** — not an in-app browser — then Add to Home
Screen. Camera-permission failures almost always trace back to an in-app
chat browser.

## Deploy

Connected to Vercel. Push to this repo deploys; do not hand-paste the file
into a deploy tool.

## Architecture, conventions, and open items

See [`CLAUDE.md`](CLAUDE.md).

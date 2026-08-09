# LysiPOS — SaaS · CRM · POS (installable PWA)

A single-page, offline-first Progressive Web App that bundles a Point of Sale, a lightweight CRM, and small-business admin (users/roles, reports, backups). Vanilla JS, no build step, no server.

## Run it

Because the app uses ES modules and registers a service worker, serve the folder over HTTP — don't open `index.html` from `file://`.

```bash
# Python 3
python -m http.server 8080

# or Node
npx http-server -p 8080 -c-1
```

Then open http://localhost:8080

## First sign-in

- Email: `admin@lysipos.local`
- Password: `admin123`

Change it right away in **Users**.

## Install as an app

- Desktop Chrome/Edge/Brave: click the install icon in the address bar, or the **⤓ Install App** button in the sidebar.
- iOS Safari: Share → Add to Home Screen.
- Android Chrome: ⋮ menu → Install app.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell |
| `app.js` | All app logic (router, DB, POS, CRM, reports, settings) |
| `styles.css` | Theme + layout (dark/light) |
| `manifest.json` | PWA manifest |
| `sw.js` | Service worker (offline cache) |
| `icon.svg` / `icon-maskable.svg` | App icons |
| `manual.html` | Full user manual (also linked from the sidebar) |

## Data

Everything lives in your browser's IndexedDB (`lysipos` database). Back it up from **Settings → Data → Export backup (JSON)**. Restore or wipe from the same panel.

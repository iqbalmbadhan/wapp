# TrackWapp Web

A live WhatsApp **presence monitor** — a web dashboard that shows when watched
contacts come online / go offline, logs each session, and exports the history
to styled **Excel** workbooks (one sheet per person).

It reworks the old TrackWapp extension/desktop app into a single Node/TypeScript
service. Instead of injecting scripts into WhatsApp Web, it speaks the WhatsApp
multi-device protocol directly with [Baileys](https://github.com/WhiskeySockets/Baileys),
subscribes to presence, and streams events to the browser over WebSocket.

> **Use responsibly.** Only watch numbers that are yours or that belong to people
> who know and have agreed to it. Monitoring someone without their consent may
> breach WhatsApp's Terms of Service and local privacy law. This project is for
> educational and self-/consenting-monitoring use.

## Stack

| Layer | Choice |
|------|--------|
| WhatsApp session | `@whiskeysockets/baileys` (no browser, protocol-level) |
| Server / API | Express + `ws` WebSocket |
| Storage | JSON file (zero dependencies) |
| Excel export | `exceljs` (summary sheet + per-person sheet) |
| Frontend | static dashboard (GSAP animations, QR login) |

## Architecture

```
WhatsApp  ──presence──►  Baileys (src/wa.ts)
                              │ emits online/offline
                              ▼
            SQLite (src/db.ts) ◄── sessions logged
                              │
            Express + ws (src/server.ts)
               │  REST /api/*          │ WebSocket (live events)
               ▼                       ▼
            public/index.html  ── the dashboard
```

One linked WhatsApp account per running instance. Scaling to many accounts means
running one supervised worker per account; this scaffold covers a single account,
which fits family / self-monitoring.

## Setup

```bash
cd trackwapp-web
cp .env.example .env        # optional, defaults are fine
npm install                 # builds better-sqlite3 (needs build tools)
npm run dev                 # ts-node; or: npm run build && npm start
```

Then:

1. Open **http://localhost:3000**.
2. A QR appears on the page (and in the terminal). On your phone open
   **WhatsApp → Linked devices → Link a device** and scan it.
3. Once linked, the banner turns green. Add a contact by **name + number with
   country code** (e.g. `918115168763`) and the card goes live.
4. Click a card for the **details view**: 24-hour timeline, session history,
   stats, and a per-person **Download Excel** button. The header **Excel** button
   exports everyone (summary + one sheet per person).

The linked session is stored in `auth/` and the logs in `trackwapp.json` — both are
gitignored. Delete `auth/` to unlink.

## How presence works (and its limits)

WhatsApp only pushes presence while you are actively **subscribed** to a contact,
so `src/wa.ts` re-subscribes every 10s. You see a contact's online/offline only
while this service is running and linked. If a contact has "last seen / online"
hidden in their privacy settings, WhatsApp may not report their presence at all —
that's a platform limit, not a bug here.

## API

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/state` | all contacts + today's stats + connection |
| POST | `/api/contacts` | `{name, number}` → watch a contact |
| DELETE | `/api/contacts/:id` | stop watching |
| GET | `/api/contacts/:id/sessions` | today's sessions for one contact |
| GET | `/api/contacts/:id/export.xlsx` | per-person Excel |
| GET | `/api/export.xlsx` | all contacts, summary + per-person sheets |

## Notes

- `markOnlineOnConnect` is off so linking this does **not** flip your own phone
  to "online".
- Sessions are logged on the online→offline transition. A still-open session is
  shown live in the UI and included in exports as a `— live —` row.

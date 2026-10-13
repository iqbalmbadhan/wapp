# Hosting TrackWapp for free

This app is **not** a normal website. It holds a **permanent live connection** to
WhatsApp and must keep **state on disk** (the linked session in `auth/` and the
log in `trackwapp.db`). That rules out the usual "free" web tiers:

- **Vercel / Netlify / Cloudflare Pages** — serverless. They can't keep a
  long-lived socket open. ❌ won't work.
- **Render / Railway free web service** — sleeps after idle and gives you no
  persistent disk on the free plan. A sleeping instance drops the WhatsApp link
  and loses `auth/`. ❌ not suitable.

What you actually need is **one small always-on process with a little persistent
disk**. Three genuinely free ways to get that, best first:

---

## Option A — Your own always-on machine (best for family use)

A spare laptop, a mini PC, or a Raspberry Pi you leave on. Free, and the data
(who's online, the session) never leaves your home.

```bash
# one-time
npm install
npm run build

# keep it running across reboots with pm2
npm install -g pm2
DASH_PASSWORD='choose-a-strong-pass' pm2 start dist/server.js --name trackwapp
pm2 save
pm2 startup        # follow the printed command so it starts on boot
```

Open `http://localhost:3000` on that machine and link WhatsApp once.

**Reach it from your phone/elsewhere** without opening ports, using a free
Cloudflare Tunnel:

```bash
# install cloudflared, then:
cloudflared tunnel --url http://localhost:3000
```

It prints a public `https://…trycloudflare.com` URL. **Always set `DASH_PASSWORD`
before exposing it** — otherwise anyone with the link sees your contacts' activity.

---

## Option B — Oracle Cloud "Always Free" VM (free 24/7 server)

Oracle's Always Free tier includes a small ARM VM that runs continuously at no
cost — a good fit for a always-on service.

1. Create an **Always Free** Ampere (ARM) VM, Ubuntu 22.04.
2. Install Node 20 and build tools:
   ```bash
   sudo apt update && sudo apt install -y nodejs npm build-essential python3
   ```
3. Copy this folder up (`scp -r trackwapp-web ubuntu@<ip>:~/`), then:
   ```bash
   cd trackwapp-web
   npm install && npm run build
   npm install -g pm2
   DASH_PASSWORD='strong-pass' PORT=3000 pm2 start dist/server.js --name trackwapp
   pm2 save && pm2 startup
   ```
4. Link WhatsApp: the QR prints in the terminal (`pm2 logs trackwapp`), or open
   the dashboard through a Cloudflare Tunnel as in Option A.
5. Open port 3000 only behind the tunnel + password; don't expose it raw.

---

## Option C — Fly.io with a volume

Fly runs a tiny always-on machine and gives you a persistent volume. It needs a
card on file but has a small free allowance that this fits in. A `Dockerfile` and
`fly.toml` are included.

```bash
fly launch --no-deploy          # accept the included fly.toml, pick a name
fly volume create data --size 1 # 1 GB persistent disk for auth/ + db
fly secrets set DASH_PASSWORD='strong-pass'
fly deploy
fly logs                        # scan the QR shown here to link WhatsApp
```

`fly.toml` mounts the volume at `/data` and points `AUTH_DIR` and `DB_FILE` there,
so your session and logs survive restarts and deploys.

---

## Must-dos before any remote hosting

- **Set `DASH_PASSWORD`.** The dashboard shows people's real activity; never put
  it on a public URL without the password.
- **Keep `auth/` private.** It is a live WhatsApp login. Anyone who copies it can
  act as your linked device. It's gitignored — keep it that way.
- **One account per instance.** This scaffold links one WhatsApp account. To watch
  from several accounts, run one instance each (separate `AUTH_DIR`/`DB_FILE`).
- **Consent.** Only host this to watch your own numbers or people who agreed.

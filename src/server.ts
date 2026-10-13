import express from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { DB, dayStart, Contact, Session } from './db';
import { WhatsApp } from './wa';
import { buildWorkbook } from './xlsx';

const PORT = Number(process.env.PORT || 3000);
const app = express();

// Health check — always 200, before any auth, so Fly/uptime checks pass.
app.get('/healthz', (_req, res) => res.json({ ok: true, connected: wa.connected }));

// Optional password gate — set DASH_PASSWORD before exposing this to the internet.
const PASS = process.env.DASH_PASSWORD;
if (PASS) {
  app.use((req, res, next) => {
    const [, b64] = (req.headers.authorization || '').split(' ');
    const [, pw] = Buffer.from(b64 || '', 'base64').toString().split(':');
    if (pw === PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="TrackWapp"').status(401).send('Authentication required');
  });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const wa = new WhatsApp();

function broadcast(msg: any) {
  const data = JSON.stringify(msg);
  wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.send(data));
}

// --- relay WhatsApp presence events to all browsers ---
wa.on('online', (e) => broadcast({ type: 'online', ...e }));
wa.on('offline', (e) => broadcast({ type: 'offline', ...e }));
wa.on('status', (s) => broadcast({ type: 'status', ...s }));
wa.on('qr', (qr) => broadcast({ type: 'qr', qr }));

// --- helpers ---
function statsFor(c: Contact) {
  const sessions = DB.sessions(c.id, dayStart());
  const since = wa.liveSinceFor(c.id);
  const liveMs = since ? Date.now() - since : 0;
  const msToday = sessions.reduce((a, s) => a + s.dur_ms, 0) + liveMs;
  const longest = Math.max(liveMs, ...sessions.map((s) => s.dur_ms), 0);
  return {
    online: since != null,
    sinceMs: since,
    sessions: sessions.length + (since ? 1 : 0),
    msToday,
    longest,
  };
}
function contactState(c: Contact) {
  return { id: c.id, name: c.name, number: c.number, ...statsFor(c) };
}

// --- REST API ---
app.get('/api/status', (_req, res) => {
  res.json({ connected: wa.connected, user: wa.user, qr: wa.lastQR });
});

app.post('/api/logout', (_req, res) => {
  wa.logout();
  res.json({ ok: true });
});

app.get('/api/state', (_req, res) => {
  res.json({
    connected: wa.connected,
    user: wa.user,
    qr: wa.lastQR,
    contacts: DB.listContacts().map(contactState),
  });
});

app.post('/api/contacts', (req, res) => {
  const { name, number } = req.body || {};
  const digits = String(number || '').replace(/[^\d]/g, '');
  if (!name || !digits || digits.length < 7) {
    return res.status(400).json({ error: 'Give a name and a full number with country code.' });
  }
  if (DB.getByNumber(digits)) return res.status(409).json({ error: 'That number is already watched.' });
  const c = DB.addContact(name, digits);
  wa.watch(c);
  broadcast({ type: 'added', contact: contactState(c) });
  res.json({ contact: contactState(c) });
});

app.delete('/api/contacts/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!DB.getContact(id)) return res.status(404).json({ error: 'Not found' });
  DB.removeContact(id);
  broadcast({ type: 'removed', id });
  res.json({ ok: true });
});

app.get('/api/contacts/:id/sessions', (req, res) => {
  const id = Number(req.params.id);
  const c = DB.getContact(id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const sessions: Session[] = DB.sessions(id, dayStart());
  res.json({ contact: contactState(c), sessions });
});

// --- Excel export (real .xlsx download) ---
function sendWorkbook(res: express.Response, contacts: Contact[], filename: string) {
  const stats: Record<number, any> = {};
  contacts.forEach((c) => (stats[c.id] = statsFor(c)));
  buildWorkbook(
    contacts,
    (id) => DB.sessions(id, dayStart()),
    (c) => wa.liveSinceFor(c.id),
    stats
  )
    .then((buf) => {
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buf);
    })
    .catch((e) => res.status(500).json({ error: String(e) }));
}
const stamp = () => new Date().toISOString().slice(0, 10);

app.get('/api/export.xlsx', (_req, res) => {
  sendWorkbook(res, DB.listContacts(), `trackwapp_all_${stamp()}.xlsx`);
});

app.get('/api/contacts/:id/export.xlsx', (req, res) => {
  const c = DB.getContact(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Not found' });
  const safe = c.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  sendWorkbook(res, [c], `trackwapp_${safe}_${stamp()}.xlsx`);
});

// --- new browser gets the current snapshot ---
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', connected: wa.connected, user: wa.user, qr: wa.lastQR, contacts: DB.listContacts().map(contactState) }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nTrackWapp dashboard → http://localhost:${PORT}\n`);
  wa.start().catch((e) => console.error('WhatsApp start failed:', e));
});

import { EventEmitter } from 'events';
import fs from 'fs';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { DB, Contact } from './db';

/**
 * Manages one linked WhatsApp account and tracks the presence
 * (online / offline) of the watched contacts.
 *
 * Modern WhatsApp delivers presence under a contact's LID (`<n>@lid`),
 * not their phone-number JID (`<n>@s.whatsapp.net`). We resolve each
 * contact's LID with onWhatsApp() and match presence on either id.
 *
 * Events:
 *   'qr'      (string)                 - QR to scan
 *   'status'  ({connected, user})      - connection state changed
 *   'online'  ({number, sinceMs})      - contact came online
 *   'offline' ({number, sinceMs, endMs, durMs, contactId, sessionId})
 */
export class WhatsApp extends EventEmitter {
  private sock: any = null;
  private authDir = process.env.AUTH_DIR || 'auth';
  private logger = pino({ level: 'silent' });
  private liveSince = new Map<number, number>(); // contactId -> online since (ms)
  public connected = false;
  public user: string | null = null;
  public lastQR: string | null = null;
  private resubTimer: NodeJS.Timeout | null = null;
  private dbg = !!process.env.DEBUG_PRESENCE;

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: this.logger,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (u: any) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        this.lastQR = qr;
        this.emit('qr', qr);
        console.log('\nScan this QR with WhatsApp > Linked devices:\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        this.connected = true;
        this.lastQR = null;
        this.user = this.sock?.user?.id?.split(':')[0] || null;
        console.log(`\n✓ Linked as ${this.user}. Monitoring presence.\n`);
        this.emit('status', { connected: true, user: this.user });
        // Must appear "available" to be sent other contacts' presence.
        try { this.sock.sendPresenceUpdate('available'); } catch (e) {}
        this.subscribeAll();
        this.startResubLoop();
      }

      if (connection === 'close') {
        this.connected = false;
        this.emit('status', { connected: false, user: this.user });
        const code = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        console.log(`Connection closed (code ${code}).`, loggedOut ? 'Logged out.' : 'Reconnecting…');
        if (!loggedOut) setTimeout(() => this.start().catch(console.error), 2500);
      }
    });

    this.sock.ev.on('presence.update', (update: any) => this.onPresence(update));
  }

  private startResubLoop() {
    if (this.resubTimer) clearInterval(this.resubTimer);
    this.resubTimer = setInterval(() => this.subscribeAll(), 10_000);
  }

  async subscribeAll() {
    if (!this.sock || !this.connected) return;
    // stay "available" so WhatsApp keeps pushing watched contacts' presence
    try { this.sock.sendPresenceUpdate('available'); } catch (e) {}
    for (const c of DB.listContacts()) {
      await this.ensureLid(c);
      this.subscribe(c.jid);
      if (c.lid) this.subscribe(c.lid);
    }
  }

  /** Look up a contact's LID so we can match presence that arrives under it. */
  private async ensureLid(c: Contact) {
    if (c.lid || !this.sock) return;
    try {
      const results = await this.sock.onWhatsApp(c.number);
      const r = Array.isArray(results) ? results.find((x: any) => x && x.exists !== false) || results[0] : results;
      if (r?.lid) {
        DB.setLid(c.id, String(r.lid));
        if (this.dbg) console.log(`[lid] ${c.number} -> ${r.lid}`);
      } else if (this.dbg) {
        console.log(`[lid] ${c.number} -> none (onWhatsApp: ${JSON.stringify(r)})`);
      }
    } catch (e) {
      if (this.dbg) console.log('[lid] lookup failed for', c.number, String(e));
    }
  }

  /** resolve LID then subscribe (used when a new contact is added) */
  watch(c: Contact) {
    this.ensureLid(c).then(() => {
      this.subscribe(c.jid);
      if (DB.getContact(c.id)?.lid) this.subscribe(DB.getContact(c.id)!.lid!);
    });
  }

  private subLogged = new Set<string>();
  subscribe(jid: string) {
    if (!this.sock || !this.connected) return;
    try {
      this.sock.presenceSubscribe(jid);
      if (this.dbg && !this.subLogged.has(jid)) { console.log('[subscribe]', jid); this.subLogged.add(jid); }
    } catch (e) {
      if (this.dbg) console.log('[subscribe FAILED]', jid, String(e));
    }
  }

  private onPresence(update: { id: string; presences: Record<string, any> }) {
    const { id, presences } = update;
    if (this.dbg) console.log('[presence.update]', id, JSON.stringify(presences));
    if (!presences) return;

    const p = presences[id] || presences[Object.keys(presences)[0]];
    if (!p) return;

    // match on either the phone JID or the LID (the key or the chat id)
    const keys = new Set([id, ...Object.keys(presences)]);
    const contact = DB.listContacts().find((c) => keys.has(c.jid) || (c.lid && keys.has(c.lid)));
    if (!contact) return;

    const isOnline = ['available', 'composing', 'recording'].includes(p.lastKnownPresence);
    const was = this.liveSince.get(contact.id);

    if (isOnline && !was) {
      const since = Date.now();
      this.liveSince.set(contact.id, since);
      if (this.dbg) console.log(`[online] ${contact.name}`);
      this.emit('online', { number: contact.number, sinceMs: since, contactId: contact.id });
    } else if (!isOnline && was) {
      const endMs = Date.now();
      this.liveSince.delete(contact.id);
      const session = DB.addSession(contact.id, was, endMs);
      if (this.dbg) console.log(`[offline] ${contact.name} (${Math.round(session.dur_ms / 1000)}s)`);
      this.emit('offline', {
        number: contact.number,
        sinceMs: was,
        endMs,
        durMs: session.dur_ms,
        contactId: contact.id,
        sessionId: session.id,
      });
    }
  }

  /** currently-online "since" timestamp for a contact id, or null */
  liveSinceFor(contactId: number): number | null {
    return this.liveSince.get(contactId) ?? null;
  }

  /** Unlink the WhatsApp account: log out, wipe the saved session, re-arm a fresh QR. */
  async logout() {
    if (this.resubTimer) { clearInterval(this.resubTimer); this.resubTimer = null; }
    try { if (this.sock) await this.sock.logout(); } catch (e) { /* already gone */ }
    try { this.sock?.end?.(undefined); } catch (e) {}
    this.sock = null;
    this.connected = false;
    this.user = null;
    this.lastQR = null;
    this.liveSince.clear();
    try { fs.rmSync(this.authDir, { recursive: true, force: true }); } catch (e) {}
    console.log('Unlinked. Starting a fresh session…');
    this.emit('status', { connected: false, user: null });
    setTimeout(() => this.start().catch(console.error), 800);
  }
}

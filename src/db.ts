import fs from 'fs';
import path from 'path';

/**
 * Tiny zero-dependency JSON-file store. Fine for family / self-monitoring
 * scale (a handful of contacts, a few hundred sessions a day). Swap this
 * module for a real DB if you ever need concurrency or millions of rows —
 * the public `DB` API below is all the rest of the app depends on.
 */

export interface Contact {
  id: number;
  name: string;
  number: string;   // digits only, e.g. 918115168763
  jid: string;      // 918115168763@s.whatsapp.net
  lid?: string;     // modern WhatsApp LID, e.g. 38084112609473@lid (resolved at runtime)
  created_at: number;
}

export interface Session {
  id: number;
  contact_id: number;
  start_ms: number;
  end_ms: number;
  dur_ms: number;
}

interface Store {
  seq: number;
  contacts: Contact[];
  sessions: Session[];
}

const file = path.resolve(process.env.DB_FILE || 'trackwapp.json');

function load(): Store {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const s = JSON.parse(raw);
    return { seq: s.seq || 1, contacts: s.contacts || [], sessions: s.sessions || [] };
  } catch {
    return { seq: 1, contacts: [], sessions: [] };
  }
}

let store: Store = load();

function save() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, file); // atomic replace, avoids a half-written file
}

export function jidFor(number: string): string {
  return number.replace(/[^\d]/g, '') + '@s.whatsapp.net';
}

export const DB = {
  listContacts(): Contact[] {
    return store.contacts.slice().sort((a, b) => a.created_at - b.created_at);
  },
  getContact(id: number): Contact | undefined {
    return store.contacts.find((c) => c.id === id);
  },
  getByNumber(number: string): Contact | undefined {
    const n = number.replace(/[^\d]/g, '');
    return store.contacts.find((c) => c.number === n);
  },
  addContact(name: string, number: string): Contact {
    const n = number.replace(/[^\d]/g, '');
    const c: Contact = { id: store.seq++, name: name.trim(), number: n, jid: jidFor(n), created_at: Date.now() };
    store.contacts.push(c);
    save();
    return c;
  },
  setLid(id: number, lid: string): void {
    const c = store.contacts.find((x) => x.id === id);
    if (c && c.lid !== lid) {
      c.lid = lid;
      save();
    }
  },
  removeContact(id: number): void {
    store.contacts = store.contacts.filter((c) => c.id !== id);
    store.sessions = store.sessions.filter((s) => s.contact_id !== id);
    save();
  },
  addSession(contactId: number, startMs: number, endMs: number): Session {
    const s: Session = { id: store.seq++, contact_id: contactId, start_ms: startMs, end_ms: endMs, dur_ms: Math.max(0, endMs - startMs) };
    store.sessions.push(s);
    save();
    return s;
  },
  sessions(contactId: number, sinceMs = 0): Session[] {
    return store.sessions
      .filter((s) => s.contact_id === contactId && s.start_ms >= sinceMs)
      .sort((a, b) => a.start_ms - b.start_ms);
  },
};

export function dayStart(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

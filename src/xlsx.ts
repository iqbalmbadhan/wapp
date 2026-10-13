import ExcelJS from 'exceljs';
import { Contact, Session } from './db';

const GREEN = 'FF0F9D6B';
const DARK = 'FF10211A';
const ZEBRA = 'FFF2F7F4';

function hms(ms: number): string {
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}
function dmy(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => (x < 10 ? '0' : '') + x;
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function durHMS(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (x: number) => (x < 10 ? '0' : '') + x;
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}
function totalHM(ms: number): string {
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function styleHeader(row: ExcelJS.Row) {
  row.height = 22;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cell.border = { bottom: { style: 'thin', color: { argb: GREEN } } };
  });
}

/** One worksheet for a single contact's sessions. */
function addPersonSheet(wb: ExcelJS.Workbook, contact: Contact, sessions: Session[], liveSince: number | null) {
  const safe = contact.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 28) || contact.number;
  const ws = wb.addWorksheet(safe, {
    properties: { defaultRowHeight: 18 },
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  ws.mergeCells('A1:D1');
  const title = ws.getCell('A1');
  title.value = `${contact.name}  ·  +${contact.number}`;
  title.font = { bold: true, size: 15, color: { argb: DARK } };
  ws.getRow(1).height = 26;

  ws.mergeCells('A2:D2');
  const sub = ws.getCell('A2');
  const rows = sessions.slice();
  if (liveSince) rows.push({ id: -1, contact_id: contact.id, start_ms: liveSince, end_ms: Date.now(), dur_ms: Date.now() - liveSince });
  const totalMs = rows.reduce((a, s) => a + s.dur_ms, 0);
  const longest = rows.reduce((a, s) => Math.max(a, s.dur_ms), 0);
  sub.value = `Sessions: ${rows.length}    Time online today: ${totalHM(totalMs)}    Longest: ${totalHM(longest)}    ${liveSince ? 'Status: ONLINE now' : ''}`;
  sub.font = { size: 10, color: { argb: 'FF59685F' } };
  ws.getRow(3).height = 6;

  ws.columns = [
    { key: 'date', width: 16 },
    { key: 'on', width: 14 },
    { key: 'off', width: 14 },
    { key: 'dur', width: 14 },
  ];
  const head = ws.getRow(4);
  head.values = ['Date', 'Online', 'Offline', 'Duration'];
  styleHeader(head);

  rows
    .slice()
    .reverse()
    .forEach((s, i) => {
      const r = ws.addRow({
        date: dmy(s.start_ms),
        on: hms(s.start_ms),
        off: s.id === -1 ? '— live —' : hms(s.end_ms),
        dur: durHMS(s.dur_ms),
      });
      r.eachCell((cell) => {
        cell.font = { name: 'Consolas', size: 10 };
        if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } };
      });
      r.getCell('dur').font = { name: 'Consolas', size: 10, bold: true, color: { argb: GREEN } };
    });

  if (!rows.length) {
    const r = ws.addRow({ date: 'No sessions recorded today' });
    r.getCell('date').font = { italic: true, color: { argb: 'FF8D9C93' } };
  }
  return ws;
}

function addSummarySheet(wb: ExcelJS.Workbook, contacts: Contact[], stats: Record<number, any>) {
  const ws = wb.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.mergeCells('A1:F1');
  ws.getCell('A1').value = 'TrackWapp · Presence Summary';
  ws.getCell('A1').font = { bold: true, size: 15, color: { argb: DARK } };
  ws.getRow(1).height = 26;
  ws.mergeCells('A2:F2');
  ws.getCell('A2').value = `Generated ${new Date().toLocaleString()}  ·  ${contacts.length} contacts`;
  ws.getCell('A2').font = { size: 10, color: { argb: 'FF59685F' } };

  ws.columns = [
    { key: 'name', width: 24 },
    { key: 'number', width: 18 },
    { key: 'status', width: 12 },
    { key: 'sessions', width: 12 },
    { key: 'time', width: 16 },
    { key: 'longest', width: 14 },
  ];
  const head = ws.getRow(3);
  head.values = ['Name', 'Number', 'Status', 'Sessions', 'Time online', 'Longest'];
  styleHeader(head);

  contacts.forEach((c, i) => {
    const s = stats[c.id];
    const r = ws.addRow({
      name: c.name,
      number: '+' + c.number,
      status: s.online ? 'ONLINE' : 'offline',
      sessions: s.sessions,
      time: totalHM(s.msToday),
      longest: totalHM(s.longest),
    });
    if (i % 2 === 1) r.eachCell((cell) => (cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA } }));
    const st = r.getCell('status');
    st.font = { bold: true, color: { argb: s.online ? GREEN : 'FF8D9C93' } };
  });
}

export async function buildWorkbook(
  contacts: Contact[],
  getSessions: (id: number) => Session[],
  getLive: (c: Contact) => number | null,
  stats: Record<number, any>
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TrackWapp';
  wb.created = new Date();
  if (contacts.length > 1) addSummarySheet(wb, contacts, stats);
  for (const c of contacts) addPersonSheet(wb, c, getSessions(c.id), getLive(c));
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/**
 * Automations agent: turns an uploaded invoice into a row in expenses.csv and
 * meeting notes into an action-items checklist file.
 *
 * ── IN SIMPLE WORDS ──
 * Think of a helpful office assistant who watches the inbox tray. When an
 * invoice lands, they copy the vendor, date, invoice number and total into
 * the expenses spreadsheet. When meeting notes land, they pull out the
 * to-do list and pin it next to the notes. This module decides WHAT to
 * write; it never touches the disk itself — the pipeline does that.
 *
 * ── BUSINESS RULES ──
 * - Invoice → expenses.csv (spec §4.4, PDF capability 4): every uploaded
 *   invoice adds one row `date,vendor,invoice_number,category,total,currency,
 *   source_file` to `expenses.csv` in the Finance folder.
 * - Duplicates are detected by invoice number, falling back to the source
 *   file name when no number was found. A duplicate is skipped, not
 *   re-added (Review Focus #1: same invoice uploaded twice → one row).
 * - An invoice with no readable total writes nothing and logs why.
 * - Category is a keyword vote: Software / Travel / Marketing / Office /
 *   Utilities, else Other.
 * - Meeting → action items: the checklist is written as
 *   "<meeting name> - action items.md" in the meeting's own folder.
 * - Each rule only runs while it is enabled (DEFAULT_RULES ids
 *   `invoice-to-csv`, `meeting-action-items`).
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - runAutomations RETURNS writes instead of doing IO. That keeps it
 *   unit-testable without a disk, and it means an automation can never
 *   call back into the upload pipeline and recurse.
 * - Files with `generated: true` are skipped. Without that, the action-items
 *   file (or expenses.csv) the agent writes would itself be processed as an
 *   upload, triggering an automation-triggers-automation loop.
 * - The total is taken from the strongest "total" label first (grand total,
 *   then total/amount/balance due, then plain total) and the last amount on
 *   that line wins. Otherwise a "Subtotal" line could be logged as the total
 *   (`\btotal\b` deliberately does not match inside "Subtotal").
 * - CSV values go through csvEscape/parseCsvLine so vendors with commas or
 *   quotes ("Acme, \"Best\" Ltd") round-trip and do not shift columns —
 *   which would also break the invoice-number dedupe (column 3).
 *
 * ── DO NOT ──
 * - Do NOT run automations on agent-generated files (record.generated).
 * - Do NOT do file IO here; return writes and let the pipeline apply them.
 * - Do NOT build CSV rows by plain string join without csvEscape.
 * - Do NOT change EXPENSES_HEADER column order: dedupe reads the invoice
 *   number from column index 2 and the source file from index 6.
 */
import { extractActionItems } from '../text.js';

export const EXPENSES_FILE = 'expenses.csv';
export const EXPENSES_HEADER = 'date,vendor,invoice_number,category,total,currency,source_file';

export const DEFAULT_RULES = [
  { id: 'invoice-to-csv', name: 'Invoice → expenses.csv', description: 'When an invoice is uploaded, extract the vendor, date and total, pick a category, and add a row to expenses.csv in Finance.', enabled: true },
  { id: 'meeting-action-items', name: 'Meeting → action items', description: 'When meeting notes are uploaded, pull the action items into a checklist file next to the meeting.', enabled: true },
];

const CATEGORIES = {
  Software: ['software', 'subscription', 'saas', 'license', 'cloud', 'hosting', 'database'],
  Travel: ['flight', 'hotel', 'travel', 'airfare', 'taxi', 'uber', 'train'],
  Marketing: ['print', 'flyer', 'banner', 'advertising', 'ads', 'campaign', 'brochure', 'promo'],
  Office: ['office', 'stationery', 'furniture', 'chair', 'desk', 'supplies', 'printer'],
  Utilities: ['electricity', 'internet', 'water', 'utility', 'utilities', 'phone'],
};
const SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP' };
const MONEY_RE = /([$€£])?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s?(USD|EUR|GBP|PKR)?/g;
const TOTAL_PATTERNS = [/\bgrand total\b/i, /\b(total due|amount due|balance due)\b/i, /\btotal\b/i];

export function categorize(text) {
  const t = String(text).toLowerCase();
  let best = 'Other';
  let bestScore = 0;
  for (const [cat, words] of Object.entries(CATEGORIES)) {
    const score = words.reduce((s, w) => s + (t.match(new RegExp(`\\b${w}`, 'g')) || []).length, 0);
    if (score > bestScore) { best = cat; bestScore = score; }
  }
  return best;
}

export function parseInvoice(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let totalLine = null;
  for (const re of TOTAL_PATTERNS) {
    const hits = lines.filter((l) => re.test(l) && [...l.matchAll(MONEY_RE)].some((m) => m[1] || m[3] || /[.,]/.test(m[2])));
    if (hits.length) { totalLine = hits[hits.length - 1]; break; }
  }
  if (!totalLine) return null;
  const amounts = [...totalLine.matchAll(MONEY_RE)].filter((m) => m[1] || m[3] || /[.,]/.test(m[2]));
  const last = amounts[amounts.length - 1];
  const total = Number(last[2].replace(/,/g, ''));
  const currency = last[3] || SYMBOLS[last[1]] || 'USD';
  const number = (text.match(/\b(INV[-\s]?\d+)\b/i)?.[1] ?? text.match(/invoice\s*(?:number|no\.?|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]+)/i)?.[1] ?? '').toUpperCase();
  const date = text.match(/(?:invoice date|date)\s*[:-]?\s*(\d{4}-\d{2}-\d{2}|[A-Za-z]+ \d{1,2},? \d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1] ?? '';
  const vendorLine = lines.map((l) => l.match(/^(?:from|vendor|seller|billed by)\s*[:-]\s*(.+)/i)).find(Boolean);
  const vendor = vendorLine ? vendorLine[1].trim() : lines.find((l) => !/^invoice\b/i.test(l)) ?? '';
  return { vendor, number, date, total, currency, category: categorize(text) };
}

export function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

export function appendExpenseRow(existingCsv, inv, sourceFile) {
  const base = existingCsv && existingCsv.trim() ? existingCsv.replace(/\s*$/, '\n') : `${EXPENSES_HEADER}\n`;
  const rows = base.trim().split('\n').slice(1).map(parseCsvLine);
  const duplicate = inv.number ? rows.some((r) => r[2] === inv.number) : rows.some((r) => r[6] === sourceFile);
  if (duplicate) return { csv: existingCsv, added: false };
  const row = [inv.date, inv.vendor, inv.number, inv.category, inv.total.toFixed(2), inv.currency, sourceFile].map(csvEscape).join(',');
  return { csv: `${base}${row}\n`, added: true };
}

const money = (n, cur) => (cur === 'USD' ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${n.toFixed(2)} ${cur}`);

export function runAutomations({ record, text, rules, getFileText }) {
  const writes = [];
  const logs = [];
  if (record.generated) return { writes, logs };
  const on = (id) => rules.some((r) => r.id === id && r.enabled);

  if (record.type === 'invoice' && on('invoice-to-csv')) {
    const inv = parseInvoice(text);
    if (!inv) {
      logs.push(`"${record.name}" looks like an invoice but has no total I could read, so nothing was logged.`);
    } else {
      const { csv, added } = appendExpenseRow(getFileText(EXPENSES_FILE), inv, record.name);
      const label = inv.number || record.name;
      if (added) {
        writes.push({ name: EXPENSES_FILE, folder: 'Finance', content: csv, type: 'data' });
        logs.push(`Logged ${label} (${money(inv.total, inv.currency)}) from ${inv.vendor || 'unknown vendor'} to ${EXPENSES_FILE} as ${inv.category}.`);
      } else {
        logs.push(`${label} is already in ${EXPENSES_FILE}, so the duplicate was skipped.`);
      }
    }
  }

  if (record.type === 'meeting' && on('meeting-action-items')) {
    const items = extractActionItems(text);
    if (items.length === 0) {
      logs.push(`No action items found in "${record.name}".`);
    } else {
      const name = `${record.name.replace(/\.[^.]+$/, '')} - action items.md`;
      const content = `# Action items: ${record.name}\n\n_Created automatically by the Meeting → action items automation._\n\n${items.map((i) => `- [ ] ${i}`).join('\n')}\n`;
      writes.push({ name, folder: record.folder, content, type: 'report' });
      logs.push(`Found ${items.length} action items in "${record.name}" and created "${name}".`);
    }
  }
  return { writes, logs };
}

/**
 * Organizer agent: decides each uploaded file's type, folder, tags and one-line summary.
 *
 * ── IN SIMPLE WORDS ──
 * When a file lands in the drive, this agent reads it and files it, like a tidy
 * assistant sorting paper into labelled folders. It says what kind of document
 * it is (invoice, meeting notes, data sheet or general report), which topic
 * folder it belongs in (Finance, Marketing, Engineering, ...), a few tags, and a
 * short summary. If an AI key is set it asks the AI first; if the AI is missing,
 * fails, or answers nonsense, it uses its own keyword rules so it always works.
 *
 * ── BUSINESS RULES ──
 * - Invoices always go to the Finance folder, in AI and offline mode (spec §4.1;
 *   tested: "organize uses AI JSON when valid, but keeps the invoice->Finance rule").
 * - .csv files are always type `data`, in AI and offline mode (plan Task 4 rules).
 * - For a CSV only the header row and the file name decide the folder: the
 *   column names describe the file, the values are just data (plan Task 4;
 *   tested with q3-budget.csv, whose rows mention Marketing but whose header is budget/cost).
 * - Folder = topic with the most stemmed keyword hits; file-name words count x2;
 *   a score below 2 (or no text) gives `General`; ties go to the earlier topic in TOPICS.
 * - A file with no readable text is stored as `report` in `General` with summary
 *   "(no readable text)" (plan Review Focus #3).
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - The offline result is computed first and every AI field is validated and
 *   falls back to it field-by-field. Without this, a junk or partial AI reply
 *   would store files with no type/folder and break the UI and automations.
 * - Any AI failure (throw or unparseable reply) is caught, logged via `log`, and
 *   returns `by: 'offline'`, so a rate-limited or offline LLM never fails an upload.
 * - The AI is skipped when the text is empty, so scanned PDFs do not burn a call
 *   and cannot get an invented summary.
 * - MIN_TOPIC_SCORE = 2 stops a single stray word (e.g. "app") from pulling a
 *   file out of General.
 *
 * ── DO NOT ──
 * - Do not let an AI reply override the invoice -> Finance rule or the csv -> data
 *   rule: the invoice automation (expenses.csv) relies on invoices being found there.
 * - Do not score CSV data rows for the folder: a budget sheet would be filed by
 *   whichever department appears most in its rows.
 * - Do not reorder TOPICS casually: order is the tie-breaker.
 * - Do not trust AI strings unchecked: an AI folder name over 30 characters is
 *   rejected and the offline folder is used instead.
 */
import { tokenize, topTerms, summarize, stem } from '../text.js';
import { parseJsonReply } from '../json-reply.js';

export const TYPES = ['invoice', 'meeting', 'data', 'report'];

export const TOPICS = {
  Finance: ['invoice', 'payment', 'budget', 'expense', 'cost', 'revenue', 'tax', 'billing', 'amount', 'total', 'spend', 'finance', 'accounting', 'payable', 'price'],
  Marketing: ['marketing', 'campaign', 'brand', 'social', 'ads', 'advertising', 'seo', 'audience', 'launch', 'content', 'influencer', 'newsletter'],
  Engineering: ['api', 'code', 'database', 'server', 'deploy', 'bug', 'feature', 'architecture', 'mobile', 'app', 'backend', 'frontend', 'release', 'sprint', 'engineering'],
  HR: ['hiring', 'candidate', 'interview', 'employee', 'onboarding', 'salary', 'leave', 'benefits', 'recruit', 'recruiting', 'hr', 'policy'],
  Legal: ['contract', 'agreement', 'clause', 'liability', 'compliance', 'legal', 'nda', 'terms', 'gdpr', 'license'],
  Sales: ['sales', 'customer', 'deal', 'pipeline', 'lead', 'prospect', 'quota', 'crm', 'client', 'pricing'],
};
const TOPIC_STEMS = Object.fromEntries(Object.entries(TOPICS).map(([k, words]) => [k, new Set(words.map(stem))]));
const MIN_TOPIC_SCORE = 2;

export function detectType(name, ext, text) {
  if (ext === '.csv') return 'data';
  const t = String(text).toLowerCase();
  if (/\binvoice\b/.test(t) && /\b(total|amount due|balance due)\b/.test(t)) return 'invoice';
  if (/\b(attendees|agenda|minutes|action items?)\b/.test(t)) return 'meeting';
  return 'report';
}

export function detectFolder(name, ext, text) {
  if (!String(text).trim()) return 'General';
  // CSV: header row only — the values are data, the columns say what the file is.
  const body = ext === '.csv' ? String(text).split(/\r?\n/)[0] : text;
  // File-name tokens are pushed twice so they count x2.
  const tokens = [...tokenize(body), ...tokenize(name.replace(/\.[^.]+$/, '')).flatMap((t) => [t, t])];
  let best = 'General';
  let bestScore = MIN_TOPIC_SCORE - 1;
  for (const [topic, stems] of Object.entries(TOPIC_STEMS)) {
    const score = tokens.filter((t) => stems.has(t)).length;
    // Strict ">" so ties keep the earlier topic in TOPICS order.
    if (score > bestScore) { best = topic; bestScore = score; }
  }
  return best;
}

export function organizeOffline({ name, ext, text }) {
  const type = detectType(name, ext, text);
  const folder = type === 'invoice' ? 'Finance' : detectFolder(name, ext, text);
  const tags = [...new Set([type, folder.toLowerCase(), ...topTerms(text, 5)])].slice(0, 7);
  return { type, folder, tags, summary: summarize(text) };
}

const SYSTEM = 'You organise files in a cloud drive. Reply with JSON only.';

function buildPrompt(name, text) {
  return `File name: ${name}

Content (first 4000 characters):
"""
${text.slice(0, 4000)}
"""

Return ONLY a JSON object:
{"type": one of "invoice" | "meeting" | "data" | "report",
 "folder": a short topic folder name of 1-2 words, preferring Finance, Marketing, Engineering, HR, Legal, Sales or General,
 "tags": up to 6 short lowercase tags,
 "summary": one plain sentence under 160 characters}`;
}

export async function organize(doc, { llm, log = () => {} } = {}) {
  const offline = organizeOffline(doc);
  if (!llm?.enabled() || !String(doc.text).trim()) return { ...offline, by: 'offline' };
  try {
    const reply = parseJsonReply(await llm.complete(buildPrompt(doc.name, doc.text), { system: SYSTEM, effort: 'low' }));
    if (!reply) throw new Error('AI reply was not valid JSON');
    const type = doc.ext === '.csv' ? 'data' : TYPES.includes(reply.type) ? reply.type : offline.type;
    const aiFolder = typeof reply.folder === 'string' && reply.folder.trim().length > 0 && reply.folder.trim().length <= 30
      ? reply.folder.trim().replace(/^\w/, (c) => c.toUpperCase())
      : offline.folder;
    const folder = type === 'invoice' ? 'Finance' : aiFolder;
    const aiTags = Array.isArray(reply.tags) ? reply.tags.filter((t) => typeof t === 'string').map((t) => t.toLowerCase().trim()).filter(Boolean) : [];
    const tags = [...new Set([...aiTags.slice(0, 6), type])].slice(0, 7);
    const summary = typeof reply.summary === 'string' && reply.summary.trim() ? reply.summary.trim().slice(0, 160) : offline.summary;
    return { type, folder, tags, summary, by: 'ai' };
  } catch (err) {
    log('Organizer', `AI unavailable for "${doc.name}" (${err.message}); used offline rules instead.`);
    return { ...offline, by: 'offline' };
  }
}

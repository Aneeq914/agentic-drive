/**
 * Organizer agent: decides each uploaded file's kind, topic, confidence, tags and one-line summary.
 *
 * ── IN SIMPLE WORDS ──
 * When a file lands in the drive, this agent reads it and files it, like a tidy
 * assistant putting paper on the right shelf. It says what KIND of document it
 * is (invoice, meeting notes, contract, proposal, spec, report, data sheet,
 * people/HR, or "other" when unsure), which TOPIC it is about (Finance,
 * Marketing, ... or none), how sure it is, a few tags and a short summary.
 * The offline classifier (classifier.js) always runs; if an AI key is set the
 * AI is asked too, but every AI answer is checked against the fixed lists and
 * anything invalid falls back to the offline answer, so it always works.
 *
 * ── BUSINESS RULES ──
 * - Kind and topic come from classifier.js (spec §4): fixed kind ids and
 *   topic names; low confidence is filed as `other` (tested: empty text ->
 *   other/null/low; a brief that talks about invoices is not an invoice).
 * - Forced topics (plan Global Constraints): invoice -> Finance,
 *   people -> HR, contract -> Legal — in offline AND AI mode (tested: AI says
 *   topic "Legal" for an invoice and still gets Finance; AI kind people/contract
 *   get HR/Legal).
 * - .csv files are always kind `data`, in AI and offline mode (tested: AI
 *   says "report" for q3-budget.csv and still gets data).
 * - AI results: a kind not in KIND_IDS uses the offline kind; a topic not in
 *   TOPICS (and not null) uses the offline topic; AI results are stored with
 *   confidence `high` (plan Task 4; tested).
 * - Tags: kind, topic (lowercased), then the top body terms; unique, max 7.
 * - A file with no readable text is `other`, topic null, confidence low, with
 *   summary "(no readable text)".
 * - Offline summaries (only for the matching kind):
 *   - invoices read "Invoice <no> from <vendor> for <total> (<category>).";
 *     "(<category>)" is left out when it is Other; an ALL-CAPS vendor is
 *     title-cased ("CAFE LUMEN" -> "Cafe Lumen") in the summary only (the
 *     expenses.csv row keeps the parsed vendor); a text with "receipt" in its
 *     first 10 lines and no invoice number reads "Receipt from <vendor> for
 *     <total>." (tested: "offline summaries: a receipt says…");
 *   - people files whose first two lines are a name (2-4 capitalised words)
 *     and a short title read "<Name> — <title>" (tested with the bundled
 *     resume PDF through extract.js); policies / job descriptions do not match
 *     and use their first real sentence (tested);
 *   - CSVs read "Spreadsheet with N rows. Columns: …";
 *   - everything else uses text.js summarize(): the first real sentence,
 *     never a table row, byline or contact line (text.test "summarize…").
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - The offline result is computed first and every AI field is validated and
 *   falls back to it field-by-field. Without this, a junk or partial AI reply
 *   would store a kind the sidebar has no category for, or a free-text topic
 *   the topic filter cannot show.
 * - Any AI failure (throw or unparseable reply) is caught, logged via `log`, and
 *   returns `by: 'offline'`, so a rate-limited or offline LLM never fails an upload.
 * - The AI is skipped when the text is empty, so scanned PDFs do not burn a call
 *   and cannot get an invented summary.
 * - The invoice summary is only used when the kind is `invoice`: a brief that
 *   happens to contain a "Total:" line must not be summarised as a bill.
 * - The "<Name> — <title>" form is only tried for kind `people`, and the name
 *   line must not contain document words (Policy, Description, Plan…):
 *   otherwise "# Remote Work Policy" + a short second line would be read as
 *   a person (tested: policy and job description keep a sentence).
 * - Receipt detection needs BOTH "receipt" near the top AND no invoice
 *   number, so an invoice saying "keep this receipt" stays an invoice (tested).
 *
 * ── DO NOT ──
 * - Do not let an AI reply override the forced topics or the csv -> data rule:
 *   the invoice automation (expenses.csv) and the Finance topic filter rely on them.
 * - Do not accept AI kind/topic strings that are not in KIND_IDS / TOPICS.
 * - Do not move the vendor title-casing into parseInvoice(): expenses.csv
 *   rows and their dedupe use the vendor/number exactly as parsed.
 * - Do not put classification rules here; they belong in classifier.js, which
 *   is unit- and accuracy-tested on its own.
 */
import { topTerms, summarize } from '../text.js';
import { parseJsonReply } from '../json-reply.js';
import { parseInvoice, parseCsvLine } from './automations.js';
import { classifyKind, classifyTopic, KIND_IDS, TOPICS, FORCED_TOPIC } from './classifier.js';

const unique = (xs) => [...new Set(xs)];

export function organizeOffline({ name, ext, text }) {
  const c = classifyKind({ name, ext, text });
  const topic = classifyTopic({ name, ext, text }, c.kind);
  const tags = unique([c.kind, topic?.toLowerCase(), ...topTerms(text, 5)].filter(Boolean)).slice(0, 7);
  return { kind: c.kind, topic, confidence: c.confidence, runnerUp: c.runnerUp, tags, summary: offlineSummary(c.kind, ext, text) };
}

// "CAFE LUMEN" -> "Cafe Lumen"; mixed-case names ("CloudNest", "PrintHub") are left alone.
const titleCase = (name) => (/[A-Z]/.test(name) && !/[a-z]/.test(name)
  ? name.toLowerCase().replace(/(^|[\s(&/-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase())
  : name);

// A till slip says "receipt" near the top and has no invoice number; it is not an invoice.
const isReceipt = (text, inv) => !inv.number && /\breceipt\b/i.test(String(text).split(/\r?\n/).slice(0, 10).join('\n'));

// "Priya Nair" / "Product Designer": 2-4 capitalised words, then a short title line.
const NAME_LINE = /^[A-Z][a-zA-Z'’.-]+(?: [A-Z][a-zA-Z'’.-]+){1,3}$/;
const NOT_A_NAME = /\b(?:policy|description|handbook|guide|plan|agreement|report|notes|minutes|proposal|summary|invoice|resume|cv)\b/i;
function resumeHeadline(text) {
  const [first, second] = String(text).split(/\r?\n/).map((l) => l.replace(/^\s*#+\s*/, '').replace(/[*_]/g, '').trim()).filter(Boolean);
  if (!first || !second || !NAME_LINE.test(first) || NOT_A_NAME.test(first)) return null;
  const words = second.split(/\s+/).length;
  if (words > 8 || /[:|@\d]/.test(second) || /[.!?]$/.test(second) || NOT_A_NAME.test(second)) return null;
  return `${first} — ${second}`;
}

// Invoices, receipts, resumes and spreadsheets read badly as "first sentence", so describe them instead.
export function offlineSummary(kind, ext, text) {
  if (kind === 'invoice') {
    const inv = parseInvoice(text);
    if (inv) {
      const amount = inv.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const money = inv.currency === 'USD' ? `$${amount}` : `${amount} ${inv.currency}`;
      const what = isReceipt(text, inv) ? 'Receipt' : `Invoice${inv.number ? ` ${inv.number}` : ''}`;
      const category = inv.category === 'Other' ? '' : ` (${inv.category})`;
      return `${what} from ${inv.vendor ? titleCase(inv.vendor) : 'unknown vendor'} for ${money}${category}.`.slice(0, 160);
    }
  }
  if (kind === 'people') {
    const headline = resumeHeadline(text);
    if (headline) return headline.slice(0, 160);
  }
  if (ext === '.csv' && String(text).trim()) {
    const [header, ...rows] = String(text).split(/\r?\n/).filter((l) => l.trim());
    return `Spreadsheet with ${rows.length} rows. Columns: ${parseCsvLine(header).join(', ')}.`.slice(0, 160);
  }
  return summarize(text);
}

const SYSTEM = 'You organise files in a cloud drive. Reply with JSON only.';

function buildPrompt(name, text) {
  return `File name: ${name}

Content (first 4000 characters):
"""
${text.slice(0, 4000)}
"""

Return ONLY a JSON object:
{"kind": one of ${KIND_IDS.map((k) => `"${k}"`).join(' | ')},
 "topic": one of ${TOPICS.map((t) => `"${t}"`).join(' | ')} or null if unclear,
 "tags": up to 6 short lowercase tags,
 "summary": one plain sentence under 160 characters}

Kinds: invoice = invoices/receipts/bills; meeting = meeting notes/minutes; contract = contracts/agreements;
proposal = proposals/briefs/problem statements/RFPs; spec = specs/plans/roadmaps; report = reports/analyses/articles;
data = spreadsheets; people = resumes/job descriptions/HR policies; other = none of these.
A document that only talks about invoices is not an invoice.`;
}

export async function organize(doc, { llm, log = () => {} } = {}) {
  const offline = organizeOffline(doc);
  if (!llm?.enabled() || !String(doc.text).trim()) return { ...offline, by: 'offline' };
  try {
    const reply = parseJsonReply(await llm.complete(buildPrompt(doc.name, doc.text), { system: SYSTEM, effort: 'low' }));
    if (!reply) throw new Error('AI reply was not valid JSON');
    const kind = doc.ext === '.csv' ? 'data' : KIND_IDS.includes(reply.kind) ? reply.kind : offline.kind;
    const aiTopic = reply.topic === null || TOPICS.includes(reply.topic) ? reply.topic : offline.topic;
    const topic = FORCED_TOPIC[kind] ?? aiTopic;
    const aiTags = Array.isArray(reply.tags) ? reply.tags.filter((t) => typeof t === 'string').map((t) => t.toLowerCase().trim()).filter(Boolean) : [];
    const tags = unique([...aiTags.slice(0, 6), kind]).slice(0, 7);
    const summary = typeof reply.summary === 'string' && reply.summary.trim() ? reply.summary.trim().slice(0, 160) : offline.summary;
    return { kind, topic, confidence: 'high', runnerUp: null, tags, summary, by: 'ai' };
  } catch (err) {
    log('Organizer', `AI unavailable for "${doc.name}" (${err.message}); used offline rules instead.`);
    return { ...offline, by: 'offline' };
  }
}

/**
 * Shared text helpers used by every agent: tokens, sentences, tags, one-line summaries, extractors.
 *
 * ── IN SIMPLE WORDS ──
 * The small toolbox every agent reaches for when it reads a file: split text
 * into words and sentences, find the words a file is about, pull out
 * decisions, requirements, to-dos and money amounts, and write the one-line
 * summary shown on each file card — like reading the first proper sentence
 * of a document and skipping the letterhead, the table and the address block.
 *
 * ── BUSINESS RULES ──
 * - summarize(text) (file-card summary, max 160 chars, "…" when cut):
 *   - empty text -> "(no readable text)";
 *   - never a markdown heading, table row or table separator line; a file
 *     that is only a table reads "Table with columns: …" (tested);
 *   - skips "Label: value" metadata, bylines ("By Omar Siddiqui, …", "6 min
 *     read", "a · b · c"), "Confidential…" notices, and contact lines (email,
 *     phone, or an address with no verb, e.g. NDA party lines) when any other
 *     line exists (tested);
 *   - picks the first full sentence (>= 6 words, ends in . ! ?) in document
 *     order, list item or not; then a >= 6-word non-list fragment; then any
 *     >= 6-word fragment; then the first sentence. So agenda items ("2. Where
 *     the current site falls short") lose to prose, but a numbered roadmap
 *     theme that is a full sentence still counts (tested).
 * - topTerms ignores stopwords, months, weekdays and meeting boilerplate.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - Table rows are dropped before markers are stripped: once "|" is gone a
 *   row like "Average engagement time 1m 38s 1m 52s +14s" has 6+ words and
 *   wins as "the first real sentence" (a website-analytics report's did).
 * - The byline check is case-sensitive ("By" + capitalised words): with a
 *   case-insensitive match "by the end of the week we will…" is a byline
 *   (tested).
 * - An address only counts as contact info when the line has no verb
 *   (is/are/was/will/has…), so an agreement's "This Agreement is between X,
 *   Office 3, Level 2, …" opening sentence is still a valid summary (tested).
 * - summarize keeps its own line pass instead of changing plainLines():
 *   extractDecisions/extractRequirements (Synthesizer) still read tables
 *   and lists as before.
 *
 * ── DO NOT ──
 * - Do not change splitSentences() to fix a summary: Search splits answer
 *   lines with it and its answer tests (search.test) are tuned against that
 *   splitting.
 * - Do not make the byline/notice patterns broader without a test: each one
 *   removes candidate sentences from every file in the drive.
 */

export const STOPWORDS = new Set(`a an and are as at be been but by for from has have he her his i if in into is it its
me my no not of on or our she so than that the their them then there these they this to was we were what when where which
who with you your about also can could did do does just more most would all any each how only other some such up out over
very per via am being here our ours us`.split(/\s+/).filter(Boolean));

export function stem(w) {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (/(sh|ch|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((w) => !STOPWORDS.has(w))
    .map(stem);
}

export function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Words that are frequent in notes but say nothing about the topic, so they make poor tags.
const TAG_IGNORE = new Set(`will shall would should must action actions item items date attendees agenda minutes notes
team total generated created automatically january february march april june july august september october november
december monday tuesday wednesday thursday friday saturday sunday`.split(/\s+/).filter(Boolean));

export function topTerms(text, n) {
  const counts = new Map();
  for (const w of String(text).toLowerCase().match(/[a-z]+/g) || []) {
    if (w.length < 4 || STOPWORDS.has(w) || TAG_IGNORE.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([w]) => w);
}

// Strips markdown list/heading/table markers so sentences read cleanly.
const plainLine = (l) => l.replace(/^\s*(?:(?:[-*>|]|\d+[.)]|\[[ x]\])\s*)+/i, '').replace(/[|*_`]/g, ' ').replace(/\s+/g, ' ').trim();

function plainLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map(plainLine)
    .filter(Boolean);
}

const LABEL_LINE = /^[A-Za-z][\w ]{0,24}:\s/;
// "| Sessions | 16,446 |" and "|---|---|": a table row says nothing on its own.
const TABLE_LINE = /^\s*\||\|.*\|/;
const LIST_ITEM = /^\s*(?:[-*+•]|\d+[.)]|\[[ x]\])\s/i;
// Bylines, read times and notices describe the file, not its content.
// (Case-sensitive on purpose: "by the end of May we…" is a sentence, "By Omar Siddiqui, …" a byline.)
const BYLINE = /^(?:[Ww]ritten |[Pp]osted )?[Bb]y\s+[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)+/;
const NOTICE = /^(?:confidential|internal use only)\b|\b\d+\s*min(?:ute)?s? read\b|\s[·•]\s.*\s[·•]\s/i;
const isMeta = (l) => BYLINE.test(l) || NOTICE.test(l);
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+\d{1,3}|\b(?:tel|phone|mobile)\b)[\s:.]*\(?\d[\d\s().-]{6,}\d/i;
// "(2) Northwind Health (Pvt.) Ltd., 9 Jail Road, Lahore, Pakistan" — an address with no verb.
const ADDRESS = /\b(?:road|street|avenue|lane|boulevard|(?:level|floor|suite|office) \d+)\b/i;
const HAS_VERB = /\b(?:is|are|was|were|will|has|have|had)\b/i;
const isContact = (l) => EMAIL.test(l) || PHONE.test(l) || (ADDRESS.test(l) && !HAS_VERB.test(l));
const isSentence = (s) => /[.!?]["'”’)\]]*$/.test(s);
const isLong = (s) => s.split(/\s+/).length >= 6;

/** One-line summary: the first real prose sentence, skipping headings, tables, metadata and contact lines. */
export function summarize(text, max = 160) {
  if (!String(text).trim()) return '(no readable text)';
  const lines = [];
  const tables = [];
  for (const raw of String(text).split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue;
    if (TABLE_LINE.test(raw)) { tables.push(raw); continue; }
    const line = plainLine(raw);
    if (line) lines.push({ line, list: LIST_ITEM.test(raw) });
  }
  // "Date: …", "Attendees: …", bylines and addresses are metadata, not what the file is about.
  const content = lines.filter(({ line }) => !LABEL_LINE.test(line) && !isMeta(line) && !isContact(line));
  const sentences = (content.length ? content : lines).flatMap(({ line, list }) => splitSentences(line).map((s) => ({ s, list })));
  const find = (fn) => sentences.find(fn)?.s;
  // A full sentence first (a numbered "1. **Ship on time.** The launch on Nov 20 matters…" theme
  // counts); then prose fragments; agenda items ("2. Where the site falls short") only as a last resort.
  let pick = find((x) => isLong(x.s) && isSentence(x.s)) ?? find((x) => !x.list && isLong(x.s))
    ?? find((x) => isLong(x.s)) ?? sentences[0]?.s;
  if (!pick) {
    // Only headings and/or tables: name the table's columns rather than echo a raw row.
    const header = tables.find((l) => !/^[\s|:-]+$/.test(l));
    const heading = String(text).match(/^\s*#+\s*(.+)$/m)?.[1];
    pick = heading ? plainLine(heading) : header ? `Table with columns: ${header.split('|').map((c) => plainLine(c)).filter(Boolean).join(', ')}.` : plainLine(String(text).trim());
  }
  return pick.length > max ? pick.slice(0, max - 1).trimEnd() + '…' : pick;
}

const DECISION_RE = /\b(decided|agreed|approved|will|decision)\b/i;
const REQUIREMENT_RE = /\b(must|should|need to|needs to|required|requirement)\b/i;

export function extractDecisions(text) {
  return [...new Set(splitSentences(plainLines(text).join('\n')).filter((s) => DECISION_RE.test(s)))];
}

export function extractRequirements(text) {
  return [...new Set(splitSentences(plainLines(text).join('\n')).filter((s) => REQUIREMENT_RE.test(s)))];
}

export function extractActionItems(text) {
  const out = [];
  let inSection = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (/^#*\s*action items?:?\s*$/i.test(line)) { inSection = true; continue; }
    if (line.startsWith('#')) { inSection = false; continue; }
    if (!line) continue;
    let m = line.match(/^[-*]\s*\[[ x]\]\s*(.+)/i) || line.match(/^(?:[-*]\s*)?(?:action|todo)\s*:\s*(.+)/i);
    if (!m && inSection) m = line.match(/^(?:[-*]|\d+[.)])\s*(.+)/);
    if (m) out.push(m[1].trim());
  }
  return [...new Set(out)];
}

const AMOUNT_RE = /[$€£]\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|PKR)\b/g;

export function extractAmounts(text) {
  return [...new Set(String(text).match(AMOUNT_RE) || [])];
}

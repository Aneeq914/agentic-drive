// Shared text helpers used by every agent. Small and pure, so no 4-section header.

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
function plainLines(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^\s*(?:(?:[-*>|]|\d+[.)]|\[[ x]\])\s*)+/i, '').replace(/[|*_`]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const LABEL_LINE = /^[A-Za-z][\w ]{0,24}:\s/;

export function summarize(text, max = 160) {
  if (!String(text).trim()) return '(no readable text)';
  // "Date: …", "Attendees: …", "From: …" lines are metadata, not what the file is about.
  const lines = plainLines(text);
  const content = lines.filter((l) => !LABEL_LINE.test(l));
  const sentences = splitSentences((content.length ? content : lines).join('\n'));
  const pick = sentences.find((s) => s.split(/\s+/).length >= 6) || sentences[0] || String(text).trim();
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

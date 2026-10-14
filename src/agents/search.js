/**
 * Search agent: answers a plain-English question from the user's files, with numbered citations.
 *
 * ── IN SIMPLE WORDS ──
 * Think of a librarian who cuts every file into short passages, finds the
 * passages that best match your question, and reads you back the most
 * relevant sentence from each, saying exactly which file it came from
 * ("[1] q3-marketing-kickoff.md"). If an AI key is set, the AI writes the
 * answer instead, but it only sees those top passages and must cite them.
 *
 * ── BUSINESS RULES ──
 * - Spec "Search agent": answers must cite the files they come from; when
 *   nothing matches, reply NOT_FOUND ("I couldn't find that in your files.").
 * - Passages: blank-line paragraphs merged up to 600 chars (long paragraphs
 *   split by sentence); a CSV passage is its header line plus up to 8 rows.
 * - Ranking: BM25 (k1 1.2, b 0.75); query words expanded with SYNONYMS at
 *   weight 0.5; +0.5 x idf when a query word appears in the file name.
 * - Offline answer: top 3 passages scoring >= MIN_SCORE (1.0) AND >= 60% of
 *   the best passage, one "• <sentence> [n]" line each, citation n = 1..3.
 *   "How much…" questions prefer the line holding an amount (a total over a
 *   line item); CSV rows are read back as "first cell — column: value";
 *   lines under 6 words get their file name appended for context.
 * - AI answer: top 6 passages with score > 0, numbered [1]..[6]; only the
 *   citations the answer actually uses are returned (all six if it cites none).
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - BM25 plus a small synonym table gives "meaning-ish" search with no vector
 *   DB and no network, so search still works with no AI key (tests: "synonyms
 *   count" — "spend" finds the "budget" passage).
 * - The AI only sees the top passages, so prompts stay small; if no passage
 *   scores > 0 the AI is not called at all and NOT_FOUND is returned, which
 *   stops the model answering from its own general knowledge.
 * - Any AI failure (throw, empty reply) falls back to the offline answer and
 *   is logged, so a quota error never becomes a failed request (test:
 *   "ask falls back offline when AI throws").
 * - Without the 60% relative cutoff, any passage that shares one word with
 *   the question ("spend") is added as noise; without the amount preference,
 *   "How much did we spend on travel?" answered with the invoice's heading
 *   (tests: "money question…", "csv rows…", "headings are not used…").
 * - Citation numbers in the answer text and in `citations[].n` come from the
 *   same numbering, so the UI can link "[1]" to the right file.
 *
 * ── DO NOT ──
 * - Do not return citations the answer doesn't use (test: "keeps only cited
 *   sources") — the UI would show sources that support nothing.
 * - Do not renumber or reorder citations after filtering: `n` must keep
 *   matching the "[n]" markers in the answer text.
 * - Do not add SYNONYM_WORDS entries that are stopwords (e.g. "by" is
 *   dropped by tokenize()); they silently become no-ops.
 */
import { tokenize, splitSentences } from '../text.js';
import { parseCsvLine } from './automations.js';

export const NOT_FOUND = "I couldn't find that in your files.";
const MAX_PASSAGE = 600;
const CSV_ROWS = 8;
const MIN_SCORE = 1.0;
const K1 = 1.2;
const B = 0.75;

// Keys and values are run through tokenize() at load, so write plain words.
const SYNONYM_WORDS = {
  budget: ['spend', 'cost', 'allocation', 'funding'],
  spend: ['budget', 'cost', 'expense', 'spent'],
  cost: ['price', 'expense', 'spend'],
  meeting: ['minutes', 'discussion', 'call', 'sync'],
  q3: ['third', 'quarter'],
  deadline: ['due', 'date', 'timeline', 'by'],
  owner: ['responsible', 'assigned'],
  decide: ['agreed', 'approved', 'decision'],
  revenue: ['sales', 'income'],
  customer: ['client'],
  employee: ['staff', 'team'],
  invoice: ['bill', 'payment'],
  travel: ['flight', 'hotel', 'trip'],
};
const SYNONYMS = new Map(Object.entries(SYNONYM_WORDS).map(([k, vs]) => [tokenize(k)[0], vs.flatMap(tokenize)]));

export function buildPassages(docs) {
  const out = [];
  for (const d of docs) {
    if (!d.text?.trim()) continue;
    const push = (text) => out.push({ fileId: d.id, fileName: d.name, text: text.trim() });
    if (d.ext === '.csv') {
      const [header, ...rows] = d.text.split(/\r?\n/).filter((l) => l.trim());
      if (rows.length === 0) push(header);
      for (let i = 0; i < rows.length; i += CSV_ROWS) push([header, ...rows.slice(i, i + CSV_ROWS)].join('\n'));
      continue;
    }
    let buf = '';
    for (const para of d.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
      const pieces = para.length <= MAX_PASSAGE ? [para] : chunkSentences(para);
      for (const piece of pieces) {
        if (buf && buf.length + piece.length + 2 > MAX_PASSAGE) { push(buf); buf = ''; }
        buf = buf ? `${buf}\n\n${piece}` : piece;
      }
    }
    if (buf) push(buf);
  }
  return out;
}

function chunkSentences(para) {
  const chunks = [];
  let cur = '';
  for (const s of splitSentences(para)) {
    const sentence = s.slice(0, MAX_PASSAGE);
    if (cur && cur.length + sentence.length + 1 > MAX_PASSAGE) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur} ${sentence}` : sentence;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function queryWeights(question) {
  const weights = new Map();
  for (const t of tokenize(question)) {
    weights.set(t, 1);
    for (const syn of SYNONYMS.get(t) || []) if (!weights.has(syn)) weights.set(syn, 0.5);
  }
  return weights;
}

function scoreAll(question, docs) {
  const passages = buildPassages(docs);
  const tokenLists = passages.map((p) => tokenize(p.text));
  const avgLen = tokenLists.reduce((s, t) => s + t.length, 0) / (tokenLists.length || 1);
  const df = new Map();
  for (const toks of tokenLists) for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  const N = passages.length;
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  const weights = queryWeights(question);
  const ranked = passages.map((passage, i) => {
    const toks = tokenLists[i];
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    const nameToks = new Set(tokenize(passage.fileName.replace(/\.[^.]+$/, '')));
    let score = 0;
    for (const [t, w] of weights) {
      const f = tf.get(t) || 0;
      if (f) score += w * idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * toks.length) / (avgLen || 1))));
      if (w === 1 && nameToks.has(t)) score += 0.5 * idf(t);
    }
    return { passage, score };
  });
  return { ranked: ranked.filter((r) => r.score > 0).sort((a, b) => b.score - a.score), idf, weights };
}

export function rankPassages(question, docs) {
  return scoreAll(question, docs).ranked;
}

const toCitation = (p, n) => ({ n, fileId: p.fileId, fileName: p.fileName, snippet: p.text.length > 240 ? `${p.text.slice(0, 239)}…` : p.text });

// [ \t] (not \s) so a marker never swallows the newline that separates two sentences.
const LINE_MARKERS = /^[ \t]*(?:#+[ \t]*|(?:[-*>]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]*)?)/gm;

// Passages scoring below this share of the best passage are noise ("spend" in an unrelated meeting).
const RELATIVE_CUTOFF = 0.6;
const MONEY_QUESTION = /\b(how much|costs?|spend|spent|budget|price|paid|pay|total|amount|expenses?)\b/i;
const HAS_AMOUNT = /[$€£]\s?\d|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|PKR)\b/;
const TOTAL_LINE = /\b(total|amount due|balance due)\b/i;

// CSV passages become one "first cell — column: value, ..." line per row; the header row is never an answer.
function candidateLines(passage) {
  if (passage.fileName.toLowerCase().endsWith('.csv')) {
    const [header, ...rows] = passage.text.split('\n');
    const cols = parseCsvLine(header);
    return rows.map((row) => {
      const cells = parseCsvLine(row);
      return `${cells[0]} — ${cols.slice(1).map((c, i) => `${c}: ${cells[i + 1] ?? ''}`).join(', ')}`;
    });
  }
  return splitSentences(passage.text.replace(LINE_MARKERS, ''));
}

export function answerOffline(question, docs) {
  const { ranked, idf, weights } = scoreAll(question, docs);
  const cutoff = Math.max(MIN_SCORE, (ranked[0]?.score ?? 0) * RELATIVE_CUTOFF);
  const top = ranked.filter((r) => r.score >= cutoff).slice(0, 3);
  if (top.length === 0) return { answer: NOT_FOUND, citations: [] };
  const termScore = (t) => (weights.has(t) ? weights.get(t) * idf(t) : 0);
  const maxTerm = Math.max(...[...weights.keys()].map(termScore));
  const moneyQuestion = MONEY_QUESTION.test(question);
  const lines = top.map(({ passage }, i) => {
    let best = '';
    let bestScore = -Infinity;
    for (const s of candidateLines(passage)) {
      let sc = [...new Set(tokenize(s))].reduce((sum, t) => sum + termScore(t), 0);
      // Headings like "SKYWAY TRAVEL AGENCY" or "Architecture" match words but answer nothing.
      if (s.split(/\s+/).length < 3 && !HAS_AMOUNT.test(s)) sc *= 0.3;
      // "How much…" questions want the line with the number, and the total over a line item.
      if (moneyQuestion && HAS_AMOUNT.test(s)) sc += maxTerm + (TOTAL_LINE.test(s) ? maxTerm / 2 : 0);
      if (sc > bestScore) { best = s; bestScore = sc; }
    }
    // Short lines ("Total: $842.60") need their file name to make sense on their own.
    const context = best.split(/\s+/).length < 6 ? ` (${passage.fileName})` : '';
    return `• ${best}${context} [${i + 1}]`;
  });
  return { answer: lines.join('\n'), citations: top.map((r, i) => toCitation(r.passage, i + 1)) };
}

const SYSTEM = 'You answer questions about the user\'s files using only the sources given. Cite every fact with its source number like [1].';

export async function ask(question, docs, { llm, log = () => {} } = {}) {
  if (!llm?.enabled()) return { ...answerOffline(question, docs), by: 'offline' };
  const top = rankPassages(question, docs).slice(0, 6);
  if (top.length === 0) return { answer: NOT_FOUND, citations: [], by: 'ai' };
  const sources = top.map((r, i) => `[${i + 1}] (${r.passage.fileName})\n${r.passage.text}`).join('\n\n');
  const prompt = `Question: ${question}\n\nSources:\n${sources}\n\nAnswer in under 120 words using ONLY these sources and cite them like [1]. If they don't contain the answer, reply exactly: ${NOT_FOUND}`;
  try {
    const answer = (await llm.complete(prompt, { system: SYSTEM, effort: 'medium' }))?.trim();
    if (!answer) throw new Error('AI returned an empty answer');
    const all = top.map((r, i) => toCitation(r.passage, i + 1));
    const used = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    const citations = used.size ? all.filter((c) => used.has(c.n)) : all;
    return { answer, citations: answer === NOT_FOUND ? [] : citations, by: 'ai' };
  } catch (err) {
    log('Search', `AI unavailable (${err.message}); answered with offline search instead.`);
    return { ...answerOffline(question, docs), by: 'offline' };
  }
}

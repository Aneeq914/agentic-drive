/**
 * Search agent: answers a plain-English question from the user's files, with numbered citations.
 *
 * ── IN SIMPLE WORDS ──
 * Think of a librarian who cuts every file into short passages, finds the
 * passages that best match your question, and reads you back the one line
 * from each that answers it best, saying exactly which file it came from
 * ("[1] q3-marketing-kickoff.md"). The librarian also checks that a line
 * really covers the question (all of "Acme payment terms", not just "terms"),
 * so a bigger drive full of look-alike files does not change the answer.
 * If an AI key is set, the AI writes the answer instead, but it only sees the
 * top passages and must cite them.
 *
 * ── BUSINESS RULES ──
 * - Spec "Search agent": answers must cite the files they come from; when
 *   nothing matches, reply NOT_FOUND ("I couldn't find that in your files.").
 * - Passages: blank-line paragraphs merged while under 200 chars, capped at
 *   600 (long paragraphs split at line breaks, keeping lines intact); a
 *   markdown heading always starts a new passage. A CSV passage is its header
 *   line plus up to 8 rows. Each passage remembers its file's first line (as
 *   the title, if <= 12 words) and the markdown heading it sits under.
 * - Ranking: BM25 (k1 1.2, b 0.75); query words expanded with SYNONYMS at
 *   weight 0.5; filler words ("much", "many", "long"…) are ignored. Bonuses:
 *   +0.5 x idf per query word in the file name / title / section heading,
 *   +0.5 x (idf a + idf b) per neighbouring query word pair written side by
 *   side ("Q3 revenue"). A passage must match a query word itself (in text or
 *   file name / title / heading) or two different query words via synonyms.
 *   Final score = BM25 x (0.5 + 0.5 x coverage), coverage = idf-weighted
 *   share of the query words the passage has.
 * - Offline answer: the best line of each of the top 10 passages (score >=
 *   MIN_SCORE 1.0 and >= 40% of the best), re-ranked by how much of the
 *   question that line covers;
 *   up to 3 lines "• <line> [n]", citation n = 1..3, at most 2 per file.
 *   Dropped: lines missing a name the question asks about (capitalised words,
 *   "Acme") when another line has it; lines covering < 70% of the best
 *   line's coverage; lines scoring < 60% of the best line.
 * - "How much…" questions want a line with an amount (a total over a line
 *   item) and take one line per file; "When…" questions want a date. A
 *   capitalised name that no file mentions ("Stripe") is NOT_FOUND.
 * - Read-back: CSV rows and markdown table rows become "first cell — column:
 *   value"; markdown bold/code marks are removed; lines under 6 words get
 *   their file name appended; a heading picked as an answer is followed by
 *   the line under it.
 * - Citation snippets (offline and AI) are the passage as plain text, max 240
 *   chars: heading marks, bullets, checkboxes, bold/code/emphasis marks and
 *   table pipes/rule lines are removed, a heading is followed by " — ",
 *   table cells are joined with " · ", and lines that do not end in
 *   punctuation (table rows, bullets) are joined with "; "; CSV passages are
 *   unchanged (test:
 *   "citation snippets read as plain text…"). The answer text is not
 *   affected — snippets are display-only.
 * - AI answer: top 6 ranked passages, numbered [1]..[6]; only the citations
 *   the answer actually uses are returned (all six if it cites none).
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - BM25 plus a small synonym table gives "meaning-ish" search with no vector
 *   DB and no network, so search still works with no AI key (tests: "synonyms
 *   count" — "spend" finds the "budget" passage).
 * - Passage BM25 alone made answers fragile: in the original 32-file demo
 *   drive (since removed from the repo) a decoy scored 0.56 of the best
 *   passage against a 0.6 cutoff, so one added file could flip the travel
 *   answer. Coverage (does the line cover every query
 *   word, counting its file name and heading?) separates them by a wide
 *   margin; test: "answers stay put when ~35 unrelated holdout files are
 *   added" (over the inline office drive in search.test).
 * - The synonym-only gate stops "cost" in an unrelated file from making it a
 *   "spend" answer (test: "a passage matching only a synonym…").
 * - Line-level re-ranking with a wide pool: the precise line is often in a
 *   long, lower-ranked passage ("Q3 revenue is forecast at $182,400" ranks
 *   below the churn report's summary). The phrase bonus is what lifts it
 *   (test: "office drive: each question gets its fact first…").
 * - The named-thing rule: "Acme" is in many files, so its idf is low and
 *   CloudNest's "Payment terms: Net 15" outscored Acme's MSA on words alone
 *   (tests: "answers about another named thing…", "no noise citations…").
 * - In a money question "spend"/"cost" counts as covered by the amount
 *   itself. Without it "Total: $842.60" (which never says "spend") covers
 *   only "travel", and its lead over decoy lines saying "spent $64,500" is
 *   thin again (tests: "money question…", "answers stay put…").
 * - Lines keep their line breaks when a long paragraph (PDF text) is split;
 *   joining them with spaces glued a resume's header into one 300-char
 *   "sentence" (tests: "a long paragraph is split at line breaks…", "a name
 *   heading picked as the answer…").
 * - Any AI failure (throw, empty reply) falls back to the offline answer and
 *   is logged, so a quota error never becomes a failed request (test:
 *   "ask falls back offline when AI throws").
 * - The AI only sees the top passages, so prompts stay small; if no passage
 *   is relevant the AI is not called at all and NOT_FOUND is returned, which
 *   stops the model answering from its own general knowledge.
 * - Citation numbers in the answer text and in `citations[].n` come from the
 *   same numbering, so the UI can link "[1]" to the right file.
 *
 * ── DO NOT ──
 * - Do not return citations the answer doesn't use (test: "keeps only cited
 *   sources") — the UI would show sources that support nothing.
 * - Do not clean passage.text itself for snippets: candidateLines() needs the
 *   raw "|" rows, "#" headings and "- [ ]" markers to read tables and
 *   headings. Clean a copy (snippetText) only.
 * - Do not renumber or reorder citations after filtering: `n` must keep
 *   matching the "[n]" markers in the answer text.
 * - Do not add SYNONYM_WORDS entries that are stopwords (e.g. "by" is
 *   dropped by tokenize()); they silently become no-ops.
 * - Do not tune the weights against one question. Run the whole search
 *   suite (the "office drive" tests and the holdout noise test) after any
 *   change: most tweaks that fix one
 *   question break another.
 * - Do not strip emails/URLs/#channels from the answer text; they are only
 *   left out of scoring (scoringText), because a name inside
 *   "priya.nair@example.com" is not a statement about Priya.
 * - Do not assume an unknown lowercase word ("zebra") gives NOT_FOUND: only
 *   capitalised names do (test: "a name that no file mentions…"). "What is
 *   the zebra migration schedule?" still answers with "migration"/"schedule"
 *   lines; a coverage floor would also drop real answers phrased in words
 *   the files don't use.
 */
import { tokenize, splitSentences } from '../text.js';
import { parseCsvLine } from './automations.js';

export const NOT_FOUND = "I couldn't find that in your files.";
const MAX_PASSAGE = 600;
// Paragraphs are merged into one passage only while the passage is shorter than this.
const MIN_PASSAGE = 200;
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
  pay: ['paid', 'charged', 'cost'],
  churn: ['lost', 'left', 'cancelled'],
};
const SYNONYMS = new Map(Object.entries(SYNONYM_WORDS).map(([k, vs]) => [tokenize(k)[0], vs.flatMap(tokenize)]));

// Words that shape a question ("how MUCH", "how LONG") but never name its topic.
const QUESTION_FILLER = new Set(['much', 'many', 'long', 'tell', 'show', 'find', 'give', 'know', 'get', 'got', 'please'].flatMap(tokenize));

// [ \t] (not \s) so a marker never swallows the newline that separates two sentences.
const LINE_MARKERS = /^[ \t]*(?:#+[ \t]*|(?:[-*>]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]*)?)/;
const isMarkdownHeading = (line) => /^[ \t]*#{1,6}[ \t]/.test(line);
const plainText = (s) => s.replace(/\*\*|__|`/g, '').replace(/[ \t]+/g, ' ').trim();
// Identifiers ("priya.nair@example.com", a URL, the "#build-day" channel) repeat words without
// saying anything about them, so they are left out of scoring (never out of the answer text).
const scoringText = (s) => s.replace(/\S+@\S+|https?:\/\/\S+|(^|\s)[#@][A-Za-z][\w-]*/g, ' ');

export function buildPassages(docs) {
  const out = [];
  for (const d of docs) {
    if (!d.text?.trim()) continue;
    // The file's title line ("# Brightleaf Build Day 2026 — …", "SKYWAY TRAVEL AGENCY") frames every passage.
    const firstLine = d.text.trim().split('\n')[0].replace(LINE_MARKERS, '').trim();
    const title = d.ext !== '.csv' && firstLine.split(/\s+/).length <= 12 ? plainText(firstLine) : '';
    let section = '';
    const push = (text) => out.push({ fileId: d.id, fileName: d.name, title, section, text: text.trim() });
    if (d.ext === '.csv') {
      const [header, ...rows] = d.text.split(/\r?\n/).filter((l) => l.trim());
      if (rows.length === 0) push(header);
      for (let i = 0; i < rows.length; i += CSV_ROWS) push([header, ...rows.slice(i, i + CSV_ROWS)].join('\n'));
      continue;
    }
    let buf = '';
    for (const para of d.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
      // A heading starts a new section, so it opens a new passage instead of trailing the last one.
      const first = para.split('\n')[0];
      if (isMarkdownHeading(first)) {
        if (buf) { push(buf); buf = ''; }
        section = plainText(first.replace(LINE_MARKERS, ''));
      }
      const pieces = para.length <= MAX_PASSAGE ? [para] : chunkLines(para);
      for (const piece of pieces) {
        if (buf && (buf.length >= MIN_PASSAGE || buf.length + piece.length + 2 > MAX_PASSAGE)) { push(buf); buf = ''; }
        buf = buf ? `${buf}\n\n${piece}` : piece;
      }
    }
    if (buf) push(buf);
  }
  return out;
}

// Splits a long paragraph at line breaks (by sentence only inside an over-long line), keeping the
// line structure that answer-line picking, headings and tables depend on.
function chunkLines(para) {
  const units = para.split('\n').flatMap((line) => (line.length <= MAX_PASSAGE ? [line] : splitSentences(line).map((s) => s.slice(0, MAX_PASSAGE))));
  const chunks = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.length + 1 > MAX_PASSAGE) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${u}` : u;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Runs of capitalised words after the first ("Acme", "Q3", "Build Day", "Priya Nair") name the
// things the question is about; each run is one entity, as a list of its tokens.
function questionEntities(question) {
  const runs = [];
  let run = [];
  for (const w of String(question).split(/\s+/).slice(1)) {
    if (/^[^A-Za-z0-9]*[A-Z0-9]/.test(w) && /[A-Za-z]/.test(w)) run.push(...tokenize(w));
    else { if (run.length) runs.push(run); run = []; }
    if (/[,.;:?!]$/.test(w) && run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs;
}

/**
 * The parsed question: one group per distinct question word (the word at weight 1 plus its
 * synonyms at 0.5), with `entities` (named things) and `pairs` (neighbouring words, stopwords
 * skipped: "Q3 revenue", "payment terms") attached.
 */
function queryGroups(question) {
  const seq = tokenize(question).filter((t) => !QUESTION_FILLER.has(t));
  const terms = seq.length ? [...new Set(seq)] : [...new Set(tokenize(question))];
  const groups = terms.map((term) => {
    const members = new Map([[term, 1]]);
    for (const syn of SYNONYMS.get(term) || []) if (!members.has(syn)) members.set(syn, 0.5);
    return { term, members };
  });
  groups.entities = questionEntities(question);
  groups.pairs = seq.slice(1).map((t, i) => [seq[i], t]).filter(([a, b]) => a !== b);
  return groups;
}

function queryWeights(groups) {
  const weights = new Map();
  for (const g of groups) weights.set(g.term, 1);
  for (const g of groups) for (const [t, w] of g.members) if (!weights.has(t)) weights.set(t, w);
  return weights;
}

// The question's word pairs that appear side by side in this token sequence.
function pairsIn(pairs, seq) {
  const adjacent = new Set(seq.slice(1).map((t, i) => `${seq[i]} ${t}`));
  return pairs.filter(([a, b]) => adjacent.has(`${a} ${b}`));
}

// What a passage is "about" beyond its own words: its file name, the file's title and its section heading.
const contextLines = (p) => [p.fileName.replace(/\.[^.]+$/, ''), p.title || '', p.section || ''].map(tokenize);
const contextTokens = (p) => new Set(contextLines(p).flat());
const contextPairs = (pairs, p) => pairs.filter((pair) => contextLines(p).some((seq) => pairsIn([pair], seq).length));

/**
 * How much of the question a set of tokens answers: per question word, the best idf-weighted
 * match (the word, or a synonym at half weight; `contextHas` counts for the word itself), summed
 * and divided by the total idf of the question words, so coverage 1.0 = every word covered.
 */
function coverageOf(groups, idf, has, contextHas = () => false) {
  let got = 0;
  let total = 0;
  let direct = false;
  let matched = 0;
  for (const g of groups) {
    const full = idf(g.term);
    total += full;
    let best = 0;
    for (const [t, w] of g.members) if (has(t)) best = Math.max(best, w * idf(t));
    if (has(g.term) || contextHas(g.term)) { best = full; direct = true; }
    if (best > 0) matched += 1;
    got += Math.min(best, full);
  }
  return { coverage: total ? got / total : 0, direct, matched, points: got };
}

function scoreAll(question, docs) {
  const passages = buildPassages(docs);
  const tokenLists = passages.map((p) => tokenize(scoringText(p.text)));
  const avgLen = tokenLists.reduce((s, t) => s + t.length, 0) / (tokenLists.length || 1);
  const df = new Map();
  for (const toks of tokenLists) for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  const N = passages.length;
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  const groups = queryGroups(question);
  const weights = queryWeights(groups);
  const ranked = [];
  passages.forEach((passage, i) => {
    const toks = tokenLists[i];
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    const context = contextTokens(passage);
    let bm25 = 0;
    for (const [t, w] of weights) {
      const f = tf.get(t) || 0;
      if (f) bm25 += w * idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * toks.length) / (avgLen || 1))));
      if (w === 1 && context.has(t)) bm25 += 0.5 * idf(t);
    }
    if (bm25 <= 0) return;
    // "Q3 revenue" written as a phrase is stronger evidence than the two words apart; a file titled
    // with the phrase ("remote-work-policy.md") counts as much as a sentence using it.
    const inContext = contextPairs(groups.pairs, passage);
    const inText = pairsIn(groups.pairs, toks);
    for (const pair of groups.pairs) if (inContext.includes(pair) || inText.includes(pair)) bm25 += 0.5 * (idf(pair[0]) + idf(pair[1]));
    const cov = coverageOf(groups, idf, (t) => tf.has(t), (t) => context.has(t));
    // A lone synonym ("cost" for a "spend" question) is too weak to make a passage relevant.
    if (!cov.direct && cov.matched < 2) return;
    // Passages covering more of the question's words beat ones that repeat one rare word.
    ranked.push({ passage, score: bm25 * (0.5 + 0.5 * cov.coverage), coverage: cov.coverage });
  });
  // A name the question asks about ("Stripe") that no file mentions, in its text, name or headings.
  const fileWords = new Set(passages.flatMap((p) => [...contextTokens(p)]));
  const unknownEntity = groups.entities.some((e) => e.every((t) => !df.has(t) && !fileWords.has(t)));
  return { ranked: ranked.sort((a, b) => b.score - a.score), idf, groups, unknownEntity };
}

export function rankPassages(question, docs) {
  return scoreAll(question, docs).ranked;
}

// The UI shows a snippet as plain text: "## Discussion\n- [ ] **Sara** will…" reads as
// "Discussion — Sara will…", and table rows read "Launch ads · $5,000". CSV passages stay as they are.
function snippetText(p) {
  if (p.fileName.toLowerCase().endsWith('.csv')) return p.text;
  const parts = [];
  for (const raw of p.text.split('\n')) {
    if (!raw.trim() || isTableRule(raw)) continue;
    const heading = isMarkdownHeading(raw);
    // Markers go twice: "## 2. What we propose" and "**5. Q4.**" only show their number once the
    // first marker / the bold marks are gone.
    let line = /^\s*\|/.test(raw) ? tableCells(raw).filter(Boolean).join(' · ') : plainText(raw.replace(LINE_MARKERS, '')).replace(LINE_MARKERS, '');
    // Single *emphasis* / _emphasis_ marks.
    line = line.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,;:!?]|$)/g, '$1$2');
    if (!line) continue;
    // A heading leads into its text; table rows and unpunctuated bullets would run together, so "; ".
    const prev = parts[parts.length - 1];
    const sep = !prev ? '' : prev.heading ? ' — ' : /[.!?:;]$/.test(prev.line) ? ' ' : '; ';
    parts.push({ line, heading, sep });
  }
  const text = parts.map((p) => p.sep + p.line).join('');
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

const toCitation = (p, n) => ({ n, fileId: p.fileId, fileName: p.fileName, snippet: snippetText(p) });

// The best line of this many top passages (each >= POOL_CUTOFF of the best) competes for the answer.
const POOL_SIZE = 10;
const POOL_CUTOFF = 0.4;
// Answer lines scoring below this share of the best line are noise ("spend" in an unrelated meeting)…
const RELATIVE_CUTOFF = 0.6;
// …and so are lines covering much less of the question than the best-covering line.
const COVERAGE_CUTOFF = 0.7;
const MAX_ANSWERS = 3;
const MAX_PER_FILE = 2;
const MAX_LINE = 320;
const MONEY_QUESTION = /\b(how much|costs?|spend|spent|budget|price|paid|pay|total|amount|expenses?|revenue|income|salary|fees?)\b/i;
const MONEY_TERMS = tokenize('cost costs spend spent price paid pay total amount expense expenses revenue income salary fee fees budget');
const HAS_AMOUNT = /[$€£]\s?\d|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:USD|EUR|GBP|PKR)\b|\b(?:USD|EUR|GBP|PKR)\s?\d/;
const TOTAL_LINE = /\b(total|amount due|balance due)\b/i;
const WHEN_QUESTION = /^\s*when\b|\b(?:what|which) (?:date|day)\b|\bby when\b/i;
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const HAS_DATE = new RegExp(`\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b${MONTH}\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+${MONTH}\\b`, 'i');

const tableCells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map(plainText);
const isTableRule = (line) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
const asRow = (cols, cells) => `${cells[0]} — ${cols.slice(1).map((c, i) => `${c}: ${cells[i + 1] ?? ''}`).join(', ')}`;
// "SKYWAY TRAVEL AGENCY", "5. TERM", "## Budget", "**Clients lost**": labels a section, answers nothing.
const looksLikeHeading = (line) => isMarkdownHeading(line) || /^\s*\*\*[^*]+\*\*\s*$/.test(line)
  || (/[A-Z]/.test(line) && !/[a-z]/.test(line) && !HAS_AMOUNT.test(line));
const isLabel = (line) => line.heading || (line.text.split(/\s+/).length < 3 && !HAS_AMOUNT.test(line.text));

/**
 * The candidate answer lines of a passage: { text, heading, under, next }. `under` holds the
 * tokens of the heading the line sits right under (same block), `next` the following line's text.
 */
function candidateLines(passage) {
  if (passage.fileName.toLowerCase().endsWith('.csv')) {
    // The header row is never an answer.
    const [header, ...rows] = passage.text.split('\n');
    const cols = parseCsvLine(header);
    return rows.map((row) => ({ text: asRow(cols, parseCsvLine(row)), heading: false, under: [], next: '' }));
  }
  const out = [];
  const raw = passage.text.split('\n');
  let cols = null;
  // "## Prizes\nFirst place gets PKR 50,000" is about prizes even though the sentence never says so.
  let under = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    if (!line.trim()) { cols = null; under = []; continue; }
    if (/^\s*\|/.test(line)) {
      // Markdown table rows read like CSV rows: "Sessions — August: 16,446, September: 18,420".
      if (isTableRule(line)) continue;
      const cells = tableCells(line);
      if (!cols && isTableRule(raw[i + 1] || '')) { cols = cells; continue; }
      out.push({ text: cols ? asRow(cols, cells) : cells.filter(Boolean).join(', '), heading: false, under });
      continue;
    }
    cols = null;
    const heading = looksLikeHeading(line);
    // PDF text wraps mid-sentence; a following line that starts in lower case continues this one.
    while (!heading && i + 1 < raw.length && /^[ \t]*[a-z]/.test(raw[i + 1]) && !/[.!?:]\s*$/.test(line)) line = `${line} ${raw[++i].trim()}`;
    const sentences = splitSentences(plainText(line.replace(LINE_MARKERS, '')));
    for (const s of sentences) out.push({ text: s, heading, under: heading ? [] : under });
    if (heading) under = sentences.flatMap(tokenize);
  }
  for (let i = 0; i < out.length; i++) out[i].next = out[i + 1] && !out[i + 1].heading ? out[i + 1].text : '';
  return out;
}

export function answerOffline(question, docs) {
  const { ranked, idf, groups, unknownEntity } = scoreAll(question, docs);
  // "How much did we pay Stripe?" when no file mentions Stripe: other vendors' amounts are not an answer.
  if (unknownEntity) return { answer: NOT_FOUND, citations: [] };
  const bestScore = ranked[0]?.score ?? 0;
  const pool = ranked.filter((r) => r.score >= Math.max(MIN_SCORE, bestScore * POOL_CUTOFF)).slice(0, POOL_SIZE);
  if (pool.length === 0) return { answer: NOT_FOUND, citations: [] };
  const maxTerm = Math.max(...groups.map((g) => idf(g.term)));
  const moneyQuestion = MONEY_QUESTION.test(question);
  const whenQuestion = WHEN_QUESTION.test(question);

  const picks = pool.map(({ passage, score }) => {
    // 1. The passage's best line.
    let best = null;
    let bestLine = -Infinity;
    for (const line of candidateLines(passage)) {
      const seq = tokenize(scoringText(line.text));
      const toks = new Set(seq);
      const under = new Set(line.under);
      // Words of the heading right above count half: they frame the line but are not in it.
      const own = coverageOf(groups, idf, (t) => toks.has(t)).points;
      let sc = (own + coverageOf(groups, idf, (t) => toks.has(t) || under.has(t)).points) / 2;
      // Headings like "SKYWAY TRAVEL AGENCY" or "Architecture" match words but answer nothing.
      if (isLabel(line)) sc *= 0.3;
      // "How much…" questions want the line with the number, and the total over a line item.
      if (moneyQuestion && HAS_AMOUNT.test(line.text)) sc += maxTerm + (TOTAL_LINE.test(line.text) ? 0.75 * maxTerm : 0);
      // "When…" questions want the line with the date.
      if (whenQuestion && HAS_DATE.test(line.text)) sc += maxTerm;
      if (sc > bestLine) { best = { ...line, toks, phrases: pairsIn(groups.pairs, seq) }; bestLine = sc; }
    }
    if (!best) return null;

    // 2. How well that line answers the question, compared across passages.
    const context = contextTokens(passage);
    // In a money question "spend" / "cost" is answered by the amount itself ("Total: $842.60").
    const said = moneyQuestion && HAS_AMOUNT.test(best.text) ? new Set([...best.toks, ...MONEY_TERMS]) : best.toks;
    const own = coverageOf(groups, idf, (t) => said.has(t)).coverage;
    const inContext = coverageOf(groups, idf, (t) => said.has(t), (t) => context.has(t)).coverage;
    const { entities } = groups;
    const entityShare = entities.length ? entities.filter((e) => e.some((t) => best.toks.has(t) || context.has(t))).length / entities.length : 1;
    const phrased = new Set([...best.phrases, ...contextPairs(groups.pairs, passage)]).size;
    // A "how much" / "when" question is not answered by a line without an amount / a date.
    const rightKind = (!moneyQuestion && !whenQuestion) || (moneyQuestion && HAS_AMOUNT.test(best.text)) || (whenQuestion && HAS_DATE.test(best.text));
    const answerScore = (score / bestScore) * (0.4 + 0.4 * own + 0.2 * inContext) * (0.5 + 0.5 * entityShare)
      * (rightKind ? 1 : 0.5) * (isLabel(best) ? 0.5 : 1) * (1 + (0.25 * phrased) / (groups.pairs.length || 1));
    return { passage, line: best, answerScore, inContext, entityShare };
  }).filter(Boolean).sort((a, b) => b.answerScore - a.answerScore);

  // 3. Drop lines missing a name the question asks about ("Acme") when another line has it, then
  //    lines covering much less of the question than the best-covering one.
  const topEntities = Math.max(0, ...picks.map((p) => p.entityShare));
  const named = picks.filter((p) => p.entityShare >= topEntities);
  const topCoverage = Math.max(0, ...named.map((p) => p.inContext));
  const eligible = named.filter((p) => p.inContext >= topCoverage * COVERAGE_CUTOFF);
  const topAnswer = eligible[0]?.answerScore ?? 0;
  const seen = new Set();
  const perFile = new Map();
  const chosen = [];
  for (const p of eligible) {
    if (chosen.length === MAX_ANSWERS) break;
    if (p.answerScore < topAnswer * RELATIVE_CUTOFF) continue;
    // A generated copy (e.g. "kickoff - action items.md") can hold the same sentence; answer it once.
    const key = p.line.text.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    // A file states one figure per money question (more amounts are its line items); other
    // questions take two lines per file at most, leaving room for a second source.
    const fromFile = perFile.get(p.passage.fileId) || 0;
    if (fromFile >= (moneyQuestion ? 1 : MAX_PER_FILE)) continue;
    seen.add(key);
    perFile.set(p.passage.fileId, fromFile + 1);
    chosen.push(p);
  }
  if (chosen.length === 0) return { answer: NOT_FOUND, citations: [] };

  const lines = chosen.map(({ passage, line }, i) => {
    let text = line.text;
    // A heading on its own ("Priya Nair") says little; read on into the line below it.
    if (isLabel(line) && !HAS_AMOUNT.test(text) && line.next) text = `${text} — ${line.next}`;
    if (text.length > MAX_LINE) text = `${text.slice(0, MAX_LINE - 1).trimEnd()}…`;
    // Short lines ("Total: $842.60") need their file name to make sense on their own.
    const context = text.split(/\s+/).length < 6 ? ` (${passage.fileName})` : '';
    return `• ${text}${context} [${i + 1}]`;
  });
  return { answer: lines.join('\n'), citations: chosen.map(({ passage }, i) => toCitation(passage, i + 1)) };
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

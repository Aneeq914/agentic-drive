/**
 * Offline document classifier: decides a file's kind (sidebar category) and its topic label.
 *
 * ── IN SIMPLE WORDS ──
 * When a file is uploaded, something has to decide which shelf it goes on:
 * Invoices, Meeting Notes, Contracts, Proposals, Specs, Reports, Data,
 * People & HR, or Other. This module does it without any AI, the way a
 * person skims a page: does it LOOK like an invoice (an "Invoice Number:"
 * line, a "Bill To:" line, a total), or does it just TALK about invoices?
 * Looks count a lot, a matching title counts some, and loose words count
 * only a little. If nothing clearly wins, the file goes to Other rather
 * than onto the wrong shelf. It also picks a topic (Finance, Marketing, ...)
 * as a second label, or none when it is unclear.
 *
 * ── BUSINESS RULES ──
 * - Kinds, labels and order are fixed (spec §3, plan Global Constraints):
 *   invoice, meeting, contract, proposal, spec, report, data, people, other.
 *   Topics: Finance, Marketing, Engineering, Sales, HR, Legal, Operations,
 *   Product, or null.
 * - Every .csv is kind `data` with confidence `high` (spec §4).
 * - Forced topics: invoice → Finance, people → HR, contract → Legal (plan
 *   Global Constraints).
 * - Scoring (spec §4): each distinct structural line = 3 points; title words
 *   (file name + first line) = 2 each, capped at 4; body words = 0.5 each,
 *   capped at 3 per kind.
 * - Invoice gate (spec §4): a file is only an invoice with 2+ distinct invoice
 *   structure signals AND a money amount; otherwise its invoice score is
 *   capped at 2. Verified by the test where a hackathon brief that describes
 *   an invoice workflow comes out `proposal`, and by the real brief PDF.
 * - Confidence (spec §4): high = top ≥ 6 and leads by ≥ 3; medium = top ≥ 3
 *   and leads by ≥ 1.5; otherwise low, and low is filed as `other` (plan
 *   Review Focus #2). Empty text is `other`/low.
 * - runnerUp is the hint for the UI's "Looks like a Report?" (spec §4). It is
 *   null when that kind scored 0 (decision 2026-10-14, Task 1: a plant note
 *   was being hinted as an invoice).
 * - Topic: keyword hits, with file-name words counted ×2; for CSV only the
 *   header row and file name count; fewer than 2 hits → null (spec §4). Note:
 *   hits are NOT normalised by text length (the spec mentions it; the plan's
 *   code does not do it).
 * - Accuracy tuning (plan Task 6, 2026-10-14): general document conventions,
 *   each with a unit test in test/classifier.test.js:
 *   · contract: a "Statement of Work" title, an "entered into ... between"
 *     recital, a "Signed for X:" signature block (spec §3: SOWs are contracts).
 *   · people: cover letters ("Dear Hiring ...", "apply for the ... role",
 *     "my CV/resume") and job ads ("About the role" / "You will" / "You have"
 *     / "We offer ... salary").
 *   · report: incident reviews ("What happened", "Root cause", "Lessons
 *     learned") and articles (a "N min read" reading time, or a "By First
 *     Last" byline in the first 300 characters). Spec §3: articles are reports.
 *   · spec: RFC/design-doc sections ("Alternatives considered", "Open
 *     questions", "Rollout"), a lifecycle "Status:" (Proposed, In progress,
 *     Complete...), a "Risks" heading, and a milestone/task table with owner
 *     or target-date columns (spec §3: project plans are specs).
 *   · proposal: a pitch that lists "What's included" and a "Budget:" /
 *     "Estimated cost:" line with an amount.
 *   · topic: a proposal with a "Prepared for:" / "Valid until:" line is a
 *     client quote → Sales (only for kind proposal). Engineering words now
 *     include prototype/hackathon/stack/llm and incident words (config,
 *     rollback, outage, incident, kubernetes); Operations words include
 *     furniture/movers/relocation/premises (office moves).
 *   Measured when tuned: test/accuracy.test.js gave 32/32 samples (kind +
 *   topic) and 16/16 holdout kinds (the test itself requires 100% / ≥ 85%).
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - Structure (×3) outweighs mentions and body words are capped. Without
 *   this, a brief or meeting notes that say "invoice" many times get filed as
 *   invoices (the original bug this module fixes; tested by the brief and the
 *   "finance sync" meeting tests).
 * - Low confidence goes to Other instead of the top guess. A wrong confident
 *   folder hides the file; Other tells the user to check it.
 * - `data` and `other` never compete in the ranking: `data` comes only from
 *   the .csv rule and `other` only from low confidence.
 * - Label-line patterns built with L() are anchored to the start of a line
 *   (after optional markdown/bullet/number markers), so a mid-sentence phrase
 *   ("the total due was $40") does not count as an invoice label line. A few
 *   phrase patterns ("this agreement", "the parties", "meeting minutes",
 *   "curriculum vitae") match anywhere on purpose, because they are strong
 *   on their own.
 * - Every Task 6 signal is one more distinct structure (3 points), not a
 *   bigger weight, so a document needs several conventions of a kind to win
 *   confidently. E.g. the SOW unit test has a "Deliverables" heading
 *   (proposal +3) but three contract structures, so it stays a contract.
 * - "What went well" is deliberately NOT a report signal: retrospectives use
 *   it and are meeting notes.
 * - The byline rule only looks at the top of the text (nearTop): a sentence
 *   such as "By Friday Morning ..." deep in a note must not add report points
 *   (tested).
 * - The client-proposal → Sales topic rule is limited to kind `proposal`:
 *   reports are also "prepared for" the board and must keep their keyword
 *   topic (tested).
 *
 * ── DO NOT ──
 * - Do not remove or loosen the invoice gate, and do not let body-word scores
 *   grow uncapped: both bring back "brief filed as invoice".
 * - Do not add the `g` flag to STRUCTURE regexes: `.test()` on a global regex
 *   keeps `lastIndex` between calls and silently skips matches on later files.
 * - Do not add file-name-specific rules for one sample; add a general pattern
 *   and a unit test for it.
 * - Do not tune by copying phrases from test/fixtures/holdout/: it is the
 *   check that the rules generalise. Never edit labels to make tests pass.
 * - Do not reorder or rename KINDS ids/TOPICS: the API (/api/meta), stored
 *   records and the UI depend on them.
 */
import { tokenize } from '../text.js';

export const KINDS = [
  { id: 'invoice', label: 'Invoices & Receipts' },
  { id: 'meeting', label: 'Meeting Notes' },
  { id: 'contract', label: 'Contracts & Agreements' },
  { id: 'proposal', label: 'Proposals & Briefs' },
  { id: 'spec', label: 'Specs & Plans' },
  { id: 'report', label: 'Reports' },
  { id: 'data', label: 'Spreadsheets & Data' },
  { id: 'people', label: 'People & HR' },
  { id: 'other', label: 'Other' },
];
export const KIND_IDS = KINDS.map((k) => k.id);
export const kindLabel = (id) => KINDS.find((k) => k.id === id)?.label ?? 'Other';
export const TOPICS = ['Finance', 'Marketing', 'Engineering', 'Sales', 'HR', 'Legal', 'Operations', 'Product'];
export const FORCED_TOPIC = { invoice: 'Finance', people: 'HR', contract: 'Legal' };

// A line that starts (after optional markdown/bullet/number markers) with `pattern`.
const L = (pattern) => new RegExp(`^[ \\t]*(?:[#*•>\\-]+[ \\t]*)?(?:\\d+[.)][ \\t]*)?(?:${pattern})`, 'im');

// Like a regex, but only looks at the first `chars` characters (for things that only mean something at the top, e.g. bylines).
const nearTop = (re, chars = 300) => ({ test: (text) => re.test(String(text).slice(0, chars)) });

// Structural signals: each distinct match is worth 3 points. Structure beats mentions.
const STRUCTURE = {
  invoice: [L('invoice\\s*(?:number|no\\.?|#)'), L('bill(?:ed)?\\s+to\\b'), L('(?:total\\s+due|amount\\s+due|balance\\s+due|grand\\s+total)\\b'),
    L('(?:receipt|tax\\s+invoice|invoice)[ \\t]*$'), L('total\\s*:?\\s*[$€£]?\\s*\\d'), L('(?:subtotal|tax|vat)\\b.*\\d'), L('(?:payment\\s+terms|due\\s+date)\\s*:')],
  meeting: [L('(?:attendees|participants|present)\\s*:'), L('agenda\\b'), L('action\\s+items?\\b'), /\bmeeting\s+minutes\b/i, L('(?:discussion|decisions|next\\s+steps)[ \\t]*$')],
  contract: [/\bthis\s+(?:agreement|contract)\b/i, L('whereas\\b'), L('term(?:\\s+and\\s+termination)?[ \\t]*$'), L('(?:confidentiality|governing\\s+law|indemnification|limitation\\s+of\\s+liability)\\b'),
    // "Signature:", "By:", and signature blocks such as "Signed for Supplier: ____".
    L('(?:signature|signed(?:\\s+(?:for|on\\s+behalf\\s+of)\\b[^:\\n]{0,40})?|by)\\s*:'), /\bthe\s+parties\b/i,
    // A document titled "Statement of Work" is a contract (spec §3 lists SOWs under contracts).
    L('statement\\s+of\\s+work\\b'),
    // Contract recitals: "is entered into ... between A and B".
    /\bentered\s+into\b[^.\n]{0,120}\bbetween\b/i],
  proposal: [L('(?:the\\s+core\\s+)?problem(?:\\s+statement)?\\b'), L('(?:proposal|proposed\\s+solution|our\\s+approach)\\b'), L('(?:objectives|goals)[ \\t]*$'), L('deliverables\\b'), L('(?:judging|evaluation)\\s+criteria\\b'), L('(?:pricing|investment|fees)[ \\t]*$'),
    // A pitch that lists "What's included" and puts a price on it ("Budget: $18k", "Estimated cost: ...").
    L("what(?:'|’)?s\\s+included\\b"), L('(?:budget|estimated\\s+(?:cost|budget|fees?)|cost\\s+estimate)\\s*:[^\\n]*(?:[$€£]|\\d)')],
  spec: [L('(?:functional\\s+|non-functional\\s+)?requirements[ \\t]*$'), L('acceptance\\s+criteria\\b'), L('architecture\\b'), L('(?:milestones|release\\s+plan|roadmap)\\b'), L('(?:user\\s+stories|out\\s+of\\s+scope)\\b'),
    // Lifecycle status of a plan or design doc (RFCs are "Proposed"/"Accepted"; project plans are "In progress"/"Complete").
    L('status\\s*:\\s*(?:draft|in\\s+review|approved|proposed|accepted|planned|in\\s+progress|on\\s+track|at\\s+risk|complete(?:d)?)\\b'),
    // RFC / design-doc sections.
    L('alternatives(?:\\s+considered)?[ \\t]*:?[ \\t]*$'), L('(?:open\\s+questions|unresolved(?:\\s+questions)?|rollout(?:\\s+plan)?)[ \\t]*:?[ \\t]*$'),
    // Project-plan sections: a "Risks" heading, and a table of milestones/tasks with owners or target dates.
    L('risks?(?:\\s+(?:and|&)\\s+(?:mitigations?|dependencies|assumptions))?(?:\\s*\\([^)\\n]*\\))?[ \\t]*:?[ \\t]*$'),
    /^[ \t]*\|[ \t]*(?:milestones?|tasks?)[ \t]*\|.*\b(?:owner|target|due|deadline)\b/im],
  report: [L('executive\\s+summary\\b'), L('(?:key\\s+)?findings\\b'), L('(?:conclusion|recommendations)\\b'), L('(?:key\\s+metrics|results|methodology)[ \\t]*$'),
    // Incident reviews / postmortems.
    L('(?:root\\s+cause(?:\\s+analysis)?|lessons\\s+learned)\\b'), L('what\\s+happened\\b'),
    // Articles and blog posts: a reading time ("6 min read"), or a byline near the top ("By Jane Doe": capitalised name, no colon).
    /\b\d+[ -]?min(?:ute)?s?\s+read\b/i, nearTop(/^[ \t]*[*_]*[Bb]y\s+[A-Z][\w'’.-]+\s+[A-Z][\w'’-]+/m)],
  people: [L('(?:work\\s+)?experience[ \\t]*$'), L('education[ \\t]*$'), L('skills[ \\t]*$'), L('(?:job\\s+title|position|reports\\s+to)\\s*:'), L('(?:responsibilities|qualifications)\\b'), /\b(?:curriculum\s+vitae|offer\s+letter|employee\s+handbook)\b/i,
    // Cover letters: "Dear Hiring Manager/Team", "apply for the ... role", "my CV" / "your resume".
    L('dear\\s+(?:hiring|recruit)'), /\bapply(?:ing)?\s+for\s+(?:the|a|this|your)\b[^.\n]{0,60}\b(?:role|position|job|vacancy)\b/i, /\b(?:my|your)\s+(?:cv|resume|résumé)\b/i,
    // Job-ad sections: "About the role", "You will", "What you'll do" / "You have", "Who you are", and "We offer ... salary/benefits".
    L("(?:about\\s+the\\s+(?:role|job|position)|what\\s+you(?:'|’)?ll\\s+do|you\\s+will)[ \\t]*:?[ \\t]*$"),
    L("(?:you\\s+have|who\\s+you\\s+are|what\\s+we(?:'|’)?re\\s+looking\\s+for|nice\\s+to\\s+have)[ \\t]*:?[ \\t]*$"),
    /\bwe\s+offer\b[^\n]{0,80}\b(?:salary|pension|holiday|benefits|equity|insurance)\b/i],
};

// Title signals (file name + first line): 2 points per matched word, capped at 4.
const TITLE_WORDS = {
  invoice: ['invoice', 'receipt', 'bill'],
  meeting: ['meeting', 'minutes', 'standup', 'sync', 'retro', 'kickoff', 'retrospective', 'one-on-one', '1-1'],
  contract: ['agreement', 'contract', 'nda', 'msa', 'sow', 'lease', 'terms'],
  proposal: ['proposal', 'brief', 'rfp', 'pitch', 'problem', 'challenge', 'hackathon'],
  spec: ['spec', 'specification', 'prd', 'requirements', 'roadmap', 'plan', 'rfc', 'design'],
  report: ['report', 'analysis', 'review', 'research', 'survey', 'postmortem', 'insights', 'article', 'study', 'incident', 'blog'],
  people: ['resume', 'cv', 'job', 'description', 'offer', 'policy', 'handbook', 'onboarding', 'hiring'],
};

// Body words: 0.5 per occurrence, capped at 3 per kind, so mentions alone can't win.
const BODY_WORDS = {
  invoice: ['invoice', 'payment', 'paid', 'amount', 'due', 'receipt'],
  meeting: ['discussed', 'agreed', 'attendees', 'meeting', 'follow-up', 'decided'],
  contract: ['shall', 'party', 'parties', 'hereby', 'obligations', 'termination', 'liability', 'clause'],
  proposal: ['propose', 'proposal', 'objective', 'deliverable', 'challenge', 'participants', 'submission', 'quote', 'estimate', 'pitch'],
  spec: ['must', 'requirement', 'api', 'endpoint', 'latency', 'implement'],
  report: ['analysis', 'findings', 'trend', 'percent', 'growth', 'compared', 'data'],
  people: ['experience', 'candidate', 'employee', 'salary', 'hiring', 'skills', 'role'],
};

const stems = (words) => new Set(words.flatMap((w) => tokenize(w)));
const TITLE_STEMS = Object.fromEntries(Object.entries(TITLE_WORDS).map(([k, w]) => [k, stems(w)]));
const BODY_STEMS = Object.fromEntries(Object.entries(BODY_WORDS).map(([k, w]) => [k, stems(w)]));
const MONEY = /[$€£]\s?\d|\b\d[\d,]*\.\d{2}\b|\b\d[\d,]*\s?(?:USD|EUR|GBP|PKR)\b/;

function titleTokens(name, text) {
  const firstLine = String(text).split(/\r?\n/).find((l) => l.trim()) ?? '';
  return tokenize(`${name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')} ${firstLine}`);
}

export function classifyKind({ name, ext, text }) {
  const empty = Object.fromEntries(KIND_IDS.map((id) => [id, 0]));
  if (ext === '.csv') return { kind: 'data', confidence: 'high', scores: { ...empty, data: 10 }, runnerUp: null };
  if (!String(text).trim()) return { kind: 'other', confidence: 'low', scores: empty, runnerUp: null };
  const title = titleTokens(name, text);
  const body = tokenize(text);
  const scores = { ...empty };
  const invoiceSignals = STRUCTURE.invoice.filter((re) => re.test(text)).length;
  for (const kind of Object.keys(STRUCTURE)) {
    const structure = STRUCTURE[kind].filter((re) => re.test(text)).length * 3;
    const titleScore = Math.min(4, title.filter((t) => TITLE_STEMS[kind].has(t)).length * 2);
    const bodyScore = Math.min(3, body.filter((t) => BODY_STEMS[kind].has(t)).length * 0.5);
    scores[kind] = structure + titleScore + bodyScore;
  }
  // Invoice gate: it must LOOK like an invoice (2+ distinct invoice structures and money), not just mention one.
  if (invoiceSignals < 2 || !MONEY.test(text)) scores.invoice = Math.min(scores.invoice, 2);
  const ranked = Object.entries(scores).filter(([id]) => id !== 'data' && id !== 'other').sort((a, b) => b[1] - a[1]);
  const [[top, topScore], [second, secondScore]] = ranked;
  const lead = topScore - secondScore;
  const confidence = topScore >= 6 && lead >= 3 ? 'high' : topScore >= 3 && lead >= 1.5 ? 'medium' : 'low';
  // A runner-up with zero evidence would make the UI ask "Looks like an invoice?" about a plant note.
  const hint = confidence === 'low' ? [top, topScore] : [second, secondScore];
  return { kind: confidence === 'low' ? 'other' : top, confidence, scores, runnerUp: hint[1] > 0 ? hint[0] : null };
}

const TOPIC_WORDS = {
  Finance: ['budget', 'invoice', 'payment', 'expense', 'cost', 'revenue', 'tax', 'accounting', 'cash', 'profit', 'forecast', 'spend', 'finance', 'billing', 'price'],
  Marketing: ['marketing', 'campaign', 'brand', 'social', 'ads', 'advertising', 'seo', 'audience', 'newsletter', 'influencer', 'content'],
  Engineering: ['api', 'code', 'database', 'server', 'deploy', 'bug', 'architecture', 'backend', 'frontend', 'infrastructure', 'latency', 'engineering', 'mobile', 'sprint',
    'prototype', 'hackathon', 'stack', 'llm', 'config', 'rollback', 'outage', 'incident', 'kubernetes'],
  Sales: ['sales', 'customer', 'deal', 'pipeline', 'lead', 'prospect', 'quota', 'crm', 'client', 'renewal', 'upsell', 'stage'],
  HR: ['hiring', 'candidate', 'interview', 'employee', 'onboarding', 'salary', 'benefits', 'recruit', 'leave', 'hr', 'resume', 'headcount', 'payroll'],
  Legal: ['contract', 'agreement', 'clause', 'liability', 'compliance', 'legal', 'nda', 'confidentiality', 'gdpr', 'indemnification'],
  Operations: ['operations', 'vendor', 'logistics', 'supply', 'office', 'facilities', 'travel', 'procurement', 'process', 'equipment',
    'furniture', 'movers', 'relocation', 'premises'],
  Product: ['product', 'roadmap', 'feature', 'users', 'ux', 'design', 'prd', 'persona', 'usability', 'research'],
};
const TOPIC_STEMS = Object.fromEntries(Object.entries(TOPIC_WORDS).map(([t, w]) => [t, stems(w)]));
const MIN_TOPIC_HITS = 2;
// A proposal addressed to a client ("Prepared for: ..." / "Valid until: ...") is a sales quote,
// whatever product or service it sells.
const CLIENT_PROPOSAL = L('(?:prepared\\s+for|valid\\s+until)\\b[^\\n]*:');

export function classifyTopic({ name, ext, text }, kind) {
  if (FORCED_TOPIC[kind]) return FORCED_TOPIC[kind];
  if (kind === 'proposal' && CLIENT_PROPOSAL.test(String(text))) return 'Sales';
  const body = ext === '.csv' ? String(text).split(/\r?\n/)[0] ?? '' : String(text);
  const tokens = [...tokenize(body), ...tokenize(name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')).flatMap((t) => [t, t])];
  let best = null;
  let bestScore = MIN_TOPIC_HITS - 1;
  for (const topic of TOPICS) {
    const score = tokens.filter((t) => TOPIC_STEMS[topic].has(t)).length;
    if (score > bestScore) { best = topic; bestScore = score; }
  }
  return best;
}

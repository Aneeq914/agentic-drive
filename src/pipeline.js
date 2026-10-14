/**
 * Upload pipeline: extract text -> store -> Organizer -> Automations, plus the
 * startup migration and the user's "Move to…".
 *
 * ── IN SIMPLE WORDS ──
 * Every file that enters the drive walks the same conveyor belt: we read its
 * text, save it, let the Organizer put it on a shelf (a kind such as Invoices
 * or Meeting Notes, plus a topic label), then let the Automations react to it
 * (log an invoice, pull out action items). It also does two housekeeping
 * jobs: when the server starts it re-sorts files saved by the old
 * folder-based version, and when the user moves a file by hand it records
 * that choice and pins it so no agent moves it back.
 *
 * ── BUSINESS RULES ──
 * - Spec §3 "Upload pipeline": organise first, then run enabled automations.
 * - `ownCompany` (the drive owner's company name, from the server) is passed
 *   to runAutomations so invoices the company sent are not logged as
 *   expenses (tested in server.test).
 * - Spec §4.4: automation output (expenses.csv, action-item files) is saved as
 *   agent-generated files; expenses.csv is one file updated in place.
 * - Generated files (categories plan Task 4): created with `generated: true`,
 *   confidence `high`, `pinned: false`; tags `generated`, kind, top terms.
 *   Updating an existing generated file replaces only its content + summary,
 *   so its kind/topic (or a user's move) are kept.
 * - A write's own `summary` (action-items files, synthesized documents) is
 *   used on both the create and the update path, capped at 160 chars;
 *   without one (expenses.csv) the summary is offlineSummary() of the content
 *   (tested in server.test: action-items summary incl. update, expenses.csv
 *   "Spreadsheet with N rows…", synthesize summary).
 * - Activity log (plan Task 4): `Filed "<name>" under <kind label> (topic:
 *   <topic|none>, confidence: <c>)`, "(AI)" when the AI decided, and for low
 *   confidence a "not sure; looks most like <runner-up>" hint (tested).
 * - migrate() (spec §5, Review Focus #4): every record without `kind` is
 *   re-sorted offline from its stored text, with no AI calls; its old
 *   `type`/`folder` fields are removed; it gets `pinned: false`. Generated
 *   files: .csv -> data/Finance; "action items" -> meeting with the old
 *   folder as topic if it is a valid topic; anything else -> report (topic:
 *   old folder if valid, else null). Logs "Re-sorted N files with the new
 *   categories." when N > 0. Tested: old invoice + expenses.csv + action
 *   items + synthesized doc, then a new invoice still appends to the same
 *   expenses.csv, and a second start migrates nothing.
 * - moveFile() (spec §5, Review Focus #3/#5): kind must be a KIND_IDS id and
 *   topic a TOPICS name or null; otherwise it throws with `.status = 400` and
 *   changes nothing. A valid move sets `pinned: true`, confidence `high` and
 *   logs `Moved "<name>" to <label> (pinned by you).` Unknown id -> null.
 *   Tested via PATCH /api/files/:id, including after a restart.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - Automations return planned writes and this module applies them, so the
 *   agents stay pure/testable. Without that, an automation could write files
 *   that re-enter ingest() and trigger itself in a loop.
 * - saveGenerated() updates an existing file by name; otherwise every invoice
 *   would create a new expenses.csv and the ledger would be split (tested
 *   after migration too).
 * - migrate() only touches records with no `kind`, so it is safe to run on
 *   every start: files already sorted, or moved and pinned by the user, are
 *   never re-sorted.
 * - migrate() is offline-only: a restart must not fire one AI call per old
 *   file, and it must work with no API key.
 * - Moving a file does not re-run automations: moving a report to Invoices
 *   must not add a row to expenses.csv behind the user's back.
 *
 * ── DO NOT ──
 * - Do not route generated files through ingest() (no Organizer/Automations
 *   on agent output) — that is what prevents automation loops.
 * - Do not create a second expenses.csv; always look it up by name.
 * - Do not re-classify records that already have a `kind` (that would undo
 *   a user's "Move to…").
 * - Do not accept kind/topic values outside KIND_IDS/TOPICS in moveFile().
 */
import path from 'node:path';
import { extractText } from './extract.js';
import { organize, organizeOffline, offlineSummary } from './agents/organizer.js';
import { runAutomations } from './agents/automations.js';
import { KIND_IDS, TOPICS, kindLabel } from './agents/classifier.js';
import { topTerms } from './text.js';

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

export function createPipeline({ store, llm, ownCompany = '' }) {
  const log = (agent, message) => store.addActivity(agent, message);
  const generatedTags = (kind, content) => [...new Set(['generated', kind, ...topTerms(content, 4)])];

  // `summary` (optional) comes from the agent that wrote the file; it knows better than a first sentence.
  function saveGenerated({ name, kind, topic = null, content, summary }) {
    const buffer = Buffer.from(content, 'utf8');
    const ext = path.extname(name).toLowerCase();
    const given = typeof summary === 'string' && summary.trim() ? summary.trim().slice(0, 160) : null;
    const existing = store.findByName(name);
    if (existing) {
      store.replaceContent(existing.id, buffer, content);
      return store.update(existing.id, { summary: given ?? offlineSummary(existing.kind ?? kind, ext, content) });
    }
    const rec = store.add({ name, buffer, text: content, source: 'agent', generated: true });
    return store.update(rec.id, {
      kind, topic, confidence: 'high', pinned: false,
      tags: generatedTags(kind, content),
      summary: given ?? offlineSummary(kind, ext, content),
    });
  }

  async function ingest({ name, buffer, source = 'upload' }) {
    const text = await extractText(buffer, name);
    const added = store.add({ name, buffer, text, source });
    const org = await organize({ name, ext: added.ext, text }, { llm, log });
    const record = store.update(added.id, { kind: org.kind, topic: org.topic, confidence: org.confidence, tags: org.tags, summary: org.summary });
    let message = `Filed "${name}" under ${kindLabel(org.kind)} (topic: ${org.topic ?? 'none'}, confidence: ${org.confidence})${org.by === 'ai' ? ' (AI)' : ''}`;
    if (org.confidence === 'low') {
      const hint = org.runnerUp ? `looks most like ${kindLabel(org.runnerUp)}` : 'it does not look like any category';
      message += ` — not sure; ${hint}. Use "Move to…" if it's wrong.`;
    } else {
      message += '.';
    }
    log('Organizer', message);
    const { writes, logs } = runAutomations({
      record, text, rules: store.getRules(), getFileText: (n) => store.findByName(n)?.text ?? null, ownCompany,
    });
    for (const w of writes) saveGenerated(w);
    for (const m of logs) log('Automations', m);
    return record;
  }

  // Re-sorts records saved by the old type/folder version. Offline only; safe to run on every start.
  function migrate() {
    let count = 0;
    for (const rec of store.allWithText()) {
      if (rec.kind) continue;
      const text = rec.text ?? '';
      const oldTopic = TOPICS.includes(rec.folder) ? rec.folder : null;
      let result;
      if (rec.generated) {
        const kind = rec.ext === '.csv' ? 'data' : /action items/i.test(rec.name) ? 'meeting' : 'report';
        const topic = kind === 'data' ? 'Finance' : oldTopic;
        result = { kind, topic, confidence: 'high', tags: generatedTags(kind, text), summary: offlineSummary(kind, rec.ext, text) };
      } else {
        const org = organizeOffline({ name: rec.name, ext: rec.ext, text });
        result = { kind: org.kind, topic: org.topic, confidence: org.confidence, tags: org.tags, summary: org.summary };
      }
      store.update(rec.id, { ...result, pinned: false, type: undefined, folder: undefined });
      count++;
    }
    if (count > 0) log('Organizer', `Re-sorted ${count} file${count === 1 ? '' : 's'} with the new categories.`);
    return count;
  }

  // The user's "Move to…": validates, applies, pins. Never re-runs automations.
  function moveFile(id, { kind, topic } = {}) {
    if (kind === undefined && topic === undefined) throw badRequest('Give a kind or a topic to move the file to.');
    if (kind !== undefined && !KIND_IDS.includes(kind)) throw badRequest(`Kind must be one of: ${KIND_IDS.join(', ')}.`);
    if (topic !== undefined && topic !== null && !TOPICS.includes(topic)) throw badRequest(`Topic must be one of: ${TOPICS.join(', ')}, or null.`);
    const rec = store.get(id);
    if (!rec) return null;
    const patch = { pinned: true, confidence: 'high' };
    if (kind !== undefined) patch.kind = kind;
    if (topic !== undefined) patch.topic = topic;
    const updated = store.update(id, patch);
    log('Drive', `Moved "${rec.name}" to ${kindLabel(updated.kind)} (pinned by you).`);
    return updated;
  }

  return { ingest, saveGenerated, migrate, moveFile };
}

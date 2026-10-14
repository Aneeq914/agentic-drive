/**
 * Upload pipeline: extract text -> store -> Organizer -> Automations.
 *
 * ── IN SIMPLE WORDS ──
 * Every file that enters the drive walks the same conveyor belt: we read its
 * text, save it, let the Organizer file it into a folder, then let the
 * Automations react to it (log an invoice, pull out action items).
 *
 * ── BUSINESS RULES ──
 * - Spec §3 "Upload pipeline": organise first, then run enabled automations.
 * - Spec §4.4: automation output (expenses.csv, action-item files) is saved as
 *   agent-generated files; expenses.csv is one file updated in place.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - Automations return planned writes and this module applies them, so the
 *   agents stay pure/testable. Without that, an automation could write files
 *   that re-enter ingest() and trigger itself in a loop.
 * - saveGenerated() updates an existing file by name; otherwise every invoice
 *   would create a new expenses.csv and the ledger would be split.
 *
 * ── DO NOT ──
 * - Do not route generated files through ingest() (no Organizer/Automations
 *   on agent output) — that is what prevents automation loops.
 * - Do not create a second expenses.csv; always look it up by name.
 */
import path from 'node:path';
import { extractText } from './extract.js';
import { organize, offlineSummary } from './agents/organizer.js';
import { runAutomations } from './agents/automations.js';
import { topTerms } from './text.js';

export function createPipeline({ store, llm }) {
  const log = (agent, message) => store.addActivity(agent, message);

  function saveGenerated({ name, folder, content, type }) {
    const buffer = Buffer.from(content, 'utf8');
    const existing = store.findByName(name);
    if (existing) {
      store.replaceContent(existing.id, buffer, content);
      return store.update(existing.id, { summary: offlineSummary(type ?? 'report', path.extname(name).toLowerCase(), content) });
    }
    const rec = store.add({ name, buffer, text: content, source: 'agent', generated: true });
    return store.update(rec.id, {
      type: type ?? (name.endsWith('.csv') ? 'data' : 'report'),
      folder,
      tags: [...new Set(['generated', folder.toLowerCase(), ...topTerms(content, 4)])],
      summary: offlineSummary(type ?? 'report', path.extname(name).toLowerCase(), content),
    });
  }

  async function ingest({ name, buffer, source = 'upload' }) {
    const text = await extractText(buffer, name);
    const added = store.add({ name, buffer, text, source });
    const org = await organize({ name, ext: added.ext, text }, { llm, log });
    const record = store.update(added.id, { type: org.type, folder: org.folder, tags: org.tags, summary: org.summary });
    log('Organizer', `Filed "${name}" into ${org.folder} as ${org.type}${org.by === 'ai' ? ' (AI)' : ''}. Tags: ${org.tags.join(', ')}.`);
    const { writes, logs } = runAutomations({
      record, text, rules: store.getRules(), getFileText: (n) => store.findByName(n)?.text ?? null,
    });
    for (const w of writes) saveGenerated(w);
    for (const m of logs) log('Automations', m);
    return record;
  }

  return { ingest, saveGenerated };
}

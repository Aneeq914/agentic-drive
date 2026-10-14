/**
 * Agentic Drive HTTP server: JSON API + static UI.
 *
 * ── IN SIMPLE WORDS ──
 * This is the front desk. The browser asks it to upload files, list them,
 * answer questions, combine documents or toggle automations, and it hands
 * each job to the right agent and replies with JSON.
 *
 * ── BUSINESS RULES ──
 * - Spec §5 API table: every route and status code here comes from it.
 * - Spec §2: only .txt/.md/.csv/.pdf, 10 MB per file; unsupported or
 *   unreadable files are a 400 with a readable message, never a crash.
 * - Spec §2: AI keys live in the server's environment and never reach the
 *   browser (/api/status exposes only provider + model names).
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - createApp() takes dataDir/llm/samplesDir as arguments so tests run on a
 *   temp folder with offline agents; hard-coding them would make the tests
 *   wipe or depend on real data and real API keys.
 * - A mixed upload batch returns 200 with per-file `errors`; only a batch
 *   where every file failed is a 400, so one bad file can't hide good ones.
 * - multer reports file names as latin1; we re-decode as UTF-8, otherwise
 *   non-English file names show up garbled.
 *
 * ── DO NOT ──
 * - Do not return API keys or raw provider errors with secrets to the client.
 * - Do not listen() on import — tests import createApp() directly.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import multer from 'multer';
import { createStore } from './src/store.js';
import { createLlm } from './src/llm.js';
import { createPipeline } from './src/pipeline.js';
import { UnsupportedFileError, ExtractError } from './src/extract.js';
import { DEFAULT_RULES } from './src/agents/automations.js';
import { ask } from './src/agents/search.js';
import { synthesize, FORMATS } from './src/agents/synthesizer.js';

const here = path.dirname(fileURLToPath(import.meta.url));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createApp({ dataDir, llm, samplesDir = path.join(here, 'src', 'samples') }) {
  const store = createStore(dataDir, { defaultRules: DEFAULT_RULES });
  const pipeline = createPipeline({ store, llm });
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 20 } });
  const mustGet = (id) => { const f = store.get(id); if (!f) throw new HttpError(404, 'File not found.'); return f; };

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(here, 'public')));

  app.get('/api/status', (req, res) => res.json(llm.status()));
  app.get('/api/files', (req, res) => res.json({ files: store.list() }));
  app.get('/api/files/:id', (req, res) => res.json(mustGet(req.params.id)));
  app.get('/api/files/:id/download', (req, res) => {
    const f = mustGet(req.params.id);
    res.download(store.filePath(f.id), f.name);
  });
  app.delete('/api/files/:id', (req, res) => {
    const f = mustGet(req.params.id);
    store.remove(f.id);
    store.addActivity('Drive', `Deleted "${f.name}".`);
    res.json({ ok: true });
  });

  app.post('/api/upload', upload.array('files', 20), async (req, res) => {
    const files = [];
    const errors = [];
    for (const f of req.files || []) {
      // multer gives latin1 names; browsers send UTF-8.
      const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
      try {
        files.push(await pipeline.ingest({ name, buffer: f.buffer, source: 'upload' }));
      } catch (err) {
        if (!(err instanceof UnsupportedFileError || err instanceof ExtractError)) throw err;
        errors.push({ name, error: err.message });
      }
    }
    if (files.length === 0) {
      return res.status(400).json({ error: errors[0]?.error ?? 'No files were uploaded.', errors });
    }
    res.json({ files, errors });
  });

  app.post('/api/samples', async (req, res) => {
    const loaded = [];
    const skipped = [];
    for (const name of fs.readdirSync(samplesDir).sort()) {
      if (store.findByName(name)) { skipped.push(name); continue; }
      await pipeline.ingest({ name, buffer: fs.readFileSync(path.join(samplesDir, name)), source: 'sample' });
      loaded.push(name);
    }
    res.json({ loaded, skipped });
  });

  app.post('/api/ask', async (req, res) => {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question || question.length > 500) throw new HttpError(400, 'Ask a question between 1 and 500 characters.');
    const docs = store.allWithText().filter((f) => f.text);
    const result = await ask(question, docs, { llm, log: (a, m) => store.addActivity(a, m) });
    store.addActivity('Search', `Answered "${question}" using ${result.citations.length} source(s)${result.by === 'ai' ? ' (AI)' : ''}.`);
    res.json(result);
  });

  app.post('/api/synthesize', async (req, res) => {
    const { fileIds, format } = req.body ?? {};
    if (!Array.isArray(fileIds) || new Set(fileIds).size < 2) throw new HttpError(400, 'Select at least 2 files.');
    if (!Object.hasOwn(FORMATS, format)) throw new HttpError(400, `Format must be one of: ${Object.keys(FORMATS).join(', ')}.`);
    const docs = [...new Set(fileIds)].map(mustGet);
    const result = await synthesize(docs, format, { llm, log: (a, m) => store.addActivity(a, m) });
    // Local time, so the name matches the time the UI shows; ':' is avoided because it is awkward in file names.
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const record = pipeline.saveGenerated({ name: `${result.title} - ${stamp}.md`, folder: 'Generated', content: result.content, type: 'report' });
    store.addActivity('Synthesizer', `Created "${record.name}" from ${docs.length} files${result.by === 'ai' ? ' (AI)' : ''}.`);
    res.json(record);
  });

  app.get('/api/automations', (req, res) => res.json({ rules: store.getRules() }));
  app.put('/api/automations/:id', (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, '"enabled" must be true or false.');
    const rule = store.setRuleEnabled(req.params.id, req.body.enabled);
    if (!rule) throw new HttpError(404, 'Automation not found.');
    store.addActivity('Automations', `${rule.enabled ? 'Enabled' : 'Disabled'} "${rule.name}".`);
    res.json(rule);
  });
  app.get('/api/activity', (req, res) => res.json({ activity: store.getActivity(100) }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 10 MB or smaller.' : err.code === 'LIMIT_FILE_COUNT' ? 'Upload at most 20 files at a time.' : err.message;
      return res.status(400).json({ error: msg });
    }
    if (err instanceof UnsupportedFileError || err instanceof ExtractError) return res.status(400).json({ error: err.message });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const llm = createLlm();
  const port = Number(process.env.PORT) || 3000;
  const app = createApp({ dataDir: process.env.DATA_DIR || path.join(here, 'data'), llm });
  app.listen(port, () => {
    const { aiProvider, model } = llm.status();
    console.log(`Agentic Drive running at http://localhost:${port}`);
    console.log(aiProvider ? `AI: ${aiProvider} (${model})` : 'AI: off (no API key) - using offline agents');
  });
}

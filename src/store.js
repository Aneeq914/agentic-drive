/**
 * Store: the drive's single source of truth, with files on disk and metadata in db.json.
 *
 * ── IN SIMPLE WORDS ──
 * This is the drive's filing cabinet. The actual file bytes go into
 * `data/files/`, and a single index card file (`data/db.json`) remembers
 * everything about each file: its name, folder, tags, summary and extracted
 * text. It also remembers which automation rules are switched on and keeps a
 * short diary of what the agents did (the activity feed). Everything survives
 * a server restart.
 *
 * ── BUSINESS RULES ──
 * - Storage is files on disk plus db.json, no database install (spec §2
 *   "Storage"; spec §3 "single source of truth").
 * - New files start as type "report" in folder "General" with no tags and an
 *   empty summary; the Organizer fills these in afterwards (spec §3 upload
 *   pipeline).
 * - Default automation rules are seeded only if missing, so a rule the user
 *   switched off stays off after a restart.
 * - The activity feed is newest first and keeps at most 200 entries.
 * - `id`, `ext` and `text` cannot be changed through `update()`; content only
 *   changes through `replaceContent()`, which rewrites the bytes, text and
 *   size together.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - Files on disk are named `<id><ext>`, never by the user's file name. A
 *   user name like "../../server.js" would otherwise escape `data/files/`
 *   (path traversal), and two uploads called "notes.md" would overwrite each
 *   other.
 * - Every write is synchronous and goes to `db.json.tmp` first, then is
 *   renamed over `db.json`. A crash mid-write therefore leaves the old file
 *   intact instead of a half-written, unparseable db.json; and because writes
 *   are synchronous, two requests cannot interleave async writes and lose
 *   each other's updates.
 * - `list()` leaves out `text` so the file list sent to the browser stays
 *   small even when the drive holds large PDFs.
 * - Returned records are copies (including the `tags` array), so a caller
 *   mutating a result cannot silently change the stored data without save().
 *
 * ── DO NOT ──
 * - Do not use the user's file name as a disk path.
 * - Do not return `text` from `list()` (the payload would get huge).
 * - Do not write db.json directly or asynchronously; always go through save().
 * - Do not remove `text` from LOCKED_FIELDS; patching text via update() would
 *   leave it out of sync with the bytes on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_ACTIVITY = 200;
const LOCKED_FIELDS = ['id', 'ext', 'text'];

export function createStore(dataDir, { defaultRules = [] } = {}) {
  const filesDir = path.join(dataDir, 'files');
  const dbPath = path.join(dataDir, 'db.json');
  fs.mkdirSync(filesDir, { recursive: true });

  const db = fs.existsSync(dbPath)
    ? JSON.parse(fs.readFileSync(dbPath, 'utf8'))
    : { files: [], rules: [], activity: [] };
  for (const rule of defaultRules) {
    if (!db.rules.some((r) => r.id === rule.id)) db.rules.push({ ...rule });
  }
  save();

  function save() {
    const tmp = `${dbPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, dbPath);
  }
  const strip = ({ text, ...rest }) => ({ ...rest, tags: [...rest.tags] });
  const find = (id) => db.files.find((f) => f.id === id);
  const diskPath = (rec) => path.join(filesDir, rec.id + rec.ext);

  return {
    list: () => db.files.map(strip),
    get: (id) => { const f = find(id); return f ? { ...f, tags: [...f.tags] } : null; },
    findByName: (name) => { const f = db.files.find((x) => x.name === name); return f ? { ...f, tags: [...f.tags] } : null; },
    allWithText: () => db.files.map((f) => ({ ...f, tags: [...f.tags] })),
    add({ name, buffer, text, source = 'upload', generated = false }) {
      const rec = {
        id: crypto.randomUUID(), name, ext: path.extname(name).toLowerCase(), size: buffer.length,
        type: 'report', folder: 'General', tags: [], summary: '',
        createdAt: new Date().toISOString(), generated, source, text,
      };
      fs.writeFileSync(diskPath(rec), buffer);
      db.files.push(rec);
      save();
      return strip(rec);
    },
    update(id, patch) {
      const rec = find(id);
      if (!rec) return null;
      for (const [k, v] of Object.entries(patch)) if (!LOCKED_FIELDS.includes(k)) rec[k] = v;
      save();
      return strip(rec);
    },
    replaceContent(id, buffer, text) {
      const rec = find(id);
      if (!rec) return null;
      fs.writeFileSync(diskPath(rec), buffer);
      rec.size = buffer.length;
      rec.text = text;
      save();
      return strip(rec);
    },
    remove(id) {
      const i = db.files.findIndex((f) => f.id === id);
      if (i < 0) return false;
      fs.rmSync(diskPath(db.files[i]), { force: true });
      db.files.splice(i, 1);
      save();
      return true;
    },
    filePath: (id) => { const f = find(id); return f ? diskPath(f) : null; },
    getRules: () => db.rules.map((r) => ({ ...r })),
    setRuleEnabled(id, enabled) {
      const rule = db.rules.find((r) => r.id === id);
      if (!rule) return null;
      rule.enabled = Boolean(enabled);
      save();
      return { ...rule };
    },
    addActivity(agent, message) {
      const entry = { id: crypto.randomUUID(), at: new Date().toISOString(), agent, message };
      db.activity.unshift(entry);
      db.activity.length = Math.min(db.activity.length, MAX_ACTIVITY);
      save();
      return entry;
    },
    getActivity: (limit = 100) => db.activity.slice(0, limit),
  };
}

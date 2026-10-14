import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'drive-'));
const RULES = [{ id: 'r1', name: 'Rule', description: 'd', enabled: true }];

test('add, get, list (no text), update, persist across instances', () => {
  const dir = tmp();
  const s = createStore(dir, { defaultRules: RULES });
  const rec = s.add({ name: 'a.md', buffer: Buffer.from('hello'), text: 'hello' });
  assert.equal(rec.ext, '.md');
  assert.equal(rec.size, 5);
  assert.deepEqual([rec.kind, rec.topic, rec.confidence, rec.pinned], ['other', null, 'low', false]);
  assert.equal('type' in rec || 'folder' in rec, false);
  assert.equal('text' in s.list()[0], false);
  assert.equal(s.get(rec.id).text, 'hello');
  s.update(rec.id, { topic: 'Finance', text: 'HACK', id: 'x' });
  const again = createStore(dir, { defaultRules: RULES });
  assert.equal(again.get(rec.id).topic, 'Finance');
  assert.equal(again.get(rec.id).text, 'hello');
  assert.equal(fs.readFileSync(again.filePath(rec.id), 'utf8'), 'hello');
});

test('update with an undefined value removes that field (used by the type/folder migration)', () => {
  const dir = tmp();
  const s = createStore(dir);
  const rec = s.add({ name: 'a.md', buffer: Buffer.from('x'), text: 'x' });
  s.update(rec.id, { type: 'invoice', folder: 'Finance' });
  const r = s.update(rec.id, { kind: 'invoice', type: undefined, folder: undefined });
  assert.equal('type' in r || 'folder' in r, false);
  assert.equal('type' in createStore(dir).get(rec.id), false);
});

test('replaceContent, findByName, remove', () => {
  const s = createStore(tmp());
  const rec = s.add({ name: 'expenses.csv', buffer: Buffer.from('a'), text: 'a' });
  s.replaceContent(rec.id, Buffer.from('a\nb'), 'a\nb');
  assert.equal(s.findByName('expenses.csv').text, 'a\nb');
  assert.equal(s.get(rec.id).size, 3);
  const p = s.filePath(rec.id);
  assert.equal(s.remove(rec.id), true);
  assert.equal(fs.existsSync(p), false);
  assert.equal(s.get(rec.id), null);
  assert.equal(s.remove('nope'), false);
});

test('rules seeded once, toggle persists, unknown rule returns null', () => {
  const dir = tmp();
  const s = createStore(dir, { defaultRules: RULES });
  assert.equal(s.setRuleEnabled('r1', false).enabled, false);
  const again = createStore(dir, { defaultRules: RULES });
  assert.equal(again.getRules().length, 1);
  assert.equal(again.getRules()[0].enabled, false);
  assert.equal(again.setRuleEnabled('missing', true), null);
});

test('activity newest first and capped at 200', () => {
  const s = createStore(tmp());
  for (let i = 0; i < 205; i++) s.addActivity('Organizer', `m${i}`);
  assert.equal(s.getActivity(1000).length, 200);
  assert.equal(s.getActivity(1)[0].message, 'm204');
});

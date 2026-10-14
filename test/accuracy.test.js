import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractText } from '../src/extract.js';
import { organizeOffline } from '../src/agents/organizer.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
async function run(dir, labelsPath) {
  const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  const rows = [];
  for (const [name, want] of Object.entries(labels)) {
    const text = await extractText(fs.readFileSync(path.join(dir, name)), name);
    const got = organizeOffline({ name, ext: path.extname(name).toLowerCase(), text });
    rows.push({ name, want, got: { kind: got.kind, topic: got.topic } });
  }
  return rows;
}

test('every bundled sample gets its labelled kind and topic', async () => {
  const rows = await run(path.join(root, 'src/samples'), path.join(root, 'test/fixtures/sample-labels.json'));
  const files = fs.readdirSync(path.join(root, 'src/samples'));
  assert.deepEqual(rows.map((r) => r.name).sort(), files.sort(), 'every sample must be labelled');
  const wrong = rows.filter((r) => r.want.kind !== r.got.kind || r.want.topic !== r.got.topic);
  assert.deepEqual(wrong, []);
});

test('holdout: at least 85% of kinds correct, and no brief is an invoice', async () => {
  const dir = path.join(root, 'test/fixtures/holdout');
  const rows = await run(dir, path.join(dir, 'labels.json'));
  const correct = rows.filter((r) => r.want.kind === r.got.kind).length;
  const accuracy = correct / rows.length;
  const misses = rows.filter((r) => r.want.kind !== r.got.kind).map((r) => `${r.name}: want ${r.want.kind}, got ${r.got.kind}`);
  assert.ok(accuracy >= 0.85, `holdout kind accuracy ${(accuracy * 100).toFixed(0)}%\n${misses.join('\n')}`);
  assert.ok(rows.filter((r) => r.want.kind === 'proposal').every((r) => r.got.kind !== 'invoice'));
});

// holdout-2 was written blind AFTER tuning and is never tuned against: it is the honest measure.
// The bar is lower than for the tuned sets, but every miss must fail safe (land in "Other"), never in a wrong category.
test('fresh blind holdout-2: >= 75% kinds correct, and every miss lands in Other', async () => {
  const dir = path.join(root, 'test/fixtures/holdout-2');
  const rows = await run(dir, path.join(dir, 'labels.json'));
  const correct = rows.filter((r) => r.want.kind === r.got.kind).length;
  const confidentWrong = rows.filter((r) => r.want.kind !== r.got.kind && r.got.kind !== 'other');
  assert.ok(correct / rows.length >= 0.75, `holdout-2 kind accuracy ${correct}/${rows.length}`);
  assert.deepEqual(confidentWrong, [], 'a wrong guess must go to Other, not to another category');
});

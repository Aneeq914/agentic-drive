import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickProvider, createLlm, parseJsonReply, DEFAULT_MODELS } from '../src/llm.js';

test('pickProvider', () => {
  assert.equal(pickProvider({}), null);
  assert.equal(pickProvider({ GEMINI_API_KEY: 'g' }), 'gemini');
  assert.equal(pickProvider({ ANTHROPIC_API_KEY: 'a' }), 'claude');
  assert.equal(pickProvider({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }), 'gemini');
  assert.equal(pickProvider({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', AI_PROVIDER: 'claude' }), 'claude');
  assert.equal(pickProvider({ AI_PROVIDER: 'claude' }), null);
});

test('createLlm without keys is disabled and returns null', async () => {
  const llm = createLlm({});
  assert.equal(llm.enabled(), false);
  assert.deepEqual(llm.status(), { aiProvider: null, model: null });
  assert.equal(await llm.complete('hi'), null);
});

test('status reports model defaults and overrides', () => {
  assert.deepEqual(createLlm({ GEMINI_API_KEY: 'g' }).status(), { aiProvider: 'gemini', model: DEFAULT_MODELS.gemini });
  assert.deepEqual(createLlm({ ANTHROPIC_API_KEY: 'a', ANTHROPIC_MODEL: 'claude-sonnet-5' }).status(), { aiProvider: 'claude', model: 'claude-sonnet-5' });
});

test('parseJsonReply handles fences, chatter, junk', () => {
  assert.deepEqual(parseJsonReply('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('Sure! {"a":2} hope that helps'), { a: 2 });
  assert.equal(parseJsonReply('no json'), null);
  assert.equal(parseJsonReply('{bad'), null);
  assert.equal(parseJsonReply(null), null);
});

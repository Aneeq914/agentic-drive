/**
 * LLM client: one `complete(prompt)` call that talks to Gemini or Claude, or to nobody.
 *
 * ── IN SIMPLE WORDS ──
 * The agents sometimes want to ask an AI model for help. This module is the
 * single phone line to that AI. If an API key is configured on the server it
 * dials Gemini or Claude; if not, it simply says "no AI here" (returns null)
 * and the agents do the work with their built-in offline logic instead.
 *
 * ── BUSINESS RULES ──
 * - The AI is optional: with no key the whole drive still works offline
 *   (spec §2 "AI": "works free, AI optional").
 * - The key stays on the server; only `{aiProvider, model}` is exposed via
 *   status() (spec §2; plan Global Constraints "API keys never reach the
 *   browser").
 * - Provider choice: AI_PROVIDER wins when its key is present; otherwise
 *   Gemini if GEMINI_API_KEY is set, else Claude if ANTHROPIC_API_KEY is set,
 *   else none. AI_PROVIDER without a matching key means no provider.
 * - Default models are gemini-3.8-flash and claude-opus-5, overridable with
 *   GEMINI_MODEL / ANTHROPIC_MODEL (plan Global Constraints).
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - `complete` returns null only when no provider is configured. On an API
 *   failure, a refusal or an empty reply it THROWS. That way each agent can
 *   tell "AI not configured" from "AI failed", log the failure in the activity
 *   feed and fall back to offline logic (plan Review Focus #4). Returning null
 *   on failure would hide errors as if the AI were simply switched off.
 * - On claude-opus-5 / claude-fable-5-1 the request goes through the beta
 *   endpoint with server-side fallbacks enabled, so a safety refusal from the
 *   primary model is retried server-side before we see a refusal.
 * - SDK clients are created lazily on the first call, so tests and offline
 *   runs never construct a client or touch the network.
 * - parseJsonReply is re-exported from ./json-reply.js so agents can import
 *   both the client and the reply parser from one place.
 *
 * ── DO NOT ──
 * - Do not log the API key, put it in an error message, or return it from
 *   status() or any API response.
 * - Do not send keys (or this module) to the browser.
 * - Do not change complete() to return null on failure; agents rely on the
 *   throw to record that the AI failed.
 */
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';

export { parseJsonReply } from './json-reply.js';

export const DEFAULT_MODELS = { gemini: 'gemini-3.8-flash', claude: 'claude-opus-5' };
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

export function pickProvider(env) {
  const wanted = (env.AI_PROVIDER || '').toLowerCase();
  if (wanted === 'gemini' && env.GEMINI_API_KEY) return 'gemini';
  if (wanted === 'claude' && env.ANTHROPIC_API_KEY) return 'claude';
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.ANTHROPIC_API_KEY) return 'claude';
  return null;
}

export function createLlm(env = process.env) {
  const provider = pickProvider(env);
  const model = provider === 'gemini' ? env.GEMINI_MODEL || DEFAULT_MODELS.gemini
    : provider === 'claude' ? env.ANTHROPIC_MODEL || DEFAULT_MODELS.claude : null;
  let gemini;
  let claude;

  async function completeGemini(prompt, { system }) {
    gemini ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const res = await gemini.models.generateContent({ model, contents: prompt, config: system ? { systemInstruction: system } : {} });
    if (!res.text) throw new Error('Gemini returned no text');
    return res.text;
  }

  async function completeClaude(prompt, { system, effort }) {
    claude ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const params = { model, max_tokens: 16000, messages: [{ role: 'user', content: prompt }] };
    if (system) params.system = system;
    if (effort) params.output_config = { effort };
    const res = FALLBACK_MODELS.has(model)
      ? await claude.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await claude.messages.create(params);
    if (res.stop_reason === 'refusal') throw new Error('Claude declined this request');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!text) throw new Error('Claude returned no text');
    return text;
  }

  return {
    enabled: () => provider !== null,
    status: () => ({ aiProvider: provider, model }),
    async complete(prompt, opts = {}) {
      if (!provider) return null;
      return provider === 'gemini' ? completeGemini(prompt, opts) : completeClaude(prompt, opts);
    },
  };
}

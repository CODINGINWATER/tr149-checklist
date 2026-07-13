// ACE onboarding backend — no dependencies, just Node's built-in http + fetch (Node 18+).
// Supports Anthropic direct, OpenRouter, or a local Ollama model as the provider.
//
// Run with Anthropic:   ANTHROPIC_API_KEY=sk-ant-...   node server.js
// Run with OpenRouter:  OPENROUTER_API_KEY=sk-or-...   node server.js
// Run with Ollama:      PROVIDER=ollama OLLAMA_MODEL=qwen3.5:4b   node server.js
//
// Note on Ollama models: not every model on Ollama supports tool calling — using
// one that doesn't (e.g. base gemma3) gets an immediate "does not support tools"
// error before any request is even sent. Stick to models tagged "tools" at
// https://ollama.com/search?c=tools (qwen3.5, llama3.1, mistral-nemo, granite4.1,
// gemma4, etc). As a safety net, this server also asks for native tool calls
// first and falls back to parsing a fenced ```json checklist block out of the
// plain-text reply if no tool call came back (see extractFallbackChecklist below)
// — helpful for smaller/looser models that sometimes ignore the tool schema.
//
// Then open http://localhost:8787 in your browser.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const HTML_FILE = path.join(__dirname, 'TR149_Platform_Mockup.html');

// Provider selection: explicit PROVIDER env var wins; otherwise auto-detect from
// whichever API key is set. No key at all falls back to local Ollama, since that
// needs no key — just make sure `ollama serve` is running.
const PROVIDER = (process.env.PROVIDER
  || (process.env.OPENROUTER_API_KEY ? 'openrouter'
    : process.env.ANTHROPIC_API_KEY ? 'anthropic'
      : 'ollama')).toLowerCase();

const API_KEY = PROVIDER === 'openrouter' ? process.env.OPENROUTER_API_KEY
  : PROVIDER === 'anthropic' ? process.env.ANTHROPIC_API_KEY
    : null; // ollama needs no key

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

const MODEL = process.env.MODEL
  || (PROVIDER === 'openrouter' ? (process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet')
    : PROVIDER === 'ollama' ? (process.env.OLLAMA_MODEL || 'qwen3.5:4b')
      : (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'));

const SITE_URL = process.env.OPENROUTER_SITE_URL || 'http://localhost:8787';
const SITE_NAME = process.env.OPENROUTER_SITE_NAME || 'ACE Onboarding Demo';

// The onboarding conversation is capped at exactly three of the user's replies:
// turns 1 and 2 are for asking focused questions, and on turn 3 the checklist is
// generated. This is enforced server-side (see handleChat) rather than trusted to
// the model — small local models ignore "only ask a few questions" instructions.
// The system prompt is built per-turn so the wording matches what the server allows.
const MAX_QUESTION_ROUNDS = 3;

const SYSTEM_BASE = `You are the ACE Onboarding Agent, part of ACE (Agentic Compliance Engine) — a platform that helps organisations assess their maturity against the TR149 sustainability excellence standard.

You have a short onboarding conversation with the user to learn about their company: industry, rough size or number of sites, what they make or do, supplier relationships, and any target assessment deadline. Keep every reply brief (2 to 4 sentences), plain-language, and business-friendly.

If the user pastes their company website, its extracted page content is provided to you inside square brackets. Use it to understand the company, but respond naturally and do not quote or mention the raw bracketed text.

TR149 covers five domains: Energy & Emissions, Supplier Sustainability, Waste & Materials, Product Life Cycle, and People & Workplace.`;

const ASK_SUFFIX = `

This is an information-gathering turn. Ask exactly one or two focused questions to learn more about the company — do not interrogate the user with a long list. Do NOT produce a checklist, a summary of items, or any JSON on this turn; just have the conversation.`;

const GENERATE_SUFFIX = `

This is the final turn — you now have enough context, so generate the checklist instead of asking anything further. Call the generate_checklist tool. Tailor which domains you emphasize and the specific items to what this company actually does — do not just list generic items evenly across all five. Aim for 8 to 14 checklist items total, each a concrete, specific action or piece of evidence to gather (for example "Provide 12 months of electricity bills for the Tuas site" rather than "provide energy data").

If you are not able to call tools directly, instead reply with exactly one fenced code block and nothing else, formatted as:
\`\`\`json
{"company_name": "...", "summary": "...", "items": [{"domain": "Energy & Emissions", "text": "..."}]}
\`\`\`
using the same fields described above.`;

function systemPrompt(force) {
  return SYSTEM_BASE + (force ? GENERATE_SUFFIX : ASK_SUFFIX);
}

const TOOL_NAME = 'generate_checklist';
const TOOL_DESCRIPTION = 'Generate a tailored TR149 compliance checklist once enough company background has been gathered from the conversation.';
const CHECKLIST_SCHEMA = {
  type: 'object',
  properties: {
    company_name: { type: 'string', description: "The company's name, or a short descriptor if no name was given." },
    summary: { type: 'string', description: 'One or two sentence summary of why these domains and items matter for this company.' },
    items: {
      type: 'array',
      description: '8 to 14 tailored checklist items.',
      items: {
        type: 'object',
        properties: {
          domain: {
            type: 'string',
            enum: ['Energy & Emissions', 'Supplier Sustainability', 'Waste & Materials', 'Product Life Cycle', 'People & Workplace']
          },
          text: { type: 'string', description: 'A concrete, specific checklist item.' }
        },
        required: ['domain', 'text']
      }
    }
  },
  required: ['company_name', 'items']
};

function anthropicTool() {
  return { name: TOOL_NAME, description: TOOL_DESCRIPTION, input_schema: CHECKLIST_SCHEMA };
}
function openaiTool() {
  return { type: 'function', function: { name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: CHECKLIST_SCHEMA } };
}

// The frontend always sends/receives Anthropic-shaped messages:
//   { role: 'user', content: 'text' }
//   { role: 'assistant', content: [{ type: 'text', text: '...' }] }
// (assistant turns that used the tool aren't replayed — the chat locks after that.)
// For OpenRouter we flatten those into plain OpenAI-style { role, content: string } messages.
function toOpenAIMessage(m) {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  const text = (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  return { role: m.role, content: text };
}

// Fallback for models (notably Gemma3 on Ollama) that don't reliably emit native
// tool_calls and instead reply with the checklist as JSON text, per Google's own
// prompt-based function-calling guidance for Gemma. Looks for a fenced ```json
// block first, falls back to trying to parse the whole message as JSON.
function extractFallbackChecklist(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fenced ? [fenced[1]] : [text];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && Array.isArray(parsed.items)) return parsed;
    } catch { /* not JSON, try next candidate or give up */ }
  }
  return null;
}

// Small local models sometimes return the tool's `items` as a JSON-encoded string
// (or with junk entries) instead of a real array. Coerce it back into a clean array
// of {domain, text} so the frontend's items.forEach never throws on a bad response.
function normalizeChecklistInput(input) {
  if (!input || typeof input !== 'object') return input;
  let items = input.items;
  if (typeof items === 'string') {
    try { const parsed = JSON.parse(items); if (Array.isArray(parsed)) items = parsed; } catch { /* leave as-is */ }
  }
  if (Array.isArray(items)) {
    items = items.filter((it) => it && typeof it === 'object' && typeof it.domain === 'string' && typeof it.text === 'string');
  } else {
    items = [];
  }
  return { ...input, items };
}

async function readJsonOrError(res, label) {
  const rawBody = await res.text();
  try {
    return { ok: true, data: JSON.parse(rawBody) };
  } catch {
    return { ok: false, status: res.status >= 400 ? res.status : 502, error: `${label} returned a non-JSON response (${res.status}): ${rawBody.slice(0, 200)}` };
  }
}

async function callAnthropic(messages, force) {
  const payload = {
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt(force),
    messages
  };
  // Only offer the tool on the final turn, and force it — so the model asks
  // questions on turns 1-2 and can't skip straight to (or dodge) the checklist.
  if (force) {
    payload.tools = [anthropicTool()];
    payload.tool_choice = { type: 'tool', name: TOOL_NAME };
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload)
  });
  const parsed = await readJsonOrError(res, 'Anthropic API');
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  if (!res.ok) return { ok: false, status: res.status, error: data?.error?.message || `Anthropic API error (${res.status})` };
  const content = (data.content || []).map((b) =>
    b.type === 'tool_use' && b.name === TOOL_NAME ? { ...b, input: normalizeChecklistInput(b.input) } : b);
  return { ok: true, content };
}

// Shared caller for any OpenAI-compatible chat/completions endpoint (OpenRouter, Ollama, etc).
async function callOpenAICompatible(url, messages, extraHeaders, label, force) {
  const oaMessages = [{ role: 'system', content: systemPrompt(force) }, ...messages.map(toOpenAIMessage)];
  const payload = { model: MODEL, max_tokens: 1024, messages: oaMessages };
  // Only offer/force the tool on the final turn (see callAnthropic).
  if (force) {
    payload.tools = [openaiTool()];
    payload.tool_choice = { type: 'function', function: { name: TOOL_NAME } };
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    return { ok: false, status: 502, error: `Couldn't reach ${label} at ${url} (${err.message}). If this is Ollama, make sure "ollama serve" is running and the model is pulled.` };
  }

  const parsed = await readJsonOrError(res, label);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  if (!res.ok) return { ok: false, status: res.status, error: data?.error?.message || data?.error || `${label} error (${res.status})` };

  const msg = data.choices?.[0]?.message;
  if (!msg) return { ok: false, status: 502, error: `${label} response was missing choices[0].message.` };

  const content = [];
  if (msg.content && msg.content.trim()) content.push({ type: 'text', text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls) {
      if (call.function?.name === TOOL_NAME) {
        let input = {};
        try { input = JSON.parse(call.function.arguments || '{}'); } catch { /* leave empty, frontend will just show 0 items */ }
        content.push({ type: 'tool_use', name: TOOL_NAME, input: normalizeChecklistInput(input) });
      }
    }
  }

  // Final turn but no native tool call came back — see if the model wrote the
  // checklist as JSON text instead (expected for models without real tool support).
  if (force && !content.some((b) => b.type === 'tool_use')) {
    const fallback = extractFallbackChecklist(msg.content);
    if (fallback) {
      return { ok: true, content: [{ type: 'tool_use', name: TOOL_NAME, input: normalizeChecklistInput(fallback) }] };
    }
  }

  return { ok: true, content };
}

async function callOpenRouter(messages, force) {
  return callOpenAICompatible('https://openrouter.ai/api/v1/chat/completions', messages, {
    authorization: `Bearer ${API_KEY}`,
    'HTTP-Referer': SITE_URL,
    'X-Title': SITE_NAME
  }, 'OpenRouter', force);
}

// Ollama uses its native /api/chat endpoint rather than the OpenAI-compat one.
// Thinking models (e.g. qwen3.5) on the compat endpoint frequently leave `content`
// empty — the whole answer is stranded in a separate `reasoning` field — and take
// ~40s per reply. The native endpoint accepts think:false, which both fills
// `content` reliably and is dramatically faster. Set OLLAMA_THINK=1 to re-enable it.
const OLLAMA_THINK = process.env.OLLAMA_THINK === '1';

async function callOllama(messages, force) {
  const oaMessages = [{ role: 'system', content: systemPrompt(force) }, ...messages.map(toOpenAIMessage)];
  const payload = {
    model: MODEL,
    messages: oaMessages,
    stream: false,
    think: OLLAMA_THINK,
    options: { num_predict: 1024 }
  };
  if (force) payload.tools = [openaiTool()]; // only offer the tool on the final turn

  let res;
  try {
    res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    return { ok: false, status: 502, error: `Couldn't reach Ollama at ${OLLAMA_BASE_URL} (${err.message}). Make sure "ollama serve" is running and "${MODEL}" is pulled.` };
  }

  const parsed = await readJsonOrError(res, 'Ollama');
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  if (!res.ok) return { ok: false, status: res.status, error: data?.error || `Ollama error (${res.status})` };

  const msg = data.message;
  if (!msg) return { ok: false, status: 502, error: 'Ollama response was missing a message.' };

  const content = [];
  if (Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls) {
      if (call.function?.name === TOOL_NAME) {
        // Native Ollama returns arguments as an object; be defensive about strings too.
        let input = call.function.arguments;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
        content.push({ type: 'tool_use', name: TOOL_NAME, input: normalizeChecklistInput(input) });
      }
    }
  }

  // Final turn but no tool call — recover a JSON checklist written as plain text.
  if (force && !content.some((b) => b.type === 'tool_use')) {
    const fallback = extractFallbackChecklist(msg.content);
    if (fallback) return { ok: true, content: [{ type: 'tool_use', name: TOOL_NAME, input: normalizeChecklistInput(fallback) }] };
  }

  // Otherwise surface the reply text (falling back to `thinking` if think is on
  // and content somehow came back empty), so the chat is never blank.
  if (!content.some((b) => b.type === 'tool_use')) {
    const text = (msg.content && msg.content.trim()) || (msg.thinking && msg.thinking.trim()) || '';
    if (text) content.push({ type: 'text', text });
  }
  return { ok: true, content };
}

// ---------------------------------------------------------------------------
// Company-website scraper. Given a URL, pull the readable text off the page and
// have the LLM turn it into a short, first-person company intro that pre-fills
// the onboarding chat — so the user pastes a link instead of typing a blurb.
// ---------------------------------------------------------------------------

function decodeEntities(s) {
  return (s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#39;|&rsquo;|&lsquo;|&apos;/gi, "'").replace(/&mdash;|&ndash;/gi, '-')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// Reject non-http(s) and obvious internal/loopback hosts (basic SSRF guard).
function validateScrapeUrl(raw) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { return { ok: false, error: 'That does not look like a valid URL.' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'Only http and https URLs are supported.' };
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local')
    || /^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
    || host === '0.0.0.0' || host === '::1') {
    return { ok: false, error: 'Internal or loopback addresses are not allowed.' };
  }
  return { ok: true, url: u.toString() };
}

async function fetchPageText(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; ACE-Onboarding-Scraper/1.0)' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`The site responded with ${res.status}.`);
  const html = await res.text();
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const metaDesc = decodeEntities(
    (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || [])[1]
    || (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || [])[1]
    || '').trim();
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
  return { title, metaDesc, text };
}

// In-memory cache so a website shared in the chat is only fetched once, even
// though the frontend replays the full history (with the URL) on every turn.
const scrapeCache = new Map(); // url -> { title, metaDesc, text, at }
const SCRAPE_TTL_MS = 30 * 60 * 1000;

async function getPageTextCached(url) {
  const hit = scrapeCache.get(url);
  if (hit && Date.now() - hit.at < SCRAPE_TTL_MS) return hit;
  const page = await fetchPageText(url);
  const entry = { ...page, at: Date.now() };
  scrapeCache.set(url, entry);
  return entry;
}

const URL_IN_TEXT = /(?:https?:\/\/|www\.)[^\s<>"')]+/i;

// If a user message contains a company URL, fold the page content into that
// message (in brackets) so the agent can use it. This lets the user simply
// paste a link into the chat instead of using the "Pre-fill" field.
async function augmentMessagesWithWebsites(messages) {
  return Promise.all(messages.map(async (m) => {
    if (m.role !== 'user' || typeof m.content !== 'string') return m;
    const match = m.content.match(URL_IN_TEXT);
    if (!match) return m;
    const valid = validateScrapeUrl(match[0].replace(/[.,)]+$/, ''));
    if (!valid.ok) return m;
    try {
      const page = await getPageTextCached(valid.url);
      const context = `\n\n[Company website shared by the user: ${valid.url}\nTitle: ${page.title}\n${page.metaDesc}\nExtracted page content (truncated): ${page.text.slice(0, 3500)}]`;
      return { ...m, content: m.content + context };
    } catch {
      return m; // scrape failed; use the message as-is rather than breaking the chat
    }
  }));
}

// Minimal single-shot text completion across the same providers as the chat.
async function callLLMPlain(system, user) {
  if (PROVIDER === 'ollama') {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, stream: false, think: OLLAMA_THINK, options: { num_predict: 400 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d?.error || `Ollama error (${res.status})`);
    return (d?.message?.content || '').trim();
  }
  if (PROVIDER === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, system, messages: [{ role: 'user', content: user }] })
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d?.error?.message || `Anthropic error (${res.status})`);
    return (d?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
  }
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}`, 'HTTP-Referer': SITE_URL, 'X-Title': SITE_NAME },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d?.error?.message || d?.error || `OpenRouter error (${res.status})`);
  return (d?.choices?.[0]?.message?.content || '').trim();
}

const SCRAPE_SYSTEM = `You write a short, natural, first-person introduction that a staff member of a company would type into a chat to describe their business. Write 2 to 3 sentences covering what the company does, their main products or services, their industry, and who their customers are — based only on the website content provided. Use plain, conversational language, as if a real person typed it. Do not use em dashes or bullet points. Do not invent facts that are not supported by the content. Start with a natural greeting like "Hi! We're ...".`;

async function handleScrape(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    withCors(res);
    try {
      if (PROVIDER !== 'ollama' && !API_KEY) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Server is missing an API key for provider "${PROVIDER}".` }));
        return;
      }
      const { url } = JSON.parse(body || '{}');
      const valid = validateScrapeUrl(String(url || '').trim());
      if (!valid.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: valid.error }));
        return;
      }

      let page;
      try {
        page = await fetchPageText(valid.url);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Could not read that site (${err.message}). Try a different page on the company's website.` }));
        return;
      }

      const context = `Company website: ${valid.url}\nPage title: ${page.title}\nMeta description: ${page.metaDesc}\n\nPage text (truncated):\n${page.text.slice(0, 4000)}`;
      const intro = await callLLMPlain(SCRAPE_SYSTEM, context);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ intro, title: page.title, url: valid.url }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
}

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function handleChat(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    withCors(res);
    try {
      if (PROVIDER !== 'ollama' && !API_KEY) {
        const hint = PROVIDER === 'openrouter'
          ? 'Set OPENROUTER_API_KEY and restart: OPENROUTER_API_KEY=sk-or-... node server.js'
          : 'Set ANTHROPIC_API_KEY and restart: ANTHROPIC_API_KEY=sk-ant-... node server.js (or set OPENROUTER_API_KEY to use OpenRouter, or PROVIDER=ollama to use a local model instead).';
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Server is missing an API key for provider "${PROVIDER}". ${hint}` }));
        return;
      }
      const { messages } = JSON.parse(body || '{}');
      if (!Array.isArray(messages) || messages.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing messages array.' }));
        return;
      }

      // Cap onboarding at MAX_QUESTION_ROUNDS of the user's replies: force the
      // checklist on (or after) that turn, otherwise keep asking questions.
      const userTurns = messages.filter((m) => m.role === 'user').length;
      const force = userTurns >= MAX_QUESTION_ROUNDS;

      // Let the user drop a company URL straight into the chat: scrape any URL
      // in their messages and fold the page content in before the LLM sees it.
      const llmMessages = await augmentMessagesWithWebsites(messages);

      const result = PROVIDER === 'openrouter' ? await callOpenRouter(llmMessages, force)
        : PROVIDER === 'ollama' ? await callOllama(llmMessages, force)
          : await callAnthropic(llmMessages, force);
      if (!result.ok) {
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.error }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: result.content }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
}

async function handleStatic(req, res) {
  try {
    const html = await readFile(HTML_FILE, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('TR149_Platform_Mockup.html not found next to server.js');
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    withCors(res);
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.url === '/api/chat' && req.method === 'POST') {
    handleChat(req, res);
    return;
  }
  if (req.url === '/api/scrape' && req.method === 'POST') {
    handleScrape(req, res);
    return;
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    handleStatic(req, res);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`ACE backend running at http://localhost:${PORT}`);
  console.log(`Provider: ${PROVIDER}  Model: ${MODEL}`);
  if (PROVIDER === 'ollama') {
    console.log(`Expecting Ollama at ${OLLAMA_BASE_URL} — make sure "ollama serve" is running and "${MODEL}" is pulled (and supports tool calling).`);
  } else if (!API_KEY) {
    console.log(`Warning: no API key set for provider "${PROVIDER}". The chat endpoint will return an error until you set one.`);
  }
});

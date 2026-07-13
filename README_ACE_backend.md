# ACE onboarding agent — running the live version

The Company Onboarding screen now talks to a real agent instead of showing a scripted conversation. It needs a small local backend, because the mockup is a static file and can't safely hold an API key itself. The backend supports **Anthropic directly, OpenRouter, or a local Ollama model** — pick whichever you want.

## What's included

- `TR149_Platform_Mockup.html` — the mockup, updated so the onboarding chat calls `/api/chat` and renders whatever checklist the agent returns.
- `server.js` — a dependency-free Node server. It serves the HTML file and proxies chat requests to Anthropic, OpenRouter, or Ollama (so an API key, where needed, stays server-side, never in the browser).

## Requirements

- Node.js 18 or newer (uses the built-in `fetch`).
- One of:
  - an Anthropic API key from [console.anthropic.com](https://console.anthropic.com), **or**
  - an OpenRouter API key from [openrouter.ai/keys](https://openrouter.ai/keys) — gives you access to Claude, GPT, Gemini, Llama, etc. through one key, **or**
  - [Ollama](https://ollama.com) installed and running locally — no key, no cost, nothing leaves your machine. Default model is `qwen3.5:4b`. **Important:** not every Ollama model supports tool calling — using one that doesn't (e.g. base `gemma3`) fails immediately with "does not support tools" before any request is even sent. Only use models tagged **tools** at [ollama.com/search?c=tools](https://ollama.com/search?c=tools).

## Run it

1. Put `server.js` and `TR149_Platform_Mockup.html` in the same folder (they already are).
2. In a terminal, from that folder, run one of:

   **Anthropic direct:**
   ```
   ANTHROPIC_API_KEY=sk-ant-your-key-here node server.js
   ```

   **OpenRouter:**
   ```
   OPENROUTER_API_KEY=sk-or-your-key-here node server.js
   ```

   **Ollama (local, no key):**
   ```
   ollama pull qwen3.5:4b       # once, if you haven't already
   ollama serve                 # if it isn't already running
   PROVIDER=ollama OLLAMA_MODEL=qwen3.5:4b node server.js
   ```
   Ollama is actually the **default** if you run `node server.js` with no key set at all, and `qwen3.5:4b` is the default model — it's the no-signup option.

   On Windows (PowerShell), e.g. for OpenRouter:
   ```
   $env:OPENROUTER_API_KEY="sk-or-your-key-here"; node server.js
   ```

   Provider auto-detects from whichever key is set (OpenRouter > Anthropic > Ollama if more than one is present), or force it explicitly with `PROVIDER=anthropic`, `PROVIDER=openrouter`, or `PROVIDER=ollama`.

3. Open **http://localhost:8787** in your browser — not the `.html` file directly. The page needs to be served from the same origin as the backend for the chat to work.
4. Go to the Company Onboarding screen and start chatting. After a couple of exchanges the agent calls a `generate_checklist` tool and the page renders the checklist live.

### Choosing a model

**OpenRouter** defaults to `anthropic/claude-3.5-sonnet`. Override with:
```
OPENROUTER_MODEL="openai/gpt-4o-mini" OPENROUTER_API_KEY=sk-or-... node server.js
```
Check [openrouter.ai/models](https://openrouter.ai/models) for current slugs and pricing — pick one that supports tool calling, since checklist generation depends on it.

**Ollama** defaults to `qwen3.5:4b`, chosen because it's small (comparable resource footprint to a 4B Gemma model) and is officially tagged `tools` on Ollama's model registry, so tool calling actually works. If Ollama runs on a different host/port, set `OLLAMA_BASE_URL` (default `http://localhost:11434`).

**Model recommendations, smallest to largest** (all confirmed `tools`-tagged as of writing — check [ollama.com/search?c=tools](https://ollama.com/search?c=tools) for the current list before relying on this):
- `qwen3.5:4b` (default) — good balance of size and reliability for this use case.
- `granite4.1:3b` — IBM's Granite line, built specifically with tool use and structured output in mind, slightly smaller than the default.
- `gemma4:e4b` — if you specifically wanted a Gemma model: unlike `gemma3`, Gemma 4 added native tool calling.
- `llama3.1:8b` or `qwen3.5:9b` — a step up in size if the 4B-class models are flaky or refuse to produce the checklist.

**Do not use base `gemma3`** (any size) — Ollama will reject the request outright with "does not support tools" before it even reaches the model, because that model isn't tagged for tool use. As a general safety net (not specific to any one model), `server.js` also asks for native tool calls first and, if none come back, looks for a fenced &#96;&#96;&#96;json block in the plain-text reply instead — this helps with models that are tools-tagged but occasionally loose about actually using the mechanism.

## How it works

- The agent gathers company background conversationally for 2–4 turns (industry, size, sites, suppliers, deadline).
- Once it has enough, it stops replying in plain text and instead calls a `generate_checklist` tool with structured JSON (`{ company_name, summary, items: [{ domain, text }] }`), which the page renders into the checklist card grouped by TR149 domain.
- Internally the server normalizes all three providers' responses into the same shape before sending them to the page, so the frontend code doesn't care which one is behind it. OpenRouter and Ollama both speak the same OpenAI-compatible `chat/completions` format, so they share one code path (`callOpenAICompatible`); Anthropic has its own.
- After the checklist is generated, the chat input locks — refresh the page to run onboarding again for a different company.

## Known limitations (be aware before treating this as more than a demo)

- **Checklist content isn't grounded in the real TR149 standard.** The model is only told the five domain names and asked to write plausible items — it isn't reading the actual TR149 criteria matrix. For anything beyond a demo, the checklist items need to come from real TR149 clauses (e.g. fed into the system prompt or retrieved from a document store), not the model's best guess.
- No conversation persistence — refreshing the page loses the chat.
- No auth on the `/api/chat` endpoint — fine for local use, not for deploying anywhere public as-is.
- Smaller/local models are more likely to ignore the checklist instruction, or produce malformed JSON that fails to parse, than Claude or GPT-4-class models. There's a text-based fallback for this (see the model notes above), but it's still not as reliable as a frontier model's native tool calling.
- **Testing note:** from my sandboxed environment, outbound access to `api.anthropic.com` is allowed, but `openrouter.ai` is blocked by network policy and there's no local Ollama instance available. So I verified the Anthropic path end-to-end (request reaches the API, headers/body are well-formed, errors handled without crashing), and verified the OpenRouter and Ollama code paths produce the correct request shape and fail gracefully with clear error messages when unreachable — but I have not seen a live successful response from either. Both share the same tested code path as Anthropic's error handling (`readJsonOrError`), so I'd expect them to work, but you're the first real test of the happy path.

# ACE (Agentic Compliance Engine) — Handover

> ⚠️ This is the **original** handover (10 Jul 2026 starting state). For the
> current state and setup instructions, see **[HANDOFF.md](HANDOFF.md)**. Since
> this was written, the app has gained a URL scraper, a 3-round onboarding cap,
> an About page, and full BreadTalk theming.

Status as of 10 July 2026. This document is the single entry point for anyone picking up this project next — what exists, what's real vs. mocked, how to run it, and what's left to do.

## What this project is

A clickable HTML mockup of a TR149 sustainability-assessment platform ("ACE"), built from the user stories, actors, AI agents, and flow definitions in the source spreadsheet (`TR149_Platform_AI_Copilot_User_Stories_Draft.xlsx`, in the uploads folder). One screen — Company Onboarding — is wired to a real, working LLM agent; the other thirteen are static visual mockups of the intended flow.

## File inventory

| File | What it is |
|---|---|
| `TR149_Platform_Mockup.html` | The product itself. Single-file HTML/CSS/JS, 14 screens navigable via the left sidebar. Open directly in a browser for the static screens; must be served via `server.js` for the live onboarding chat to work. |
| `server.js` | Node backend for the onboarding agent. No dependencies, serves the HTML file and proxies `/api/chat` to Anthropic, OpenRouter, or a local Ollama model. |
| `README_ACE_backend.md` | Setup/run instructions for `server.js`, including provider-specific notes and model recommendations. Read this before running anything. |
| `ACE_onboarding_screenshot.png` | Reference screenshot of the onboarding screen (static, pre-live-chat version). |
| *(uploads)* `TR149_Platform_AI_Copilot_User_Stories_Draft.xlsx` | Source material — user stories (US-01 through US-24), actors, AI agent definitions, file/register list, and the original Mock-UI screen descriptions this whole build is based on. |

## The 14 screens

Grouped in the sidebar as: **Onboarding** (Company Onboarding — live), **Setup** (Project Setup, Scope Setup, Owner Assignment), **Assessment** (Guided Assessment, Evidence Upload & AI Mapping, Environmental Data), **Review** (AI Suggested Maturity, Reviewer Approval), **Improve** (Gap Register & Roadmap, Management Summary), **Extended Scope** (Supplier Questionnaire, Product Lifecycle), **Admin** (Template Version History, Audit Trail).

Each static screen reflects specific user stories from the spreadsheet (referenced inline in the HTML, e.g. "US-09, US-10") and follows a consistent visual language: AI Copilot suggestions in teal callout boxes with a confidence indicator, human-in-the-loop confirmation notes, and status badges for approvals/gaps/maturity levels.

## What's real vs. what's mocked

This is the most important thing to understand before demoing or extending this:

- **Real:** the Company Onboarding chat. It calls an actual LLM through `server.js`, holds a genuine multi-turn conversation, and generates the checklist via a live tool call (or a JSON-text fallback for models that don't support tools natively).
- **Mocked:** everything else. The other 13 screens are static HTML with hardcoded example data (fictional company "Meridian Manufacturing", fictional suppliers, fictional gap registers, etc.). Buttons, dropdowns, and "Accept Checklist & Create Project" don't do anything — there's no routing between screens based on onboarding output, no persistence, no actual project state.
- **Not grounded in the real TR149 standard.** The onboarding agent's system prompt only tells it the five domain names (Energy & Emissions, Supplier Sustainability, Waste & Materials, Product Life Cycle, People & Workplace) and asks it to write plausible checklist items. It is not reading the actual TR149 criteria matrix. Treat generated checklist content as illustrative, not authoritative.

## How to run it

Quick version — full detail in `README_ACE_backend.md`:

```
# Cheapest/no-signup option — local model via Ollama
ollama pull qwen3.5:4b
ollama serve
node server.js

# Or point it at a real API instead
ANTHROPIC_API_KEY=sk-ant-... node server.js
OPENROUTER_API_KEY=sk-or-... node server.js
```

Then open **http://localhost:8787** (not the `.html` file directly — the onboarding chat needs same-origin access to `/api/chat`). Server auto-detects the provider from whichever key is set, or force it with `PROVIDER=anthropic|openrouter|ollama`.

If you only want to look at the static screens (no chat), you can open `TR149_Platform_Mockup.html` directly in a browser — everything except the onboarding chat works without the server.

## Architecture notes for the backend

- `server.js` normalizes all three providers' responses into one shape (`{ content: [...] }`, Anthropic's native content-block format) so the frontend code is provider-agnostic.
- OpenRouter and Ollama both speak the OpenAI-compatible `chat/completions` format and share one code path (`callOpenAICompatible`); Anthropic has its own (`callAnthropic`).
- The checklist is produced via a `generate_checklist` tool call. If a model doesn't return a native tool call, `extractFallbackChecklist` looks for a fenced &#96;&#96;&#96;json block in the plain-text reply instead — needed because not all Ollama models support tool calling reliably (some, like base `gemma3`, don't support it at all and are rejected by Ollama before the request is even sent).
- Default local model is `qwen3.5:4b` — confirmed tool-calling-capable at time of writing. Check [ollama.com/search?c=tools](https://ollama.com/search?c=tools) before swapping models; anything not tagged `tools` there will fail immediately.
- No auth on `/api/chat`, no conversation persistence (refreshing the page loses the chat), no rate limiting. Fine for local demo use, not production-ready.

## Testing status — what's actually been verified

- Anthropic path: verified end-to-end against the real API (using a deliberately invalid key to confirm the request reaches Anthropic and gets a clean structured error back, not a crash). This also caught and fixed a real bug — the server used to crash if an upstream error response wasn't valid JSON.
- OpenRouter and Ollama paths: verified the request is correctly formed and that connection failures / bad responses are handled gracefully with clear error messages — but not verified against a live successful response, since neither `openrouter.ai` nor a local Ollama instance were reachable from the build environment. You are effectively the first live test of the happy path for both.
- The `extractFallbackChecklist` JSON-parsing logic was unit-tested in isolation (fenced block, raw JSON, and plain-text-no-match cases all pass).
- Visual/static screens: rendered via a headless browser and screenshotted to confirm layout doesn't break (see `ACE_onboarding_screenshot.png`); not tested across real browsers or screen sizes beyond that.

## Known gaps / suggested next steps

Roughly in priority order if this moves beyond a demo:

1. **Ground the checklist in real TR149 content.** Feed the actual TR149 criteria matrix into the system prompt or a retrieval step, rather than letting the model invent plausible-sounding items from five domain names.
2. **Wire the "Accept Checklist & Create Project" action** to actually carry data into the Project Setup screen, so the onboarding flow connects to the rest of the mockup instead of being an isolated demo.
3. **Add conversation persistence** (even just localStorage) so the onboarding chat survives a page refresh.
4. **Decide on a real provider/model** for anything beyond local testing — Ollama is free but small local models are noticeably less reliable at the checklist step than Claude or GPT-4-class models.
5. **Auth and rate limiting** on `/api/chat` before this touches anything public.
6. **Extend "live" beyond onboarding** — Evidence Upload & AI Mapping and Reviewer Approval are the next most natural candidates to wire up to real agent behavior, since they already have well-defined AI-agent roles in the source spreadsheet.

## Source material

All screen content, user stories, actor definitions, and AI agent roles trace back to `TR149_Platform_AI_Copilot_User_Stories_Draft.xlsx` (in the uploads folder), specifically the "02 User Stories", "03 Actors", "05 AI Agents", "06 Flows", and "Mock-UI" sheets. Refer back to that file for the original intent behind any screen before making significant changes.

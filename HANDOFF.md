# ACE — Handoff & Setup

> Current, authoritative setup guide (supersedes the original `ACE_Handover.md`,
> which describes the 10 Jul 2026 starting state). If you are another Claude Code
> instance picking this up on a new machine, start here.

ACE (Agentic Compliance Engine) is a clickable demo of a TR149 sustainability
assessment platform. The **Company Onboarding** screen is a real, working LLM
agent; the other screens are static mockups, currently themed to **BreadTalk**
(an F&B prospect). You paste a company website and the agent pre-fills an intro,
has a short 3-round conversation, then generates a tailored TR149 checklist.

Repo: `github.com/CODINGINWATER/tr149-checklist` (public).

---

## 1. Get the code

```bash
# HTTPS (works anywhere, repo is public):
git clone https://github.com/CODINGINWATER/tr149-checklist.git
# or SSH, if this machine's key is on the GitHub account:
git clone git@github.com:CODINGINWATER/tr149-checklist.git
cd tr149-checklist
```

There is **no `npm install` for the app itself** — `server.js` has zero
dependencies. (Only the optional demo recorder in `demo/` needs npm — see §5.)

---

## 2. Prerequisites

- **Node.js 18+** (uses native `fetch`, ES modules, and `AbortSignal.timeout`).
- **One LLM provider** — pick either:
  - **Local Ollama (free, no key):** install Ollama, then a *tools-capable* model.
    Default is `qwen3.5:4b`. `ollama pull qwen3.5:4b`
  - **Anthropic API key** (best quality/speed), or
  - **OpenRouter API key**.
- Optional, only for regenerating the demo video: **ffmpeg** + **Playwright**.

---

## 3. Run it

Pick the provider you set up:

```bash
# A) Local Ollama (start "ollama serve" in another terminal first)
node server.js

# B) Anthropic
ANTHROPIC_API_KEY=sk-ant-...  node server.js

# C) OpenRouter
OPENROUTER_API_KEY=sk-or-...  node server.js
```

Then open **http://localhost:8787** in a browser.

> **Gotcha — keys are read from the process env only.** `server.js` does **not**
> load `.env.local`. Pass the key inline (as above) or `export` it in the shell.
> With no key set, it auto-falls back to Ollama.

The provider is auto-detected from whichever key is set; override with
`PROVIDER=anthropic|openrouter|ollama`. Port override: `PORT=…`.

---

## 4. How it works (architecture)

- **`server.js`** — dependency-free Node `http` server. Serves the HTML plus two
  JSON endpoints:
  - **`POST /api/chat`** — the onboarding agent. Caps the conversation at **3 user
    turns**: asks questions on turns 1–2, then *forces* the `generate_checklist`
    tool call on turn 3. Provider-agnostic (Anthropic / OpenRouter / Ollama, all
    normalised to one response shape). Also **detects a URL in a chat message**,
    scrapes it, and folds the page content into the agent's context.
  - **`POST /api/scrape`** — powers the "Pre-fill from website" field. Two steps:
    (1) plain `fetch()` of the page + regex HTML-strip (no AI), then (2) an LLM
    call (`callLLMPlain`) that summarises it into a first-person intro. Has a
    basic SSRF guard and a 30-min in-memory cache.
- **`TR149_Platform_Mockup.html`** — single self-contained vanilla HTML/CSS/JS
  file, 14 screens toggled by `showScreen()`. Sidebar shows Onboarding, Setup
  (incl. the **About** company-summary page), Assessment, Review, Improve.
  "Extended Scope" and "Admin" groups are intentionally hidden (commented out).
- **No database, auth, persistence, or rate limiting** — it's a local demo.

Key files also: `README_ACE_backend.md` (provider notes), `demo/` (recorder),
`ACE_demo.mp4` (latest walkthrough), `ACE_Handover.md` (original 10 Jul doc).

---

## 5. Regenerating the demo video (optional)

```bash
cd demo
npm install
npx playwright install chromium
# with the ACE server running in another terminal:
node record-demo.cjs                       # defaults to https://www.breadtalk.com/
node record-demo.cjs https://some-company.com/about   # any company
```

Raw `.webm` lands in `demo/output/`; convert to MP4 with the ffmpeg command in
`demo/README.md`. The two follow-up replies (turns 2–3) are hard-coded in
`record-demo.cjs` for BreadTalk — edit them for a different company.

---

## 6. Known gotchas

- **Keys not read from `.env.local`** (see §3).
- **Ollama model must support tools** — `qwen3.5:4b` works; base `gemma3` does not.
- **`qwen3.5` is a "thinking" model.** The Ollama path uses the **native
  `/api/chat` with `think:false`** on purpose. On the OpenAI-compat endpoint it
  strands the answer in a `reasoning` field (blank chat) and is ~10× slower.
  Set `OLLAMA_THINK=1` only if you deliberately want reasoning back.
- **Scraper only sees server-rendered HTML.** JS-heavy SPA sites return little
  text; the intro will be thin. BreadTalk/Elixir work because their copy is in
  the served HTML.
- **`/api/scrape` takes ~5–8s on the local model** (almost all of it the LLM
  summarisation, not the fetch). A real API key cuts this to ~1s.
- **Content is illustrative, not authoritative** — the checklist is not grounded
  in the real TR149 standard; the agent only knows the five domain names.
- Open via **http://localhost:8787**, not the `.html` file directly (there is a
  `file://` → localhost fallback, but the served path is the intended one).

---

## 7. What changed most recently (this branch)

- URL company scraper: a "Pre-fill from website" field **and** inline URL
  detection in the chat.
- 3-round onboarding cap with a forced checklist on the final turn.
- Whole mockup re-themed from the original electronics example to **BreadTalk**,
  plus a new **About** (company summary) page under Setup.
- Multi-line auto-growing reply box; removed developer-facing UI text.

---

## 8. Suggested next steps (if taken beyond a demo)

1. Set a real provider key for quality and speed.
2. Ground the checklist in the actual TR149 criteria (prompt or retrieval).
3. Wire "Accept Checklist & Create Project" to carry data into Project Setup.
4. Add persistence + auth + rate limiting before anything public-facing.
5. Optional: make the scraper render JS (headless browser) for SPA sites.

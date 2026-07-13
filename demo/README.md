# ACE demo recorder

Records a video walkthrough of the ACE onboarding flow and page tour using Playwright.

The onboarding intro is **pre-filled from a company website** (the server scrapes it
via `/api/scrape`), so you pass a URL instead of typing a company description.

## Setup (first time)

```bash
cd demo
npm install
npx playwright install chromium
```

## Record

1. Start the ACE server from the project root (see `../README_ACE_backend.md`):
   ```bash
   node ../server.js        # or: ANTHROPIC_API_KEY=sk-ant-... node ../server.js
   ```
2. Run the recorder (defaults to Elixir Technology):
   ```bash
   node record-demo.cjs
   # or for another company:
   node record-demo.cjs https://example.com/about
   ```

The raw `.webm` lands in `demo/output/`. Convert to MP4 with ffmpeg if you like:

```bash
ffmpeg -i output/<file>.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart -crf 22 ../ACE_demo.mp4
```

## Notes

- Headcount / office locations aren't on most company sites, so the two follow-up
  replies (turns 2 and 3) are set in `record-demo.cjs` — edit them for a different company.
- Env overrides: `ACE_URL` (default `http://localhost:8787`), `COMPANY_URL`.

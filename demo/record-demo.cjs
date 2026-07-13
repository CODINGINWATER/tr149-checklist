// ACE demo recorder.
// Drives the live onboarding flow (pre-filling the intro from a company URL),
// generates the checklist, tours every visible page, and records it all to video.
//
// Prereqs (first time):
//   cd demo && npm install && npx playwright install chromium
// Then, with the ACE server running (node server.js) on http://localhost:8787:
//   node record-demo.cjs [companyUrl]
//
// The company URL (defaults to Elixir Technology) is scraped by the server to
// pre-fill the first onboarding message, so you supply a link instead of a blurb.
const { chromium } = require('playwright');
const path = require('path');

const BASE = process.env.ACE_URL || 'http://localhost:8787';
const COMPANY_URL = process.argv[2] || process.env.COMPANY_URL || 'https://elixirtech.com/company/index.html';
const OUT = path.join(__dirname, 'output');

// Two natural follow-up replies. Details like headcount and office locations
// aren't on the website, so they're supplied here. Turn 1 is pre-filled by
// scraping COMPANY_URL, which means the checklist lands on turn 3.
const messages = [
  "We're a pretty lean team, around 60 people. HQ is here in Singapore, but a big part of our engineering is an offshore team in Kota Kinabalu, Malaysia, and we've got smaller groups working remotely in Vietnam, Thailand and the UK.",
  "Since we're a software business we don't have factories or physical products. Our footprint is really our offices, cloud infrastructure and a very distributed team. Some of our enterprise and government clients are starting to ask about sustainability though, so we'd like to get assessed in the first half of next year.",
];

const tour = [
  'project-setup', 'scope-setup', 'owner-assignment',
  'guided-assessment', 'evidence-upload', 'env-data',
  'ai-maturity', 'reviewer-approval',
  'gap-roadmap', 'mgmt-summary',
];

const wait = (p, ms) => p.waitForTimeout(ms);

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  const video = page.video();

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await wait(page, 1800); // read the greeting

  // Turn 1: paste the company website and let ACE pre-fill the intro from it.
  const urlBox = page.locator('#ace-url-input');
  await urlBox.click();
  await urlBox.pressSequentially(COMPANY_URL, { delay: 20 });
  await wait(page, 500);
  const scrapeResp = page.waitForResponse(r => r.url().includes('/api/scrape'), { timeout: 90000 });
  await page.click('#ace-url-btn');
  await scrapeResp;
  await page.waitForFunction(() => document.getElementById('ace-chat-input').value.trim().length > 0, { timeout: 90000 });
  await wait(page, 3200); // let the viewer read the auto-filled intro
  {
    const resp = page.waitForResponse(r => r.url().includes('/api/chat'), { timeout: 90000 });
    await page.click('#ace-send-btn');
    await resp;
    await wait(page, 3000); // read the agent's follow-up question
  }

  // Turns 2 and 3: natural follow-ups; the checklist is forced on turn 3.
  const input = page.locator('#ace-chat-input');
  for (let i = 0; i < messages.length; i++) {
    await input.click();
    await input.pressSequentially(messages[i], { delay: 22 });
    await wait(page, 500);
    const resp = page.waitForResponse(r => r.url().includes('/api/chat'), { timeout: 90000 });
    await page.click('#ace-send-btn');
    await resp;

    if (i < messages.length - 1) {
      await wait(page, 3000);
    } else {
      await page.waitForSelector('#ace-checklist-card', { state: 'visible', timeout: 90000 });
      await wait(page, 1200);
      await page.locator('#ace-checklist-card').scrollIntoViewIfNeeded();
      await wait(page, 4000);
    }
  }

  // Smoothly pan the .content scroll container using rAF + easing, so the motion
  // is an even glide rather than the browser's abrupt jump.
  async function smoothScroll(target, duration) {
    await page.evaluate(({ target, duration }) => new Promise((resolve) => {
      const c = document.querySelector('.content');
      const start = c.scrollTop;
      const end = target === 'bottom' ? Math.max(0, c.scrollHeight - c.clientHeight) : 0;
      const dist = end - start;
      if (Math.abs(dist) < 4) return resolve();
      const t0 = performance.now();
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2); // easeInOutQuad
      (function step(now) {
        const p = Math.min(1, (now - t0) / duration);
        c.scrollTop = start + dist * ease(p);
        p < 1 ? requestAnimationFrame(step) : resolve();
      })(performance.now());
    }), { target, duration });
  }

  // Tour every visible page in flow order.
  for (const id of tour) {
    await page.click(`.nav-item[onclick*="'${id}'"]`);
    await page.evaluate(() => document.querySelector('.content').scrollTo({ top: 0 }));
    await wait(page, 1600);
    await smoothScroll('bottom', 3800);
    await wait(page, 1300);
    await smoothScroll('top', 1900);
    await wait(page, 500);
  }

  await wait(page, 1200);
  await context.close(); // finalizes the video file
  await browser.close();

  console.log('VIDEO_RAW=' + await video.path());
})().catch((e) => { console.error(e); process.exit(1); });

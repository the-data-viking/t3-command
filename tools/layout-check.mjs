// Layout check: runs the UI against the built-in demo fleet (`?demo`, no server, no real agents)
// at desktop and phone sizes, asserts the layout rules that have broken before, and saves a
// screenshot of each view for a human look.
//
//   npm run check:layout                 # starts its own Vite dev server
//   npm run check:layout -- http://127.0.0.1:5173   # or use one that's already running
//
// Uses the system Chrome (Playwright's `chrome` channel); no browser download needed.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, devices } from "playwright";

const OUT = path.join(os.tmpdir(), "t3c-layout");
const VIEWS = [
  { name: "desktop-1440", viewport: { width: 1440, height: 900 } },
  { name: "desktop-1280", viewport: { width: 1280, height: 800 } },
  { name: "iphone-14", device: devices["iPhone 14"] },
  { name: "iphone-se", device: devices["iPhone SE"] },
];

async function startVite() {
  const port = 5199;
  const child = spawn("npx", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return { url, stop: () => child.kill() }; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error("Vite didn't start");
}

const failures = [];
const check = (view, ok, what) => { if (!ok) failures.push(`${view}: ${what}`); };
const overlap = (a, b) => a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const rect = (page, sel) => page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return r.width && r.height ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null; }, sel);

async function run(base) {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome" });
  for (const view of VIEWS) {
    const context = await browser.newContext(view.device ?? { viewport: view.viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}?demo`);
    await page.waitForTimeout(2500);
    const phone = !!view.device;
    const shot = (n) => page.screenshot({ path: path.join(OUT, `${view.name}-${n}.png`) });
    await shot("home");
    const vw = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, scroll: document.documentElement.scrollWidth }));
    check(view.name, vw.scroll <= vw.w, `page is wider than the screen (${vw.scroll} > ${vw.w})`);

    if (phone) {
      // The dock's "need you" and the top bar's Needs you are the same number.
      const counts = await page.evaluate(() => ({
        needs: Number(document.querySelector(".queue-btn strong")?.textContent ?? 0),
        dock: Number(document.querySelector(".needs-count")?.textContent?.match(/\d+/)?.[0] ?? 0),
      }));
      check(view.name, counts.needs === counts.dock, `dock says ${counts.dock} need you, top bar says ${counts.needs}`);
    }
    // A crew member's panel sits below the top bar, never over its controls.
    // On a phone the roster opens by itself when something needs you; otherwise its tab opens it.
    if (phone && !(await page.locator(".crew-row:not(.operator-row)").first().isVisible().catch(() => false))) { await page.tap(".phone-tab"); await page.waitForTimeout(300); }
    // (On a phone a Needs you row opens its decision card, so take an on-duty one: they come last.)
    await page.locator(".crew-row:not(.operator-row)")[phone ? "last" : "first"]().click();
    await page.waitForTimeout(800);
    const bar = await rect(page, ".topbar"), panel = await rect(page, ".panel");
    check(view.name, panel && bar && panel.top >= bar.bottom - 1, `crew panel overlaps the top bar (panel top ${panel?.top}, bar bottom ${bar?.bottom})`);
    // Every control in the panel's header row stays inside the panel.
    const spill = await page.evaluate(() => {
      const panel = document.querySelector(".panel")?.getBoundingClientRect();
      return [...document.querySelectorAll(".panel .status-row > *")].map((el) => el.getBoundingClientRect()).filter((r) => panel && r.width && r.right > panel.right + 1).length;
    });
    check(view.name, spill === 0, `${spill} crew panel header controls run off the panel's right edge`);
    await shot("crew");
    await page.keyboard.press("Escape");

    // History: the charts keep their height when the dialog overflows.
    if (phone) { await page.tap(".menu-btn"); await page.waitForTimeout(200); await page.tap("button:has-text('History')"); }
    else { await page.click("button:has-text('More')"); await page.waitForTimeout(200); await page.click("button:has-text('History')"); }
    await page.waitForTimeout(800);
    const bars = await rect(page, ".history-bars");
    check(view.name, bars && bars.height > 40, `history turns chart is squeezed (${bars?.height ?? "missing"} px)`);
    await shot("history");
    await page.keyboard.press("Escape");
    await page.mouse.click(5, vw.h - 5).catch(() => {});
    await page.evaluate(async () => { const { useGame } = await import("/src/store.ts"); useGame.setState({ showHistory: false, selection: null }); });

    if (!phone) {
      // The roster stops above the minimap instead of running under it.
      check(view.name, !overlap(await rect(page, ".crew-roster"), await rect(page, ".minimap")), "crew roster runs under the minimap");
      // The command palette opens fully on screen, below its backdrop's top edge.
      await page.keyboard.press("Control+k");
      await page.waitForTimeout(300);
      const palette = await rect(page, ".palette");
      check(view.name, palette && palette.top > 0 && palette.bottom <= vw.h, `command palette is off screen (${JSON.stringify(palette)})`);
      await shot("palette");
      await page.keyboard.press("Escape");

      // The comms log opens beside the roster, not on top of it.
      await page.evaluate(async () => { const { useGame } = await import("/src/store.ts"); useGame.setState({ showLog: true }); });
      await page.waitForTimeout(300);
      check(view.name, !overlap(await rect(page, ".comms-log"), await rect(page, ".crew-roster")), "comms log covers the crew roster");
      await shot("log");
      await page.evaluate(async () => { const { useGame } = await import("/src/store.ts"); useGame.setState({ showLog: false }); });
    } else {
      // Popovers opened from the tall phone menu stay on screen.
      await page.tap(".menu-btn");
      await page.waitForTimeout(200);
      await page.tap(".topbar-more summary.resource >> nth=0"); // Spend; limits share the same sheet styling.
      await page.waitForTimeout(400);
      const sheet = await rect(page, ".spend-breakdown");
      check(view.name, !sheet || (sheet.top >= 0 && sheet.bottom <= vw.h + 1 && sheet.height > 80), `spend sheet is off screen or cut (${JSON.stringify(sheet)})`);
      await shot("limits");
    }
    check(view.name, errors.length === 0, `page errors: ${errors.join(" | ")}`);
    await context.close();
  }
  await browser.close();
}

const given = process.argv[2];
const server = given ? { url: given.endsWith("/") ? given : `${given}/`, stop: () => {} } : await startVite();
try {
  await run(server.url);
} finally {
  server.stop();
}
console.log(`Screenshots: ${OUT}`);
if (failures.length) {
  console.error(`Layout check failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`Layout check passed (${VIEWS.length} views).`);

#!/usr/bin/env node
/**
 * One off screenshot with live quality overrides, for visual A/B checks.
 *   node scripts/shot.mjs <scenario> <out.png> [--dist=dist] [--quality=high] [--set=volScale:1,msaa:0]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const [scenario, out] = args.filter((a) => !a.startsWith('--'));
const dist = opt('dist', 'dist');
const quality = opt('quality', 'high');
const sets = opt('set', '').split(',').filter(Boolean).map((s) => s.split(':'));
const port = await new Promise((res) => {
  const s = createServer();
  s.listen(0, () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const proc = spawn('npx', ['vite', 'preview', '--outDir', dist, '--port', String(port), '--strictPort'], { stdio: 'pipe' });
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`http://localhost:${port}/`)).ok) break;
  } catch {
    /* wait */
  }
  await new Promise((r) => setTimeout(r, 150));
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync),
  headless: true,
  args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://localhost:${port}/?scenario=${scenario}&quality=${quality}`);
await page.waitForFunction(() => window.__game?.getState?.().ready, null, { timeout: 30000 });
await page.evaluate(
  ([q, kv]) => {
    const g = window.__game;
    for (const [k, v] of kv) g.config.quality.presets[q][k] = Number(v);
    g.quality.notify();
  },
  [quality, sets],
);
await page.waitForTimeout(3500);
await page.screenshot({ path: out });
await browser.close();
proc.kill('SIGTERM');
process.exit(0);

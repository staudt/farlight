#!/usr/bin/env node
/**
 * Frame rate bench, interleaved so machine load hits every variant equally.
 *   node scripts/bench.mjs [scenario ...] [--variants=name:dist:quality,...] [--secs=5] [--runs=2]
 * Default variant is "cur:dist:" (the current build, default quality). Each scenario runs every
 * variant in turn, `runs` times; the best fps per variant is reported (the machine is shared).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const secs = Number(opt('secs', 5));
const runs = Number(opt('runs', 2));
const variants = opt('variants', 'cur:dist:')
  .split(',')
  .map((v) => {
    const [name, dist, quality] = v.split(':');
    return { name, dist, quality };
  });
const names = args.filter((a) => !a.startsWith('--'));
const list = names.length ? names : ['earth-low-morning', 'earth-storm', 'atmo-entry', 'earth-orbit', 'jupiter-skim', 'saturn-rings'];
mkdirSync('artifacts/bench', { recursive: true });

const servers = new Map();
for (const dist of new Set(variants.map((v) => v.dist))) {
  const port = await new Promise((res) => {
    const s = createServer();
    s.listen(0, () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
  const proc = spawn('npx', ['vite', 'preview', '--outDir', dist, '--port', String(port), '--strictPort'], { stdio: 'pipe' });
  process.on('exit', () => proc.kill('SIGTERM'));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/`)).ok) break;
    } catch {
      /* wait */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  servers.set(dist, { port, proc });
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? ['/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync),
  headless: true,
  args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--enable-unsafe-swiftshader'],
});
console.log(['scenario', ...variants.map((v) => v.name)].join('\t'));
for (const name of list) {
  const best = variants.map(() => ({ fps: 0, gpu: 0, calls: 0 }));
  for (let r = 0; r < runs; r++) {
    for (let vi = 0; vi < variants.length; vi++) {
      const v = variants[vi];
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(`http://localhost:${servers.get(v.dist).port}/?scenario=${name}${v.quality ? `&quality=${v.quality}` : ''}`);
      await page.waitForFunction(() => window.__game?.getState?.().ready, null, { timeout: 30000 });
      await page.waitForTimeout(2500);
      const f0 = await page.evaluate(() => window.__game.getState().frames);
      const t0 = Date.now();
      await page.waitForTimeout(secs * 1000);
      const f1 = await page.evaluate(() => window.__game.getState().frames);
      const fps = (f1 - f0) / ((Date.now() - t0) / 1000);
      const gb = await page.evaluate(() => window.__game.post?.perf?.gpuBest ?? 0);
      if (fps > best[vi].fps) {
        best[vi].fps = fps;
        await page.screenshot({ path: `artifacts/bench/${v.name}-${name}.png` });
      }
      if (gb > 0 && (best[vi].gpu === 0 || gb < best[vi].gpu)) best[vi].gpu = gb;
      await page.close();
    }
  }
  console.log([name, ...best.map((b) => `${b.fps.toFixed(1)}${b.gpu ? ` (gpu ${b.gpu.toFixed(1)})` : ''}`)].join('\t'));
}
await browser.close();
for (const s of servers.values()) s.proc.kill('SIGTERM');
process.exit(0);

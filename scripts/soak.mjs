#!/usr/bin/env node
/**
 * Long flight soak test: stability, leaks, frame spikes.
 *   node scripts/soak.mjs [--no-build] [--minutes=11] [--sample=10] [--profile=phone] [--quality=low|medium|high]
 * --profile=phone: 844x390 at deviceScaleFactor 3, touch, ?touch&quality=low (or --quality), CPU throttled 4x via CDP.
 * Flies a scripted route (low flight, climb, warp, belt, Jupiter, UI toggling, quality cycling,
 * three hyperspace jumps) and samples heap, renderer.info, chunk and object counts every 10 s.
 * Writes artifacts/soak/report.json and samples.csv. Exit code 1 when growth or errors are flagged.
 * A hyperspace jump is a real navigation (fresh page); the leak analysis runs per page segment.
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const num = (n, d) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? Number(a.split('=')[1]) : d;
};
const MINUTES = num('minutes', 11);
const SAMPLE_S = num('sample', 10);
const strArg = (n, d) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=')[1] : d;
};
const PHONE = strArg('profile', '') === 'phone';
const QUALITY = strArg('quality', PHONE ? 'low' : '');
const URL_QS = `${PHONE ? '&touch' : ''}${QUALITY ? `&quality=${QUALITY}` : ''}`;
const OUT = PHONE ? `artifacts/soak-phone-${QUALITY}` : 'artifacts/soak';
const BROWSER = process.env.CHROMIUM_PATH ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
const PORT = await new Promise((resolve) => {
  const srv = createServer();
  srv.listen(0, () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});
mkdirSync(OUT, { recursive: true });
if (!flag('no-build')) execSync('npx vite build --logLevel error', { stdio: 'inherit' });
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/`)).ok) break;
  } catch {
    /* not up yet */
  }
  if (i > 100) throw new Error('preview server did not start');
  await new Promise((r) => setTimeout(r, 150));
}

const browser = await chromium.launch({
  executablePath: BROWSER,
  headless: true,
  args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--enable-precise-memory-info', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage(
  PHONE
    ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true }
    : { viewport: { width: 1280, height: 720 } },
);
if (PHONE) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}
const messages = [];
const t0 = Date.now();
let phase = 'boot';
let segment = 0;
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') messages.push({ t: (Date.now() - t0) / 1000, phase, type: m.type(), text: m.text().slice(0, 300) });
});
page.on('pageerror', (e) => messages.push({ t: (Date.now() - t0) / 1000, phase, type: 'pageerror', text: String(e).slice(0, 300) }));
// Frame time spike logger, reinstalled on every navigation.
await page.addInitScript(() => {
  window.__spikes = [];
  window.__dts = [];
  let last = performance.now();
  const tick = (now) => {
    const dt = now - last;
    last = now;
    if (window.__game?.getState().frames > 60 && window.__dts.length < 200000) window.__dts.push(dt);
    if (dt > 100 && window.__game?.getState().frames > 60) window.__spikes.push({ at: Math.round(now), dt: Math.round(dt), phase: window.__phase ?? '' });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const samples = [];
const spikes = [];
const allDts = [];

async function sample() {
  try {
    const s = await page.evaluate(() => {
      const g = window.__game;
      if (!g?.getState) return null;
      const info = g.gfx.renderer.info;
      let objects = 0;
      let planetMeshes = 0;
      g.gfx.scene.traverse((o) => {
        objects++;
        if (o.isMesh && o.parent?.name?.startsWith('planet:')) planetMeshes++;
      });
      const st = g.getState();
      const life = window.__life?.stats?.();
      return {
        heapMB: performance.memory.usedJSHeapSize / 1048576,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
        chunks: planetMeshes,
        pending: st.pending,
        sceneObjects: objects,
        dom: document.getElementsByTagName('*').length,
        life: life ? life.flocks + life.pods + life.schools + life.swarms : 0,
        landmarks: g.world.landmarks?.all?.length ?? 0,
        fps: Math.round(st.fps),
        body: st.body,
        sim: st.simTime,
      };
    });
    if (!s) return;
    samples.push({ t: Math.round((Date.now() - t0) / 100) / 10, segment, phase, ...s });
    const dts = await page.evaluate(() => window.__dts.splice(0));
    for (const d of dts) allDts.push(d);
    const sp = await page.evaluate(() => window.__spikes.splice(0));
    for (const x of sp) spikes.push({ segment, ...x });
  } catch {
    /* navigating */
  }
}
const sampler = setInterval(sample, SAMPLE_S * 1000);

async function waitReady() {
  await page.waitForFunction(() => window.__game?.getState?.().ready, null, { timeout: 60000 });
  segment++;
}
async function setPhase(name) {
  phase = name;
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${name}`);
  await page.evaluate((n) => (window.__phase = n), name).catch(() => {});
}
/** Slow scripted steering (ext axes), optional boost and throttle. Runs inside the page. */
const steer = (o = {}) =>
  page.evaluate((o) => {
    clearInterval(window.__steer);
    const g = window.__game;
    const t0 = performance.now();
    window.__steer = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      const e = g.input.external;
      e.active = true;
      e.yaw = (o.yaw ?? 0.35) * Math.sin(t * 0.35);
      e.pitch = o.pitch ?? 0.12 * Math.sin(t * 0.21);
      e.roll = (o.roll ?? 0.3) * Math.sin(t * 0.5);
      e.boost = !!o.boost;
      if (o.throttle !== undefined) e.throttleSet = o.throttle;
    }, 100);
  }, o);
const scenario = (n) => page.evaluate((n) => window.__game.applyScenario(n), n);
const warpTo = (i) => page.evaluate((i) => (window.__game.world.clock.warpIndex = i), i);
const sleep = (s) => page.waitForTimeout(s * 1000);
/** Toggles look, photo, maps, settings and the quality level on a timer. */
const ui = (on, cycleQuality = false) =>
  page.evaluate(
    ([on, cq]) => {
      clearInterval(window.__ui);
      const g = window.__game;
      if (!on) {
        g.overlay.close();
        if (g.photo.active) g.photo.exit();
        if (g.input.lookMode) g.input.emit('look');
        if (g.settings.isOpen) g.settings.close();
        return;
      }
      let n = 0;
      const levels = ['low', 'medium', 'high'];
      window.__ui = setInterval(() => {
        n++;
        const i = g.input;
        switch (n % 8) {
          case 0: i.emit('look'); break;
          case 1: i.emit('map'); break;
          case 2: i.emit('galaxy'); break;
          case 3: i.emit('journal'); break;
          case 4: i.emit('back'); if (g.input.lookMode) i.emit('look'); break;
          case 5: i.emit('settings'); break;
          case 6: i.emit('back'); if (g.settings.isOpen) g.settings.close(); break;
          case 7: if (!g.settings.isOpen && !g.overlay.isOpen) g.photo.toggle(); break;
        }
        if (n % 8 === 0 && g.photo.active) g.photo.exit();
        if (cq && n % 8 === 2) g.quality.setLevel(levels[(n >> 3) % 3]);
      }, 700);
    },
    [on, cycleQuality && !QUALITY],
  );

/** Phase plan: [label, seconds weight, action]. Scaled to MINUTES. */
const plan = [
  ['earth low morning', 6, async () => (await scenario('earth-low-morning'), steer())],
  ['earth forest low', 4, async () => (await scenario('earth-forest-low'), steer())],
  ['earth coast', 4, async () => (await scenario('ocean-coast'), steer())],
  ['earth night low, cities', 3, async () => (await scenario('earth-night-low'), steer())],
  ['landed warp 10k night', 3, async () => {
    await page.evaluate(() => {
      const w = window.__game.world;
      w.place({ body: 'earth', lat: 48, lon: 10, localHour: 21, altitude: 0, landed: true, heading: 0, throttle: 0 });
    });
    await steer({ yaw: 0, pitch: 0, roll: 0 });
    await warpTo(7);
  }],
  ['climb to space', 5, async () => {
    await warpTo(0);
    await scenario('earth-low-morning');
    await steer({ boost: true, throttle: 1, pitch: -0.5, yaw: 0, roll: 0 });
  }],
  ['orbit and high warp', 3, async () => {
    await scenario('earth-orbit');
    await steer({ throttle: 0.3 });
    await warpTo(7);
  }],
  ['deep space warp', 3, async () => (await warpTo(0), await scenario('deep-space-warp'), await steer({ throttle: 0.5 }), await warpTo(5))],
  ['asteroid belt', 4, async () => (await warpTo(0), await scenario('asteroid-belt'), await steer({ throttle: 0.4 }))],
  ['jupiter cloud sea', 4, async () => (await scenario('jupiter-skim'), await steer())],
  ['ui toggling over earth', 6, async () => (await scenario('earth-orbit-italy'), await steer({ throttle: 0.2 }), await ui(true, true))],
  ['body tour', 14, null],
  ['earth again (second pass)', 8, null],
];
const tourScenarios = ['mars-orbit', 'io-volcanoes', 'saturn-rings', 'venus-acid-rain', 'titan-rain', 'earth-storm', 'earth-snow', 'europa-geysers', 'moon-surface-earthrise', 'mars-mesas-low'];
const secondPass = ['earth-low-morning', 'earth-forest-low', 'ocean-coast', 'earth-night-low', 'jupiter-skim', 'asteroid-belt', 'earth-orbit', 'earth-storm'];
const JUMP_S = 35;
const solSeconds = MINUTES * 60 - 3 * (JUMP_S + 25);
const totalW = plan.reduce((a, p) => a + p[1], 0);

try {
  await page.goto(`http://localhost:${PORT}/?scenario=earth-low-morning${URL_QS}`);
  await waitReady();
  await sleep(3);
  await sample();
  for (const [label, w, act] of plan) {
    const secs = (solSeconds * w) / totalW;
    await setPhase(label);
    if (act) {
      await act();
      await sleep(secs);
    } else {
      const list = label.startsWith('body') ? tourScenarios : secondPass;
      await warpTo(0);
      await ui(true, true);
      await steer();
      for (const sc of list) {
        await scenario(sc);
        await sleep(secs / list.length);
      }
    }
  }
  await ui(false);
  await steer({ throttle: 0.2 });
  await setPhase('rest');
  await scenario('earth-low-morning');
  await sleep(10);
  await sample();

  // Hyperspace jumps to three generated systems (real navigations).
  const ids = await page.evaluate(() => {
    const g = window.__game;
    return g.galaxy.stars.filter((s) => s.id !== g.system.id).slice(1, 20).map((s) => s.id);
  });
  const picks = [ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]];
  for (let j = 0; j < 3; j++) {
    await setPhase(`jump ${j + 1} to ${picks[j]}`);
    const dest = picks[j];
    await page.evaluate((id) => {
      const g = window.__game;
      const star = g.galaxy.stars.find((s) => s.id === id);
      g.overlay.locked = false;
      g.hyper.start(star, 4);
    }, dest);
    await page.waitForURL((u) => u.search.includes(dest), { timeout: 60000 }).catch(() => {});
    await waitReady();
    await setPhase(`system ${dest}`);
    await steer({ throttle: 0.3 });
    await ui(true, false);
    await sleep(JUMP_S);
    await sample();
    await ui(false);
  }
} catch (e) {
  messages.push({ t: (Date.now() - t0) / 1000, phase, type: 'soak-failure', text: String(e).slice(0, 400) });
  console.error(e);
} finally {
  clearInterval(sampler);
  await sample();
  await browser.close().catch(() => {});
  stop();
}

// ---- analysis -------------------------------------------------------------------------------
const WARMUP_S = 90;
const flags = [];
const bySeg = new Map();
for (const s of samples) {
  if (!bySeg.has(s.segment)) bySeg.set(s.segment, []);
  bySeg.get(s.segment).push(s);
}
const min = (a) => Math.min(...a);
for (const [seg, all] of bySeg) {
  const base = all[0].t;
  const rows = all.filter((s) => s.t - base >= WARMUP_S);
  if (rows.length < 6) continue;
  for (const key of ['geometries', 'textures', 'programs', 'chunks', 'dom', 'sceneObjects']) {
    const v = rows.map((r) => r[key]);
    let up = 0;
    let down = 0;
    for (let i = 1; i < v.length; i++) {
      if (v[i] > v[i - 1]) up++;
      if (v[i] < v[i - 1]) down++;
    }
    const growth = v[v.length - 1] - v[0];
    const third = Math.max(2, Math.floor(v.length / 3));
    const tail = v.slice(-third);
    const stillRising = tail[tail.length - 1] > tail[0];
    const monotonic = down === 0 && up >= (v.length - 1) * 0.5;
    if (growth > Math.max(3, v[0] * 0.05) && stillRising && (monotonic || up > down * 3)) {
      flags.push(`segment ${seg}: ${key} grows ${v[0]} -> ${v[v.length - 1]} (up ${up}, down ${down}) without plateau`);
    }
  }
  const h = rows.map((r) => r.heapMB);
  const third = Math.max(2, Math.floor(h.length / 3));
  const first = min(h.slice(0, third));
  const last = min(h.slice(-third));
  if (last > first * 1.3) flags.push(`segment ${seg}: heap floor ${first.toFixed(0)} MB -> ${last.toFixed(0)} MB (+${Math.round((last / first - 1) * 100)}%)`);
}
const afterWarm = spikes.filter((s) => s.at > 20000);
// Frame time distribution over the whole run (fps percentiles: p5 is the slow tail).
allDts.sort((a, b) => a - b);
const pct = (p) => allDts[Math.min(allDts.length - 1, Math.floor(allDts.length * p))] ?? 0;
const fpsDist = { frames: allDts.length, p50: +(1000 / pct(0.5)).toFixed(1), p5: +(1000 / pct(0.95)).toFixed(1), p1: +(1000 / pct(0.99)).toFixed(1), over50ms: allDts.filter((d) => d > 50).length };
const errs = messages.filter((m) => m.type !== 'warning');
const report = {
  minutes: MINUTES,
  samples: samples.length,
  segments: bySeg.size,
  growthFlags: flags,
  frameSpikes: { count: afterWarm.length, worst: afterWarm.sort((a, b) => b.dt - a.dt).slice(0, 15) },
  profile: PHONE ? `phone-${QUALITY}` : 'desktop',
  fps: fpsDist,
  peakHeapMB: Math.round(Math.max(...samples.map((r) => r.heapMB), 0)),
  consoleErrors: errs.length,
  messages: messages.slice(0, 60),
  summary: [...bySeg].map(([seg, rows]) => ({
    segment: seg,
    first: rows[0],
    last: rows[rows.length - 1],
    peakHeapMB: Math.round(Math.max(...rows.map((r) => r.heapMB))),
    minFps: Math.min(...rows.map((r) => r.fps)),
  })),
  samplesData: samples,
};
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
const cols = ['t', 'segment', 'phase', 'heapMB', 'geometries', 'textures', 'programs', 'chunks', 'pending', 'sceneObjects', 'dom', 'life', 'landmarks', 'fps', 'body'];
writeFileSync(
  `${OUT}/samples.csv`,
  [cols.join(','), ...samples.map((s) => cols.map((c) => (typeof s[c] === 'number' ? +s[c].toFixed(1) : JSON.stringify(s[c] ?? ''))).join(','))].join('\n'),
);
console.log(`fps p50 ${fpsDist.p50} p5 ${fpsDist.p5} p1 ${fpsDist.p1}, frames >50ms ${fpsDist.over50ms}, peak heap ${report.peakHeapMB} MB, programs ${samples.at(-1)?.programs}`);
console.log(`samples ${samples.length}, segments ${bySeg.size}, spikes>100ms ${afterWarm.length}, console problems ${messages.length}`);
for (const f of flags) console.log(`FLAG ${f}`);
for (const m of messages.slice(0, 10)) console.log(`${m.type} [${m.phase}] ${m.text}`);
console.log(`Report: ${OUT}/report.json`);
process.exit(flags.length || errs.length ? 1 : 0);

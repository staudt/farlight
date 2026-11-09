# Farlight

A relaxed, smell-the-flowers solar system glider in the browser.

Launch from a planet, glide low over faceted hills and coastlines, climb through the
atmosphere as the sky turns from blue to black, and chase the other planets across the
system with time warp. Every planet and moon stays visible in the sky, and each world
has its own feel: Earth's oceans, clouds and auroras, the cratered Moon with Earth on the
horizon, Martian canyons under a dusty sky, the golden murk of Venus, Titan's orange haze,
Io beneath a looming Jupiter, Saturn's rings, and a dive into Jupiter's cloud sea.

**Play:** https://staudt.github.io/farlight/

## Controls

| Input | Action |
| --- | --- |
| Click | Capture the mouse and fly |
| Mouse | Steer (virtual stick) |
| W / S, wheel, 1 to 0 | Throttle |
| A / D | Roll |
| Q / E | Yaw |
| Shift | Boost (4x, climb high to go fast) |
| X | Brake |
| , / . | Slow down / speed up time |
| C | Chase or cockpit camera |
| M | System map, click a body to target it |
| G | Galaxy map: pick a star and Begin Travel to jump there |
| J | Journal: visited systems and survey progress |
| T | Cycle targets |
| F (hold) | Align the nose with the target |
| H | Hide the HUD |
| N | Mute |
| F3 | Tuning panel |

**On a phone** (landscape): left thumb anywhere steers with a floating stick, the right edge slider
sets throttle, and the big button boosts. Drag on the right to look around. The top row has time
warp, camera, map, target, hold to align, HUD, tilt steering and fullscreen.

Fly slowly near the ground to land. Once landed, you can warp time to watch sunsets and moonrises.

Try a scenario with `?scenario=` in the URL, for example `earth-low-morning`, `atmo-entry`,
`moon-surface-earthrise`, `mars-canyon`, `io-volcanoes`, `saturn-rings`, `jupiter-orbit`,
`jupiter-skim`, `earth-aurora-orbit` or `earth-storm`.

## Tech

TypeScript, Three.js and Vite. Notable pieces:

- A float64 simulation with a floating origin and a logarithmic depth buffer, so you can fly from a 20 m ship to planets millions of kilometres away.
- Planets on Kepler rails.
- Inertial and rotating body-fixed reference frames.
- Cube-sphere quadtree terrain built in Web Workers.
- Single-scattering atmospheres and raymarched volumetric clouds with cloud shadows, done as post effects.
- Procedural Web Audio.

Everything is generated from a data schema (`src/data`), ready for a procedural galaxy.

```bash
npm install
npm run dev      # http://localhost:5173
npm run check    # typecheck, lint, unit tests, build
npm run smoke    # headless GPU screenshots of every scenario
```

The successor to [spaceglider](https://github.com/staudt/spaceglider).

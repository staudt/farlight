import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { config } from '../../core/config';
import { mulberry32 } from '../../core/rng';
import { Simplex3, fbm } from '../../core/noise';
import type { ScaleProfile } from '../../data/scale';
import type { FrameContext } from '../context';
import { type Rock, ROCK_LEVELS, type ScaledBelt, beltDensity, rockInCell } from './spaceData';

const AU = 1.495978707e11;
const YEAR = 365.256 * 86400;
const CAPACITY = [480, 320, 140];
/** Far dust points fade out inside this distance, where real rocks take over (and float32 would jitter). */
const FADE_NEAR = 2.5e6;

/** A rough rock: displaced icosahedron, non indexed so every face is flat shaded. */
function rockGeometry(seed: number, detail: number, rough: number): BufferGeometry {
  const g = new IcosahedronGeometry(1, detail);
  const noise = new Simplex3(seed);
  const p = g.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const n = fbm(noise, v.x * 1.5, v.y * 1.5, v.z * 1.5, 3) * 0.6 + noise.noise(v.x * 4.2, v.y * 4.2, v.z * 4.2) * 0.18;
    // A few shallow craters: dents where a high frequency band peaks.
    const c = Math.max(0, noise.noise(v.x * 3.1 + 9, v.y * 3.1, v.z * 3.1) - 0.45);
    v.multiplyScalar(1 + rough * n - c * 0.5);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Asteroid belts. Far away they are a faint dusty band of a few thousand dots that orbit at
 * Keplerian speeds. Near the camera real rocks fill a camera local grid (three nested levels
 * from small tumblers to rare km scale boulders), so you can fly through a belt.
 */
export class AsteroidBelts {
  readonly object = new Group();
  private readonly dustMaterials: ShaderMaterial[] = [];
  private readonly meshes: InstancedMesh[] = [];
  private readonly lists: Rock[][] = ROCK_LEVELS.map(() => []);
  private readonly pool: Rock[][] = ROCK_LEVELS.map((_, i) => Array.from({ length: CAPACITY[i]! }, () => newRock()));
  private readonly lastCell: (string | null)[] = ROCK_LEVELS.map(() => null);
  private readonly beltOf: ScaledBelt[][] = ROCK_LEVELS.map(() => []);
  private lastDensity = -1;
  private readonly cam = new Vector3();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly s = new Vector3();
  private readonly pos = new Vector3();
  private readonly axis = new Vector3();
  private readonly tmpColor = new Color();

  constructor(
    private readonly belts: ScaledBelt[],
    private readonly scale: ScaleProfile,
  ) {
    this.object.name = 'belts';
    for (const b of belts) this.object.add(this.buildDust(b));
    if (belts.length === 0) return;
    const mat = new MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    const detail = [2, 2, 3];
    const rough = [0.34, 0.34, 0.3];
    ROCK_LEVELS.forEach((_, i) => {
      const mesh = new InstancedMesh(rockGeometry(1000 + i * 17, detail[i]!, rough[i]!), mat, CAPACITY[i]!);
      mesh.count = 0;
      mesh.frustumCulled = false;
      // setColorAt allocates the instance color buffer.
      mesh.setColorAt(0, this.tmpColor.setRGB(1, 1, 1));
      this.meshes.push(mesh);
      this.object.add(mesh);
    });
  }

  private buildDust(b: ScaledBelt): Points {
    const rnd = mulberry32(b.def.seed ^ 0x51a7);
    const n = b.def.count;
    const R = new Float32Array(n);
    const A = new Float32Array(n);
    const Y = new Float32Array(n);
    const S = new Float32Array(n);
    const B = new Float32Array(n);
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      // Radial profile: rejection sample against beltDensity so the soft edges match the rocks.
      let r = b.inner;
      for (let k = 0; k < 12; k++) {
        r = b.inner + (b.outer - b.inner) * rnd();
        if (rnd() < beltDensity(b, r, 0)) break;
      }
      const g = Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
      R[i] = r;
      A[i] = rnd() * Math.PI * 2;
      Y[i] = g * b.halfThickness * 0.7;
      const haze = rnd() < 0.18;
      S[i] = haze ? 9 + rnd() * 10 : 1.2 + rnd() * 1.4;
      B[i] = haze ? 0.035 + rnd() * 0.04 : 0.25 + Math.pow(rnd(), 2) * 0.9;
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('aR', new Float32BufferAttribute(R, 1));
    geo.setAttribute('aA', new Float32BufferAttribute(A, 1));
    geo.setAttribute('aY', new Float32BufferAttribute(Y, 1));
    geo.setAttribute('aS', new Float32BufferAttribute(S, 1));
    geo.setAttribute('aB', new Float32BufferAttribute(B, 1));
    const c = b.def.color;
    // Lift the tint toward a pale dust color so the far band reads even for dark rock.
    const tint = new Vector3(Math.min(1, c[0] * 2.2 + 0.25), Math.min(1, c[1] * 2.2 + 0.23), Math.min(1, c[2] * 2.2 + 0.22));
    const mat = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCam: { value: this.cam },
        uOmega1: { value: (Math.PI * 2) / YEAR },
        uR1: { value: AU * this.scale.planetOrbitScale },
        uColor: { value: tint },
        uBright: { value: 1 },
        uPixelRatio: { value: 1 },
        uFadeNear: { value: FADE_NEAR },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aR, aA, aY, aS, aB;
        uniform float uTime, uOmega1, uR1, uBright, uPixelRatio, uFadeNear;
        uniform vec3 uCam;
        varying float vA;
        void main() {
          float th = aA + uOmega1 * pow(aR / uR1, -1.5) * uTime;
          vec3 rel = vec3(aR * cos(th), aY, -aR * sin(th)) - uCam;
          float d = length(rel);
          vA = aB * uBright * smoothstep(uFadeNear, uFadeNear * 3.0, d);
          vec4 mv = modelViewMatrix * vec4(rel, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aS * uPixelRatio;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor;
        varying float vA;
        void main() {
          #include <logdepthbuf_fragment>
          float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
          gl_FragColor = vec4(uColor * a * vA, 1.0);
        }`,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.dustMaterials.push(mat);
    const pts = new Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -8;
    return pts;
  }

  /** The belt (if any) containing or near the world position, for the toast and the map. */
  beltAt(x: number, y: number, z: number): ScaledBelt | null {
    const r = Math.hypot(x, z);
    for (const b of this.belts) {
      if (r > b.inner && r < b.outer && Math.abs(y) < b.halfThickness * 2.5) return b;
    }
    return null;
  }

  update(ctx: FrameContext): void {
    if (this.belts.length === 0) return;
    const on = config.space.enabled;
    this.object.visible = on;
    if (!on) return;
    const cw = ctx.cameraWorld;
    this.cam.copy(cw);
    for (const m of this.dustMaterials) {
      m.uniforms.uTime!.value = ctx.simTime;
      m.uniforms.uBright!.value = config.space.beltDust;
      m.uniforms.uPixelRatio!.value = ctx.renderer.getPixelRatio();
    }
    this.updateRocks(ctx);
  }

  private updateRocks(ctx: FrameContext): void {
    const cw = ctx.cameraWorld;
    const density = config.space.rockDensity;
    const rr = Math.hypot(cw.x, cw.z);
    const densityChanged = density !== this.lastDensity;
    this.lastDensity = density;
    ROCK_LEVELS.forEach((L, li) => {
      const reach = L.cell * (L.range + 1);
      const near = this.belts.filter((b) => density > 0 && rr > b.inner - reach && rr < b.outer + reach && Math.abs(cw.y) < b.halfThickness * 4 + reach);
      const cx = Math.floor(cw.x / L.cell);
      const cy = Math.floor(cw.y / L.cell);
      const cz = Math.floor(cw.z / L.cell);
      const key = `${cx},${cy},${cz},${near.length}`;
      const list = this.lists[li]!;
      if (key !== this.lastCell[li] || densityChanged) {
        this.lastCell[li] = key;
        list.length = 0;
        const pool = this.pool[li]!;
        const beltFor = this.beltOf[li]!;
        beltFor.length = 0;
        for (const b of near) {
          for (let ix = cx - L.range; ix <= cx + L.range; ix++) {
            for (let iy = cy - L.range; iy <= cy + L.range; iy++) {
              for (let iz = cz - L.range; iz <= cz + L.range; iz++) {
                if (list.length >= pool.length) break;
                const rock = pool[list.length]!;
                if (rockInCell(b, li, ix, iy, iz, density, rock)) {
                  list.push(rock);
                  beltFor.push(b);
                }
              }
            }
          }
        }
        const mesh = this.meshes[li]!;
        for (let i = 0; i < list.length; i++) {
          const c = beltFor[i]!.def.color;
          mesh.setColorAt(i, this.tmpColor.setRGB(c[0] * list[i]!.tone, c[1] * list[i]!.tone, c[2] * list[i]!.tone));
        }
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      const mesh = this.meshes[li]!;
      const maxD = L.cell * L.range;
      let n = 0;
      for (const rock of list) {
        const dx = rock.x - cw.x;
        const dy = rock.y - cw.y;
        const dz = rock.z - cw.z;
        const d = Math.hypot(dx, dy, dz);
        const fade = 1 - smooth(0.62, 1.0, d / maxD);
        if (fade <= 0.01) continue;
        const ang = rock.phase + rock.spin * ctx.realTime;
        this.axis.set(rock.ax, rock.ay, rock.az);
        this.q.setFromAxisAngle(this.axis, ang);
        const k = rock.size * fade;
        this.s.set(k * rock.sx, k * rock.sy, k * rock.sz);
        this.pos.set(dx, dy, dz);
        this.m.compose(this.pos, this.q, this.s);
        mesh.setMatrixAt(n++, this.m);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    });
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function newRock(): Rock {
  return { x: 0, y: 0, z: 0, size: 1, sx: 1, sy: 1, sz: 1, ax: 0, ay: 1, az: 0, spin: 0, phase: 0, tone: 1 };
}

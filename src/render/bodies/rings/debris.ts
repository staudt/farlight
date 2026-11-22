import { Color, IcosahedronGeometry, InstancedBufferGeometry, Mesh, ShaderMaterial, Vector2, Vector3 } from 'three';
import type { BufferGeometry, Object3D, Uniform } from 'three';
import { config } from '../../../core/config';
import { quality } from '../../quality';
import { starLight } from '../../starLight';
import { ECLIPSE_GLSL, eclipse } from '../../eclipse';
import { RING_GLSL } from './glsl';
import { DEBRIS_CLASSES, debrisGrid, debrisRange } from './profile';
import type { DebrisClass } from './profile';

type U<T> = { value: T };

/** What the rocks share with the ring disc (same objects, so one update feeds both). */
export interface DebrisShared {
  uniforms: Record<string, U<number> | U<Vector3[]>>;
  color: Color;
  sunLocal: U<Vector3>;
  camLocal: U<Vector3>;
  sunView: U<Vector3>;
  eclSelf: U<number>;
}

/** Flat shaded low poly rock (an icosahedron, 20 faces), shared by every class. */
let rockGeo: BufferGeometry | null = null;
function rockGeometry(): BufferGeometry {
  if (!rockGeo) {
    const g = new IcosahedronGeometry(1, 0);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    rockGeo = g;
  }
  return rockGeo;
}

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
${RING_GLSL}
uniform float uCell, uGrid, uLayers, uRange, uMinSize, uMaxSize, uFill, uThick, uDensity, uSizeScale, uPlanetR, uClass;
uniform vec2 uOrigin;
uniform vec3 uCamRel;
varying vec3 vViewPos;
varying vec3 vP;
varying float vTint;
varying float vLive;

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
mat3 rotAxis(vec3 ax, float a) {
  float c = cos(a), s = sin(a);
  return mat3(
    c + ax.x * ax.x * (1.0 - c), ax.y * ax.x * (1.0 - c) + ax.z * s, ax.z * ax.x * (1.0 - c) - ax.y * s,
    ax.x * ax.y * (1.0 - c) - ax.z * s, c + ax.y * ax.y * (1.0 - c), ax.z * ax.y * (1.0 - c) + ax.x * s,
    ax.x * ax.z * (1.0 - c) + ax.y * s, ax.y * ax.z * (1.0 - c) - ax.x * s, c + ax.z * ax.z * (1.0 - c));
}

void main() {
  float id = float(gl_InstanceID);
  float perLayer = uGrid * uGrid;
  float layer = floor(id / perLayer);
  float within = id - layer * perLayer;
  float iz = floor(within / uGrid);
  float ix = within - iz * uGrid;
  vec2 cid = uOrigin + vec2(ix, iz);
  vec2 cm = mod(cid, 4096.0);
  vec3 h = hash33(vec3(cm, layer + uClass * 7.0 + 1.0));
  vec3 h2 = hash33(h * 91.7 + vec3(cm.yx, layer));

  // Ring density at the cell centre (body-fixed radii), the footprint is the cell itself.
  vec2 pw = (cid + 0.5) * uCell / uPlanetR;
  float fw = uCell / (uPlanetR * (uRingOut - uRingIn));
  float dens = ringDensityLod(length(pw), fw) * uRingOpacity;
  float live = step(h.x, clamp(dens * uFill * uDensity, 0.0, 1.0));

  vec3 center = vec3((ix + 0.15 + 0.7 * h.y) * uCell, (h.z + h2.x - 1.0) * uThick * 0.5, (iz + 0.15 + 0.7 * h2.y) * uCell);
  float d = length(center - uCamRel);
  float fade = 1.0 - smoothstep(0.7 * uRange, uRange, d);
  float size = mix(uMinSize, uMaxSize, h2.z * h2.z) * uSizeScale * fade * live;
  vLive = live * fade;

  // Lumpy rock: a squashed axis and a hash wobble per vertex.
  vec3 v = position;
  vec3 wob = hash33(floor(v * 7.0) + h * 13.0);
  v *= 1.0 + 0.28 * (wob - 0.5);
  v *= vec3(1.0, 0.65 + 0.35 * h2.x, 0.75 + 0.45 * h.y);
  vec3 ax = normalize(h2 * 2.0 - 1.0 + 1e-3);
  v = rotAxis(ax, h.z * 6.2831853) * v;
  vec3 local = center + v * size;

  vec4 mv = modelViewMatrix * vec4(local, 1.0);
  vViewPos = mv.xyz;
  vP = vec3(uOrigin.x * uCell + local.x, local.y, uOrigin.y * uCell + local.z) / uPlanetR;
  vTint = h2.z;
  gl_Position = live * fade > 0.001 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor, uSunLocal, uSunView, uStarColor;
uniform float uEclSelf, uBrightness, uAmbient;
${ECLIPSE_GLSL}
varying vec3 vViewPos;
varying vec3 vP;
varying float vTint;
varying float vLive;
void main() {
  if (vLive < 0.001) discard;
  #include <logdepthbuf_fragment>
  vec3 N = normalize(cross(dFdx(vViewPos), dFdy(vViewPos)));
  if (dot(N, vViewPos) > 0.0) N = -N;
  float ndl = max(dot(N, uSunView), 0.0);
  // Planet shadow: ray from this point toward the sun against the unit sphere.
  float b = dot(vP, uSunLocal);
  float dist2 = dot(vP, vP) - b * b;
  float shadow = b < 0.0 ? 1.0 - smoothstep(0.93, 1.03, sqrt(max(dist2, 0.0))) : 0.0;
  vec3 ice = mix(uColor, vec3(0.8, 0.84, 0.9), 0.35);
  vec3 base = ice * mix(vec3(0.95, 0.8, 0.65), vec3(0.9, 1.0, 1.1), vTint) * (0.3 + 0.5 * vTint * vTint) * uBrightness;
  vec3 light = uStarColor * eclipseLight(vViewPos * mat3(viewMatrix), uEclSelf) * (1.0 - 0.97 * shadow);
  vec3 col = base * (ndl * 2.3 * light + uAmbient);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const _p = new Vector3();

/** One size class: a grid of cells around the camera, each holding at most one rock, drawn instanced. */
class DebrisLayer {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly geo: InstancedBufferGeometry;
  private readonly u: Record<string, Uniform | U<unknown>>;

  constructor(
    private readonly cls: DebrisClass,
    private readonly index: number,
    private readonly shared: DebrisShared,
    private readonly parent: Object3D,
  ) {
    const base = rockGeometry();
    this.geo = new InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    this.geo.instanceCount = 0;
    this.u = {
      ...shared.uniforms,
      uColor: { value: shared.color },
      uSunLocal: shared.sunLocal,
      uSunView: shared.sunView,
      uStarColor: starLight.uniform,
      ...eclipse.uniforms,
      uEclSelf: shared.eclSelf,
      uCell: { value: cls.cell },
      uGrid: { value: 1 },
      uLayers: { value: 1 },
      uRange: { value: 1 },
      uMinSize: { value: cls.minSize },
      uMaxSize: { value: cls.maxSize },
      uFill: { value: cls.fill },
      uThick: { value: 300 },
      uDensity: { value: 1 },
      uSizeScale: { value: 1 },
      uPlanetR: { value: 1 },
      uClass: { value: index },
      uOrigin: { value: new Vector2() },
      uCamRel: { value: new Vector3() },
      uBrightness: { value: 1 },
      uAmbient: { value: 0.06 },
    };
    this.material = new ShaderMaterial({ uniforms: this.u as never, vertexShader: VERT, fragmentShader: FRAG });
    this.mesh = new Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = `ring-rocks-${index}`;
    this.mesh.onBeforeRender = () => this.update();
    parent.add(this.mesh);
  }

  private update(): void {
    const rc = config.rings;
    const parent = this.parent;
    const S = parent.matrixWorld.getMaxScaleOnAxis();
    const cell = this.cls.cell;
    // Camera in body-fixed metres.
    const c = _p.copy(this.shared.camLocal.value).multiplyScalar(S);
    const g = rc.debris ? debrisGrid(quality.settings.ringDebris, this.index) : 0;
    if (g <= 0 || Math.abs(c.y) > rc.thickness * rc.fadeHeight) {
      this.geo.instanceCount = 0;
      return;
    }
    const ox = Math.floor(c.x / cell) - Math.floor(g / 2);
    const oz = Math.floor(c.z / cell) - Math.floor(g / 2);
    const layers = this.cls.layers;
    this.geo.instanceCount = g * g * layers;
    const u = this.u;
    (u.uGrid as U<number>).value = g;
    (u.uLayers as U<number>).value = layers;
    (u.uRange as U<number>).value = Math.max(10, debrisRange(g, cell, rc.range));
    (u.uThick as U<number>).value = rc.thickness;
    (u.uDensity as U<number>).value = rc.density;
    (u.uSizeScale as U<number>).value = rc.sizeScale;
    (u.uPlanetR as U<number>).value = S;
    (u.uBrightness as U<number>).value = rc.rockBrightness;
    (u.uAmbient as U<number>).value = rc.rockAmbient;
    (u.uOrigin as U<Vector2>).value.set(ox, oz);
    (u.uCamRel as U<Vector3>).value.set(c.x - ox * cell, c.y, c.z - oz * cell);
    // Place at the grid origin: parent units are planet radii, children here are metres.
    const m = this.mesh;
    m.position.set((ox * cell) / S, 0, (oz * cell) / S);
    m.scale.setScalar(1 / S);
    m.updateMatrix();
    m.matrixWorld.multiplyMatrices(parent.matrixWorld, m.matrix);
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}

/** Instanced ring rocks around the camera near the ring plane. Children of the ring mesh (unit radius frame). */
export class RingDebris {
  private readonly layers: DebrisLayer[];

  constructor(shared: DebrisShared, parent: Object3D) {
    this.layers = DEBRIS_CLASSES.map((c, i) => new DebrisLayer(c, i, shared, parent));
  }

  dispose(): void {
    for (const l of this.layers) {
      l.mesh.removeFromParent();
      l.dispose();
    }
  }
}

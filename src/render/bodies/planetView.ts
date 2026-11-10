import { BufferAttribute, BufferGeometry, ClampToEdgeWrapping, DataTexture, Group, type InstancedMesh, LinearFilter, Mesh, Quaternion, RedFormat, RepeatWrapping, Sphere, UnsignedByteType, Vector3, type ShaderMaterial } from 'three';
import { getMap } from '../../terrain/maps';
import type { Body } from '../../sim/universe';
import type { ChunkRequest, ChunkResult } from '../../terrain/chunkBuild';
import {
  CHUNK_GRID,
  FACE_COUNT,
  chunkEdgeLength,
  chunkRect,
  distanceToSphere,
  faceToDir,
  isBeyondHorizon,
  maxLevelFor,
  shouldMerge,
  shouldSplit,
  SPLIT_FACTOR,
} from '../../terrain/quadtree';
import { type ChunkWorkerPool, getWorkerPool } from '../../terrain/workerPool';
import { type BodyView, type FrameContext, apparentSizeBoost, placeRelative } from '../context';
import { PROP_GRID_EXTRA } from '../../terrain/props';
import { config } from '../../core/config';
import { createPropMaterial, createPropMeshes, disposePropMeshes } from './props';
import { quality } from '../quality';
import { createTerrainMaterial } from './terrainMaterial';
import { type WaterLook, type WaveUniforms, updateWaveUniforms, waterLook } from './waterWaves';
import { RingMesh, makeRingUniforms } from './ringView';

const enum State {
  Idle,
  Queued,
  Building,
  Ready,
}

class ChunkNode {
  state = State.Idle;
  disposed = false;
  children: ChunkNode[] | null = null;
  mesh: Mesh | null = null;
  props: InstancedMesh[] = [];
  readonly center = new Vector3();
  readonly estCenter = new Vector3();
  readonly dir = new Vector3();
  boundR = 0;
  sortKey = 0;
  minR = 0;
  maxR = 0;
  readonly edge: number;

  constructor(
    readonly parent: ChunkNode | null,
    readonly face: number,
    readonly level: number,
    readonly x: number,
    readonly y: number,
    radius: number,
  ) {
    this.edge = chunkEdgeLength(radius, level);
    const [u0, v0, size] = chunkRect(level, x, y);
    const d = { x: 0, y: 0, z: 0 };
    faceToDir(face, u0 + size / 2, v0 + size / 2, d);
    this.dir.set(d.x, d.y, d.z);
    this.estCenter.copy(this.dir).multiplyScalar(radius);
  }
}

/** onUpload callback: drops the CPU array of an attribute after its GPU upload. */
function releaseArray(this: BufferAttribute): void {
  (this as unknown as { array: null }).array = null;
}

const _q = new Quaternion();
const _cam = new Vector3();
const _camDir = new Vector3();
const _v = new Vector3();
const _sunW = new Vector3();
const _sunL = new Vector3();

/** Cube sphere quadtree chunked LOD planet. The root level doubles as the far view. */
export class PlanetView implements BodyView {
  readonly body: Body;
  readonly object = new Group();
  private readonly material: ShaderMaterial;
  private readonly waterLook: WaterLook;
  private readonly propMaterial: ShaderMaterial;
  private lightsTexture: DataTexture | null = null;
  private readonly glowMaterials = new Map<number, ShaderMaterial>();
  private readonly hasProps: boolean;
  private readonly pool: ChunkWorkerPool;
  private readonly roots: ChunkNode[] = [];
  private readonly maxLevel: number;
  /** Live chunk nodes (queued, building or ready), checked against the quality budget. */
  private live = 0;
  private readonly dispatchList: ChunkNode[] = [];
  private readonly splitWish: { n: ChunkNode; err: number }[] = [];
  private readonly queued = new Set<ChunkNode>();
  private readonly requests = new Map<number, ChunkNode>();
  private inFlight = 0;
  private nextId = 1;
  private visibleNow = new Set<ChunkNode>();
  private visiblePrev = new Set<ChunkNode>();
  private readonly minHorizonR: number;
  /** Rocky planets can carry rings too (same renderer as the gas giants, no ring shadow on the ground). */
  private readonly rings: RingMesh | null;

  constructor(body: Body) {
    this.body = body;
    this.object.name = `planet:${body.id}`;
    this.material = createTerrainMaterial(body.def);
    this.waterLook = waterLook(body.def);
    this.setupLights();
    this.propMaterial = createPropMaterial(this.material.uniforms);
    this.hasProps = (body.def.terrain?.props?.length ?? 0) > 0;
    this.pool = getWorkerPool();
    this.maxLevel = maxLevelFor(body.radius, 400);
    this.minHorizonR = body.radius - body.terrainAmplitude * 1.6;
    this.rings = body.def.rings ? new RingMesh(body.def.rings, makeRingUniforms(body.def.rings, body.def.seed)) : null;
    if (this.rings) {
      // The ring mesh is built at unit planet radius; the group scale (apparent size boost) is applied on top.
      this.rings.mesh.scale.setScalar(body.radius);
      this.object.add(this.rings.mesh);
    }
    for (let f = 0; f < FACE_COUNT; f++) {
      const n = new ChunkNode(null, f, 0, 0, 0, body.radius);
      this.live++;
      this.roots.push(n);
      this.enqueue(n);
    }
  }

  /** Uploads the settlement lights map (when the def has one) for the shader's coarse chunk lights. */
  private setupLights(): void {
    const t = this.body.def.terrain;
    const map = getMap(t?.maps?.lights);
    if (!t?.nightLights || !map) return;
    // The map view may sit inside a larger buffer: copy the pixels out.
    const tex = new DataTexture(new Uint8Array(map.data), map.w, map.h, RedFormat, UnsignedByteType);
    tex.wrapS = RepeatWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearFilter;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    this.lightsTexture = tex;
    const u = this.material.uniforms;
    u.uLights!.value = tex;
    // Mean brightness of a facet sparkle field (probability times brightness) keeps the two paths even.
    const nl = t.nightLights;
    (u.uLampColor!.value as Vector3).set(nl.color[0], nl.color[1], nl.color[2]).multiplyScalar(nl.intensity * (nl.density ?? 1) * 0.3);
  }

  /** Prop material for a glow weight; glowing batches get their own material sharing the uniforms. */
  private propMaterialFor(glow: number): ShaderMaterial {
    if (glow <= 0) return this.propMaterial;
    let m = this.glowMaterials.get(glow);
    if (!m) {
      m = createPropMaterial(this.material.uniforms, glow);
      this.glowMaterials.set(glow, m);
    }
    return m;
  }

  /** Chunks queued or being built. */
  get pending(): number {
    return this.queued.size + this.inFlight;
  }

  private enqueue(n: ChunkNode): void {
    n.state = State.Queued;
    this.queued.add(n);
  }

  private dispatch(cam: Vector3): void {
    const maxInFlight = quality.settings.maxInFlight || Math.max(6, this.pool.size * 4);
    if (this.inFlight >= maxInFlight || this.queued.size === 0) return;
    const list = this.dispatchList;
    list.length = 0;
    for (const n of this.queued) {
      n.sortKey = n.estCenter.distanceToSquared(cam);
      list.push(n);
    }
    list.sort((a, b) => a.sortKey - b.sortKey);
    for (const n of list) {
      if (this.inFlight >= maxInFlight) break;
      this.queued.delete(n);
      n.state = State.Building;
      this.inFlight++;
      const id = this.nextId++;
      this.requests.set(id, n);
      const req: ChunkRequest = {
        id,
        bodyId: this.body.id,
        def: this.body.def,
        radius: this.body.radius,
        face: n.face,
        level: n.level,
        x: n.x,
        y: n.y,
        grid: CHUNK_GRID,
        // Props only on the two finest levels: they matter within a few km.
        props: this.hasProps ? { minLevel: Math.max(0, this.maxLevel + 1 - quality.settings.propLevels), gridLevel: this.maxLevel + PROP_GRID_EXTRA } : undefined,
      };
      this.pool.request(req, (r) => this.onResult(r));
    }
  }

  private onResult(r: ChunkResult): void {
    const n = this.requests.get(r.id);
    this.requests.delete(r.id);
    this.inFlight--;
    if (!n || n.disposed) return;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(r.positions, 3));
    g.setAttribute('aColor', new BufferAttribute(r.colors, 3));
    g.setAttribute('aWater', new BufferAttribute(r.water, 3));
    if (r.emit) g.setAttribute('aEmit', new BufferAttribute(r.emit, 4));
    if (r.dir) g.setAttribute('aDir', new BufferAttribute(r.dir, 4));
    g.boundingSphere = new Sphere(new Vector3(0, 0, 0), r.boundRadius);
    // The CPU copy is dead weight once uploaded: free it (a few KB per chunk, thousands of chunks).
    for (const a of Object.values(g.attributes)) (a as BufferAttribute).onUpload(releaseArray);
    const mesh = new Mesh(g, this.material);
    mesh.position.set(r.center[0], r.center[1], r.center[2]);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    n.center.set(r.center[0], r.center[1], r.center[2]);
    n.boundR = r.boundRadius;
    n.minR = r.minR;
    n.maxR = r.maxR;
    n.mesh = mesh;
    n.state = State.Ready;
    if (r.props.length > 0) {
      n.props = createPropMeshes(r.props, (b) => this.propMaterialFor(b.glow));
      for (const p of n.props) mesh.add(p);
    }
  }

  private disposeNode(n: ChunkNode): void {
    n.disposed = true;
    this.live--;
    this.queued.delete(n);
    if (n.mesh) {
      disposePropMeshes(n.props);
      n.props = [];
      this.object.remove(n.mesh);
      n.mesh.geometry.dispose();
      n.mesh = null;
    }
    this.visibleNow.delete(n);
    this.visiblePrev.delete(n);
    if (n.children) this.disposeChildren(n);
  }

  private disposeChildren(n: ChunkNode): void {
    if (!n.children) return;
    for (const c of n.children) this.disposeNode(c);
    n.children = null;
  }

  private split(n: ChunkNode): void {
    const R = this.body.radius;
    n.children = [];
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const c = new ChunkNode(n, n.face, n.level + 1, n.x * 2 + i, n.y * 2 + j, R);
        n.children.push(c);
        this.live++;
        this.enqueue(c);
      }
    }
  }

  update(ctx: FrameContext): void {
    const b = this.body;
    const R = b.radius;
    placeRelative(this.object, b.position, ctx.cameraWorld);
    this.object.quaternion.copy(b.rotation);
    const camDist = b.position.distanceTo(ctx.cameraWorld);
    const boost = apparentSizeBoost(R, camDist, b.minApparentSize);
    this.object.scale.setScalar(boost);

    // Camera in body fixed coordinates (float64).
    _cam.copy(ctx.cameraWorld).sub(b.position).applyQuaternion(_q.copy(b.rotation).invert());
    const camLen = _cam.length();
    _camDir.copy(_cam).divideScalar(camLen || 1);
    const cull = boost < 1.0001;

    // Uniforms.
    const u = this.material.uniforms;
    ctx.camera.updateMatrixWorld();
    const sunView = u.uSunDirView!.value as Vector3;
    sunView.copy(ctx.world.universe.root.position).sub(b.position).normalize().transformDirection(ctx.camera.matrixWorldInverse);
    (u.uBodyCenterView!.value as Vector3).copy(b.position).sub(ctx.cameraWorld).applyMatrix4(ctx.camera.matrixWorldInverse);
    u.uTime!.value = ctx.realTime;
    updateWaveUniforms(u as unknown as WaveUniforms, this.waterLook, ctx, b.rotation, _cam);
    u.uGlow!.value = config.props.nightGlow;
    u.uNightAmb!.value = config.props.nightAmbient;
    const pc = config.props;
    for (const m of [this.propMaterial, ...this.glowMaterials.values()]) {
      const pu = m.uniforms;
      const range = quality.settings.propRange;
      pu.uFadeNear!.value = pc.enabled ? pc.fadeNear * range : 0;
      pu.uFadeFar!.value = pc.enabled ? Math.max(pc.fadeFar * range, pc.fadeNear * range + 1) : 1e-3;
      pu.uEmissive!.value = pc.emissive;
      pu.uNightGlow!.value = pc.nightGlow;
    }

    if (this.rings) {
      _sunW.copy(ctx.world.universe.root.position).sub(b.position).normalize();
      _sunL.copy(_sunW).applyQuaternion(_q);
      this.rings.sunLocal.value.copy(_sunL);
      this.rings.camLocal.value.copy(_cam).divideScalar(R);
      this.rings.sunView.value.copy(sunView);
    }

    this.visibleNow.clear();
    this.splitWish.length = 0;
    for (const root of this.roots) this.traverse(root, _cam, camLen, cull);
    this.grantSplits();

    // Hidden chunks leave the scene graph: no matrix walk or traversal for the thousands that are not drawn.
    for (const n of this.visiblePrev) if (!this.visibleNow.has(n) && n.mesh) this.object.remove(n.mesh);
    for (const n of this.visibleNow) if (n.mesh && n.mesh.parent !== this.object) this.object.add(n.mesh);
    const t = this.visiblePrev;
    this.visiblePrev = this.visibleNow;
    this.visibleNow = t;

    this.dispatch(_cam);
  }

  /** Splits wanted this frame, granted by screen space error (edge over distance) while the budget lasts. */
  private grantSplits(): void {
    const w = this.splitWish;
    if (w.length === 0) return;
    const cap = quality.settings.maxChunks;
    if (this.live + 4 <= cap && this.live + 4 * w.length <= cap) {
      for (const s of w) this.split(s.n);
      return;
    }
    w.sort((a, b) => b.err - a.err);
    for (const s of w) {
      if (this.live + 4 > cap) break;
      this.split(s.n);
    }
  }

  private traverse(n: ChunkNode, cam: Vector3, camLen: number, cull: boolean): void {
    if (n.state !== State.Ready) return;
    const dist = distanceToSphere(cam.x, cam.y, cam.z, n.center.x, n.center.y, n.center.z, n.boundR);
    if (n.children) {
      // Over budget: merge a little earlier so detail follows the camera.
      const mf = this.live >= quality.settings.maxChunks ? 0.85 : 1;
      if (shouldMerge(dist, n.edge, SPLIT_FACTOR * quality.settings.splitFactor * mf)) {
        this.disposeChildren(n);
      } else if (n.children.every((c) => c.state === State.Ready)) {
        for (const c of n.children) this.traverse(c, cam, camLen, cull);
        return;
      }
    } else if (shouldSplit(dist, n.edge, n.level, this.maxLevel, SPLIT_FACTOR * quality.settings.splitFactor)) {
      this.splitWish.push({ n, err: n.edge / Math.max(dist, 1) });
    }
    // Show this node (children, if any, are still building).
    if (cull) {
      _v.copy(n.center).normalize();
      const angR = n.boundR / this.body.radius;
      if (isBeyondHorizon(_camDir, camLen, _v, angR, this.minHorizonR, n.maxR)) return;
    }
    this.visibleNow.add(n);
  }

  dispose(): void {
    for (const r of this.roots) this.disposeNode(r);
    this.material.dispose();
    this.propMaterial.dispose();
    for (const m of this.glowMaterials.values()) m.dispose();
    this.lightsTexture?.dispose();
    this.rings?.dispose();
  }
}

let views: PlanetView[] = [];

export function createPlanetViewFor(body: Body): PlanetView {
  const v = new PlanetView(body);
  views.push(v);
  return v;
}

export function totalPending(): number {
  views = views.filter((v) => v.object.parent !== undefined);
  let n = 0;
  for (const v of views) n += v.pending;
  return n;
}

import { BufferAttribute, BufferGeometry, Group, Mesh, Quaternion, Sphere, Vector3, type ShaderMaterial } from 'three';
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
import { quality } from '../quality';
import { createTerrainMaterial } from './terrainMaterial';

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
  readonly center = new Vector3();
  readonly estCenter = new Vector3();
  readonly dir = new Vector3();
  boundR = 0;
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

const _q = new Quaternion();
const _cam = new Vector3();
const _camDir = new Vector3();
const _v = new Vector3();

/** Cube sphere quadtree chunked LOD planet. The root level doubles as the far view. */
export class PlanetView implements BodyView {
  readonly body: Body;
  readonly object = new Group();
  private readonly material: ShaderMaterial;
  private readonly pool: ChunkWorkerPool;
  private readonly roots: ChunkNode[] = [];
  private readonly maxLevel: number;
  private readonly maxInFlight: number;
  private readonly queued = new Set<ChunkNode>();
  private readonly requests = new Map<number, ChunkNode>();
  private inFlight = 0;
  private nextId = 1;
  private visibleNow = new Set<ChunkNode>();
  private visiblePrev = new Set<ChunkNode>();
  private readonly minHorizonR: number;

  constructor(body: Body) {
    this.body = body;
    this.object.name = `planet:${body.id}`;
    this.material = createTerrainMaterial();
    this.pool = getWorkerPool();
    this.maxInFlight = Math.max(6, this.pool.size * 4);
    this.maxLevel = maxLevelFor(body.radius, 400);
    this.minHorizonR = body.radius - body.terrainAmplitude * 1.6;
    for (let f = 0; f < FACE_COUNT; f++) {
      const n = new ChunkNode(null, f, 0, 0, 0, body.radius);
      this.roots.push(n);
      this.enqueue(n);
    }
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
    if (this.inFlight >= this.maxInFlight || this.queued.size === 0) return;
    const list = [...this.queued];
    const dist = new Map<ChunkNode, number>();
    for (const n of list) dist.set(n, n.estCenter.distanceToSquared(cam));
    list.sort((a, b) => dist.get(a)! - dist.get(b)!);
    for (const n of list) {
      if (this.inFlight >= this.maxInFlight) break;
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
    g.setAttribute('aWater', new BufferAttribute(r.water, 2));
    g.boundingSphere = new Sphere(new Vector3(0, 0, 0), r.boundRadius);
    const mesh = new Mesh(g, this.material);
    mesh.position.set(r.center[0], r.center[1], r.center[2]);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.visible = false;
    n.center.set(r.center[0], r.center[1], r.center[2]);
    n.boundR = r.boundRadius;
    n.minR = r.minR;
    n.maxR = r.maxR;
    n.mesh = mesh;
    n.state = State.Ready;
    this.object.add(mesh);
  }

  private disposeNode(n: ChunkNode): void {
    n.disposed = true;
    this.queued.delete(n);
    if (n.mesh) {
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

    this.visibleNow.clear();
    for (const root of this.roots) this.traverse(root, _cam, camLen, cull);

    for (const n of this.visiblePrev) if (!this.visibleNow.has(n) && n.mesh) n.mesh.visible = false;
    for (const n of this.visibleNow) if (n.mesh) n.mesh.visible = true;
    const t = this.visiblePrev;
    this.visiblePrev = this.visibleNow;
    this.visibleNow = t;

    this.dispatch(_cam);
  }

  private traverse(n: ChunkNode, cam: Vector3, camLen: number, cull: boolean): void {
    if (n.state !== State.Ready) return;
    const dist = distanceToSphere(cam.x, cam.y, cam.z, n.center.x, n.center.y, n.center.z, n.boundR);
    if (n.children) {
      if (shouldMerge(dist, n.edge, SPLIT_FACTOR * quality.settings.splitFactor)) {
        this.disposeChildren(n);
      } else if (n.children.every((c) => c.state === State.Ready)) {
        for (const c of n.children) this.traverse(c, cam, camLen, cull);
        return;
      }
    } else if (shouldSplit(dist, n.edge, n.level, this.maxLevel, SPLIT_FACTOR * quality.settings.splitFactor)) {
      this.split(n);
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

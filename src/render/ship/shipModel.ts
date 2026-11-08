import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  DoubleSide,
  MeshStandardMaterial,
  Vector3,
} from 'three';

/**
 * Low poly delta wing glider built in code. Forward is -Z, up +Y, right +X, about 20 m long
 * and 22 m wide. Flat shaded, vertex colored.
 */
export interface ShipModel {
  group: Group;
  /** Nozzle exit centers in ship space. */
  nozzles: Vector3[];
  nozzleRadius: number;
  navLeft: Mesh;
  navRight: Mesh;
  strobe: Mesh;
  /** Wingtip points in ship space (right, left), for contrails. */
  wingTips: [Vector3, Vector3];
}

type V = [number, number, number];
type Col = [number, number, number];

class Builder {
  pos: number[] = [];
  col: number[] = [];

  /** Adds a closed solid from triangles, flipping each so it faces away from `center`. */
  solid(tris: [V, V, V][], center: V, color: Col, underside = 0.72): void {
    const c = new Vector3(...center);
    const a = new Vector3();
    const b = new Vector3();
    const n = new Vector3();
    const m = new Vector3();
    for (const [p, q, r] of tris) {
      a.set(...q).sub(m.set(...p));
      b.set(...r).sub(m.set(...p));
      n.crossVectors(a, b);
      m.set((p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3, (p[2] + q[2] + r[2]) / 3).sub(c);
      const flip = n.dot(m) < 0;
      const tri = flip ? [p, r, q] : [p, q, r];
      const nl = n.length() || 1;
      const ny = (flip ? -n.y : n.y) / nl;
      const k = ny < -0.35 ? underside : 1;
      for (const v of tri) {
        this.pos.push(v[0], v[1], v[2]);
        this.col.push(color[0] * k, color[1] * k, color[2] * k);
      }
    }
  }

  /** Adds triangles forced to face up (or down), for thin wing slabs. */
  oriented(tris: [V, V, V][], up: boolean, color: Col, k = 1): void {
    const a = new Vector3();
    const b = new Vector3();
    for (const [p, q, r] of tris) {
      a.set(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      b.set(r[0] - p[0], r[1] - p[1], r[2] - p[2]);
      const flip = a.cross(b).y >= 0 !== up;
      for (const v of flip ? [p, r, q] : [p, q, r]) {
        this.pos.push(v[0], v[1], v[2]);
        this.col.push(color[0] * k, color[1] * k, color[2] * k);
      }
    }
  }

  /** Triangle facing +Y (stripes). */
  upTri(p: V, q: V, r: V, color: Col): void {
    const a = new Vector3(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    const b = new Vector3(r[0] - p[0], r[1] - p[1], r[2] - p[2]);
    const up = a.cross(b).y >= 0;
    for (const v of up ? [p, q, r] : [p, r, q]) {
      this.pos.push(v[0], v[1], v[2]);
      this.col.push(...color);
    }
  }

  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals(); // non indexed, so faces are flat
    return g;
  }
}

/** Triangles for a loft through rings. A ring of length 1 is an apex. Ends are capped. */
function loft(rings: V[][]): [V, V, V][] {
  const t: [V, V, V][] = [];
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i]!;
    const b = rings[i + 1]!;
    if (a.length === 1) {
      for (let j = 0; j < b.length; j++) t.push([a[0]!, b[j]!, b[(j + 1) % b.length]!]);
    } else if (b.length === 1) {
      for (let j = 0; j < a.length; j++) t.push([a[j]!, b[0]!, a[(j + 1) % a.length]!]);
    } else {
      const n = a.length;
      for (let j = 0; j < n; j++) {
        const j2 = (j + 1) % n;
        t.push([a[j]!, b[j]!, b[j2]!], [a[j]!, b[j2]!, a[j2]!]);
      }
    }
  }
  for (const ring of [rings[0]!, rings[rings.length - 1]!]) {
    if (ring.length < 3) continue;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of ring) {
      cx += p[0];
      cy += p[1];
      cz += p[2];
    }
    const c: V = [cx / ring.length, cy / ring.length, cz / ring.length];
    for (let j = 0; j < ring.length; j++) t.push([c, ring[j]!, ring[(j + 1) % ring.length]!]);
  }
  return t;
}

/** Six point hull cross section: top, upper right, lower right, bottom, lower left, upper left. */
function hullRing(z: number, w: number, top: number, bot: number, yc = 0): V[] {
  return [
    [0, yc + top, z],
    [w, yc + top * 0.35, z],
    [w * 0.8, yc - bot * 0.6, z],
    [0, yc - bot, z],
    [-w * 0.8, yc - bot * 0.6, z],
    [-w, yc + top * 0.35, z],
  ];
}

function canopyRing(z: number, w: number, yTop: number, yBase: number): V[] {
  const mid = yBase + (yTop - yBase) * 0.55;
  return [
    [0, yTop, z],
    [w, mid, z],
    [w * 0.95, yBase, z],
    [0, yBase - 0.25, z],
    [-w * 0.95, yBase, z],
    [-w, mid, z],
  ];
}

function podRing(cx: number, cy: number, z: number, r: number, n = 8): V[] {
  const out: V[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, z]);
  }
  return out;
}

const WHITE: Col = [0.92, 0.93, 0.95];
const GREY: Col = [0.62, 0.65, 0.7];
const DARK: Col = [0.13, 0.14, 0.17];
const RED: Col = [0.78, 0.08, 0.07];
const CANOPY: Col = [0.06, 0.1, 0.17];

const TIP_X = 11;
const TIP_Y = -1.1;
const TIP_Z = 8;

export function buildShipModel(): ShipModel {
  const hull = new Builder();
  const glass = new Builder();

  // Fuselage.
  hull.solid(
    loft([
      [[0, -0.1, -10]],
      hullRing(-7, 0.55, 0.45, 0.35, -0.1),
      hullRing(-2, 1.3, 0.9, 0.6),
      hullRing(4, 1.7, 1.0, 0.7, 0.05),
      hullRing(9.2, 1.2, 0.75, 0.6),
    ]),
    [0, 0, 0],
    WHITE,
  );

  // Canopy.
  glass.solid(
    loft([
      [[0, 0.5, -6.3]],
      canopyRing(-4.5, 0.55, 1.2, 0.5),
      canopyRing(-2.5, 0.7, 1.55, 0.7),
      canopyRing(0.5, 0.65, 1.5, 0.85),
      [[0, 1.0, 3.8]],
    ]),
    [0, 0.8, -1],
    CANOPY,
    1,
  );

  for (const s of [1, -1]) {
    // Wing planform: A front root, C tip, D trailing notch, B rear root.
    const A: V = [s * 1.0, -0.05, -3.5];
    const C: V = [s * TIP_X, TIP_Y, TIP_Z];
    const D: V = [s * 6.2, -0.5, 6.9];
    const B: V = [s * 1.0, -0.05, 8.8];
    const up = (p: V, h: number): V => [p[0], p[1] + h, p[2]];
    const top = [up(A, 0.25), up(C, 0.06), up(D, 0.14), up(B, 0.3)];
    const bot = [up(A, -0.12), up(C, -0.06), up(D, -0.08), up(B, -0.14)];
    hull.oriented([[top[0]!, top[1]!, top[2]!], [top[0]!, top[2]!, top[3]!]], true, WHITE);
    hull.oriented([[bot[0]!, bot[1]!, bot[2]!], [bot[0]!, bot[2]!, bot[3]!]], false, WHITE, 0.8);
    const edge: [V, V, V][] = [];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      edge.push([top[i]!, top[j]!, bot[j]!], [top[i]!, bot[j]!, bot[i]!]);
    }
    hull.solid(edge, [s * 5.5, -0.9, 3.3], WHITE, 0.8);

    // Red stripes on the upper surface, parallel to the leading edge.
    const at = (u: number, v: number): V => {
      const p: V = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        p[k] = top[0]![k]! + u * (top[1]![k]! - top[0]![k]!) + v * (top[3]![k]! - top[0]![k]!);
      }
      p[1] += 0.03;
      return p;
    };
    const stripe = (u0: number, u1: number, v0: number, v1: number): void => {
      hull.upTri(at(u0, v0), at(u1, v0), at(u1, v1), RED);
      hull.upTri(at(u0, v0), at(u1, v1), at(u0, v1), RED);
    };
    stripe(0.12, 0.66, 0.2, 0.38);
    stripe(0.08, 0.42, 0.45, 0.52);

    // Engine pod.
    const px = s * 2.9;
    const py = 0.05;
    hull.solid(
      loft([podRing(px, py, 1.2, 0.3), podRing(px, py, 2.4, 0.78), podRing(px, py, 9.8, 0.85), podRing(px, py, 10.4, 0.72)]),
      [px, py, 6],
      GREY,
    );
    hull.solid(loft([podRing(px, py, 10.4, 0.74), podRing(px, py, 10.9, 0.62)]), [px, py, 10.6], DARK, 1);

    // Tail fin canted outward: a thin triangular prism.
    const fin = (dx: number): V[] => [
      [px + dx, 0.75, 5.2],
      [px + dx, 0.75, 10.2],
      [px + dx + s * 0.55, 3.7, 10.0],
    ];
    const f0 = fin(-0.07);
    const f1 = fin(0.07);
    hull.solid(
      [
        [f0[0]!, f0[1]!, f0[2]!],
        [f1[0]!, f1[1]!, f1[2]!],
        [f0[0]!, f0[1]!, f1[1]!],
        [f0[0]!, f1[1]!, f1[0]!],
        [f0[1]!, f0[2]!, f1[2]!],
        [f0[1]!, f1[2]!, f1[1]!],
        [f0[2]!, f0[0]!, f1[0]!],
        [f0[2]!, f1[0]!, f1[2]!],
      ],
      [px + s * 0.2, 1.8, 8.5],
      RED,
      1,
    );
  }

  const group = new Group();
  const hullMesh = new Mesh(
    hull.geometry(),
    new MeshStandardMaterial({ vertexColors: true, flatShading: true, metalness: 0.15, roughness: 0.55, side: DoubleSide }),
  );
  const glassMesh = new Mesh(
    glass.geometry(),
    new MeshStandardMaterial({ vertexColors: true, flatShading: true, metalness: 0.8, roughness: 0.18 }),
  );
  group.add(hullMesh, glassMesh);

  const lightGeo = new IcosahedronGeometry(0.32, 1);
  const mkLight = (r: number, g: number, b: number, p: V): Mesh => {
    const mat = new MeshBasicMaterial({ color: 0xffffff });
    mat.color.setRGB(r, g, b);
    const m = new Mesh(lightGeo, mat);
    m.position.set(...p);
    group.add(m);
    return m;
  };
  const navRight = mkLight(0.1, 2.5, 0.4, [TIP_X, TIP_Y + 0.1, TIP_Z - 0.2]);
  const navLeft = mkLight(2.6, 0.1, 0.1, [-TIP_X, TIP_Y + 0.1, TIP_Z - 0.2]);
  const strobe = mkLight(3, 3, 3, [0, 0.55, 9.4]);

  return {
    group,
    nozzles: [new Vector3(2.9, 0.05, 10.9), new Vector3(-2.9, 0.05, 10.9)],
    nozzleRadius: 0.6,
    navLeft,
    navRight,
    strobe,
    wingTips: [new Vector3(TIP_X, TIP_Y, TIP_Z), new Vector3(-TIP_X, TIP_Y, TIP_Z)],
  };
}

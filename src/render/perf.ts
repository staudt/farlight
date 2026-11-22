import type { WebGLRenderer } from 'three';

/**
 * Per frame render statistics for the debug panel: draw calls and triangles (summed over all
 * passes of the frame), CPU time of the render call and, where the browser allows it, GPU time
 * through EXT_disjoint_timer_query_webgl2.
 */
export class PerfStats {
  calls = 0;
  triangles = 0;
  cpuMs = 0;
  /** 0 when timer queries are unavailable. */
  gpuMs = 0;
  /** Lowest GPU time over the last 90 samples: less sensitive to other processes on the GPU. */
  gpuBest = 0;
  readonly gpuSupported: boolean;
  private readonly ring = new Float32Array(90);
  private ringN = 0;
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private pending: WebGLQuery | null = null;
  private active: WebGLQuery | null = null;
  private t0 = 0;
  /** Per stage profiling (off by default). Replaces the whole frame query while on. */
  profile = false;
  /** Per stage smoothed GPU ms, draw calls and triangles (filled while `profile` is on). */
  readonly passes: Record<string, { ms: number; best: number; calls: number; triangles: number }> = {};
  private readonly stages: { name: string; pass: { render: (...a: never[]) => void }; orig: (...a: never[]) => void }[] = [];
  private readonly stageQueries: { name: string; q: WebGLQuery }[] = [];

  constructor(private readonly renderer: WebGLRenderer) {
    this.renderer.info.autoReset = false;
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.gpuSupported = this.ext !== null;
  }

  begin(): void {
    this.renderer.info.reset();
    this.t0 = performance.now();
    const { gl, ext } = this;
    if (!ext) return;
    if (this.profile) {
      this.pollStages();
      return;
    }
    if (this.pending) {
      const done = gl.getQueryParameter(this.pending, gl.QUERY_RESULT_AVAILABLE) as boolean;
      if (done) {
        const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
        if (!disjoint) {
          const ms = (gl.getQueryParameter(this.pending, gl.QUERY_RESULT) as number) / 1e6;
          this.gpuMs = this.gpuMs === 0 ? ms : this.gpuMs * 0.9 + ms * 0.1;
          this.ring[this.ringN++ % this.ring.length] = ms;
          let best = Infinity;
          for (let i = 0, n = Math.min(this.ringN, this.ring.length); i < n; i++) best = Math.min(best, this.ring[i]!);
          this.gpuBest = best;
        }
        gl.deleteQuery(this.pending);
        this.pending = null;
      }
    }
    if (!this.pending) {
      this.active = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, this.active);
    }
  }

  /** Registers a composer pass as a named stage; timed only while `profile` is on. */
  addStage(name: string, pass: object): void {
    const p = pass as { render: (...a: never[]) => void };
    this.stages.push({ name, pass: p, orig: p.render });
    this.passes[name] = { ms: 0, best: 0, calls: 0, triangles: 0 };
  }

  setProfile(on: boolean): void {
    if (on === this.profile || !this.ext) return;
    this.profile = on;
    for (const st of this.stages) {
      if (!on) {
        st.pass.render = st.orig;
        continue;
      }
      st.pass.render = (...a: never[]) => {
        const { gl, ext } = this;
        const info = this.renderer.info.render;
        const c0 = info.calls;
        const t0 = info.triangles;
        const q = gl.createQuery();
        gl.beginQuery(ext!.TIME_ELAPSED_EXT, q);
        st.orig.apply(st.pass, a);
        gl.endQuery(ext!.TIME_ELAPSED_EXT);
        this.stageQueries.push({ name: st.name, q });
        const r = this.passes[st.name]!;
        r.calls = info.calls - c0;
        r.triangles = info.triangles - t0;
      };
    }
  }

  private pollStages(): void {
    const { gl, ext } = this;
    while (this.stageQueries.length) {
      const e = this.stageQueries[0]!;
      if (!(gl.getQueryParameter(e.q, gl.QUERY_RESULT_AVAILABLE) as boolean)) break;
      this.stageQueries.shift();
      if (!(gl.getParameter(ext!.GPU_DISJOINT_EXT) as boolean)) {
        const ms = (gl.getQueryParameter(e.q, gl.QUERY_RESULT) as number) / 1e6;
        const r = this.passes[e.name]!;
        r.ms = r.ms === 0 ? ms : r.ms * 0.9 + ms * 0.1;
        r.best = r.best === 0 ? ms : Math.min(r.best * 1.002, ms);
      }
      gl.deleteQuery(e.q);
    }
    if (this.stageQueries.length > 40) for (const e of this.stageQueries.splice(0, 20)) gl.deleteQuery(e.q);
    let sum = 0;
    for (const k in this.passes) sum += this.passes[k]!.ms;
    this.gpuMs = sum;
  }

  end(): void {
    if (this.active && this.ext) {
      this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.pending = this.active;
      this.active = null;
    }
    const info = this.renderer.info.render;
    this.calls = info.calls;
    this.triangles = info.triangles;
    this.cpuMs = this.cpuMs * 0.9 + (performance.now() - this.t0) * 0.1;
  }
}

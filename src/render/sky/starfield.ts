import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Points,
  ShaderMaterial,
} from 'three';
import { mulberry32 } from '../../core/rng';

const STAR_COUNT = 9000;
const RADIUS = 1e10;

/**
 * Stars at "infinity": a point sphere that stays centered on the camera. `brightness`
 * is driven by sky luminance so stars fade in daylight and return at night.
 */
export class Starfield {
  readonly object: Points;
  private material: ShaderMaterial;

  constructor(seed = 7) {
    const rnd = mulberry32(seed);
    const pos: number[] = [];
    const col: number[] = [];
    const size: number[] = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      // Bias some stars toward a galactic band for a Milky Way feel.
      let y: number, z: number;
      const inBand = rnd() < 0.45;
      const u = rnd() * 2 - 1;
      const t = rnd() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const x = s * Math.cos(t);
      y = inBand ? u * 0.12 : u;
      z = s * Math.sin(t);
      // Tilt the band.
      const tilt = 1.05;
      const y2 = y * Math.cos(tilt) - z * Math.sin(tilt);
      const z2 = y * Math.sin(tilt) + z * Math.cos(tilt);
      y = y2;
      z = z2;
      const len = Math.hypot(x, y, z);
      pos.push((x / len) * RADIUS, (y / len) * RADIUS, (z / len) * RADIUS);
      const temp = rnd();
      const c = temp < 0.15 ? [0.7, 0.8, 1.0] : temp > 0.85 ? [1.0, 0.85, 0.7] : [1, 1, 1];
      const b = Math.pow(rnd(), 3);
      col.push(c[0]! * (0.35 + b), c[1]! * (0.35 + b), c[2]! * (0.35 + b));
      size.push(1.0 + b * 2.6);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new Float32BufferAttribute(col, 3));
    geo.setAttribute('size', new Float32BufferAttribute(size, 1));
    this.material = new ShaderMaterial({
      uniforms: { uBrightness: { value: 1 }, uPixelRatio: { value: 1 }, uStretch: { value: 0 } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        uniform float uPixelRatio;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = size * uPixelRatio;
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying vec3 vColor;
        uniform float uBrightness;
        void main() {
          #include <logdepthbuf_fragment>
          vec2 d = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.0, length(d));
          gl_FragColor = vec4(vColor * a * uBrightness, 1.0);
        }`,
      blending: AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.object = new Points(geo, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = -10;
  }

  set brightness(v: number) {
    this.material.uniforms.uBrightness!.value = v;
  }

  set pixelRatio(v: number) {
    this.material.uniforms.uPixelRatio!.value = v;
  }
}

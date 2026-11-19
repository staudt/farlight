import { Color, IcosahedronGeometry, Mesh, ShaderMaterial, Vector3 } from 'three';
import type { Body } from '../../sim/universe';
import { starLight } from '../starLight';
import { ECLIPSE_GLSL, eclipse } from '../eclipse';
import { type BodyView, type FrameContext, apparentSizeBoost, placeRelative } from '../context';

/**
 * Far / fallback representation of a planet or moon: a faceted lit sphere in the body's
 * dominant color, scaled up so it never drops below its minimum apparent size.
 */
export class SimpleBodyView implements BodyView {
  readonly body: Body;
  readonly object: Mesh;
  private material: ShaderMaterial;

  constructor(body: Body) {
    this.body = body;
    const c = body.def.visual.color;
    this.material = new ShaderMaterial({
      uniforms: {
        uColor: { value: new Color(c[0], c[1], c[2]) },
        uSunDir: { value: new Vector3(1, 0, 0) },
        uStarColor: starLight.uniform,
        ...eclipse.uniforms,
        uEclSelf: { value: -1 },
      },
      vertexShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vNormalW;
        varying vec3 vRelW;
        void main() {
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vRelW = (modelMatrix * vec4(position, 1.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor;
        uniform vec3 uSunDir;
        uniform vec3 uStarColor;
        uniform float uEclSelf;
        ${ECLIPSE_GLSL}
        varying vec3 vNormalW;
        varying vec3 vRelW;
        void main() {
          #include <logdepthbuf_fragment>
          float d = dot(normalize(vNormalW), uSunDir);
          float light = smoothstep(-0.08, 0.25, d) * (0.35 + 0.65 * max(d, 0.0)) + 0.015;
          gl_FragColor = vec4(uColor * uStarColor * eclipseLight(vRelW, uEclSelf) * light, 1.0);
        }`,
    });
    this.object = new Mesh(new IcosahedronGeometry(1, 5), this.material);
    this.object.name = `body:${body.id}`;
  }

  update(ctx: FrameContext): void {
    const b = this.body;
    placeRelative(this.object, b.position, ctx.cameraWorld);
    const dist = b.position.distanceTo(ctx.cameraWorld);
    const scale = b.radius * apparentSizeBoost(b.radius, dist, b.minApparentSize);
    this.object.scale.setScalar(scale);
    this.object.quaternion.copy(b.rotation);
    this.material.uniforms.uEclSelf!.value = eclipse.idOf(b);
    const sun = ctx.world.universe.root;
    (this.material.uniforms.uSunDir!.value as Vector3).copy(sun.position).sub(b.position).normalize();
  }

  dispose(): void {
    this.object.geometry.dispose();
    this.material.dispose();
  }
}

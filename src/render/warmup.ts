import { Group, InstancedBufferAttribute, InstancedMesh } from 'three';
import type { GameRenderer } from './renderer';
import type { PostStack } from './post';
import { createPropMaterial, propGeometry } from './bodies/props';
import { createTerrainMaterial } from './bodies/terrainMaterial';

/**
 * Shader warm-up. First use of a material compiles and links its program on the render thread, which
 * costs 100 to 350 ms per program on a phone. Compile everything the session may need while the title
 * card is up: every material already in the scene (compile ignores visibility), a stand in for the
 * instanced prop materials (props only exist once chunks have built) and the other bloom variant of
 * the final post pass. Runs on the render target the post stack draws into, because tone mapping and
 * colour space are part of the program key.
 */
export async function warmUp(gfx: GameRenderer, post: PostStack): Promise<void> {
  const r = gfx.renderer;
  const dummies = new Group();
  dummies.visible = false;
  dummies.name = 'warmup';
  const terrainUniforms = createTerrainMaterial().uniforms;
  const mat = createPropMaterial(terrainUniforms);
  for (const kind of ['tree', 'rock', 'spire', 'crystal', 'mesa'] as const) {
    const m = new InstancedMesh(propGeometry(kind, 0), mat, 1);
    m.instanceColor = new InstancedBufferAttribute(new Float32Array(3), 3);
    dummies.add(m);
  }
  gfx.scene.add(dummies);
  const prev = r.getRenderTarget();
  r.setRenderTarget(post.composer.inputBuffer);
  try {
    await r.compileAsync(gfx.scene, gfx.camera);
  } finally {
    r.setRenderTarget(prev);
    gfx.scene.remove(dummies);
    for (const m of dummies.children) (m as InstancedMesh).dispose();
    mat.dispose();
  }
  await new Promise<void>((res) => requestAnimationFrame(() => res()));
  post.warmVariants();
}

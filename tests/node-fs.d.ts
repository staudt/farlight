/** Minimal typing for the one node API tests use (no @types/node in this project). */
declare module 'node:fs' {
  export function readFileSync(path: URL): Uint8Array;
}

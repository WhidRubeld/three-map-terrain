import type { GeoLocation, Map } from '../src'

/** Debug handle exposed as `window.__playground` (used by the e2e tests). */
export interface Playground {
  map: Map
  /** three.js `REVISION` actually loaded */
  revision: string
  /** `webgl`, `webgpu`, or `webgpu (webgl2 backend)` */
  backend: string
  /** Resolves once `map.init()` has finished. */
  ready: Promise<void>
  /** Number of tiles whose placeholder was replaced by the stitched texture. */
  texturedTiles: () => number
  /** Result of the last click on the terrain (`map.pick`). */
  lastPick: GeoLocation | undefined
}

declare global {
  interface Window {
    __playground?: Playground
  }
}

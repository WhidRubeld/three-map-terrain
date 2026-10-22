import type { Camera, WebGLRenderer } from 'three'
import type { MapControls } from 'three/addons/controls/MapControls.js'
import type { WebGPURenderer } from 'three/webgpu'

import type {
  BuildingId,
  Buildings,
  GeoLocation,
  Map,
  RoadId,
  RoadKind,
  Roads,
  Vegetation,
  Water
} from '../src'

/** Debug handle exposed as `window.__playground` (used by the e2e tests). */
export interface Playground {
  map: Map
  /** The coarser ring around the map (`?lod=…`). */
  ring: Map | undefined
  /** The buildings layer (`?buildings=…`). */
  buildings: Buildings | undefined
  /** The roads layer (`?roads=…`). */
  roads: Roads | undefined
  /** The water layer (`?water=…`). */
  water: Water | undefined
  /** The vegetation layer (`?vegetation=…`). */
  vegetation: Vegetation | undefined
  /** three.js `REVISION` actually loaded */
  revision: string
  /** `webgl`, `webgpu`, or `webgpu (webgl2 backend)` */
  backend: string
  renderer: WebGLRenderer | WebGPURenderer
  camera: Camera
  /** Orbit controls; `undefined` in the top view. */
  controls: MapControls | undefined
  /** Resolves once `map.init()` has finished. */
  ready: Promise<void>
  /** Number of tiles whose placeholder was replaced by the stitched texture. */
  texturedTiles: () => number
  /** Result of the last click on the terrain (`map.pick`). */
  lastPick: GeoLocation | undefined
  /** The building of the last click (`buildings.pick`). */
  lastBuilding:
    { id?: BuildingId; height?: number; lat: number; lon: number } | undefined
  /** The road of the last click (`roads.pick`). */
  lastRoad:
    | { id?: RoadId; kind: RoadKind; bridge: boolean; lat: number; lon: number }
    | undefined
  /**
   * Stops the render loop after one last frame. With software rendering
   * (SwiftShader on GPU-less CI) every frame takes long enough to starve
   * screenshots and `page.evaluate`; the tests freeze the scene first.
   */
  freeze: () => Promise<void>
}

declare global {
  interface Window {
    __playground?: Playground
  }
}

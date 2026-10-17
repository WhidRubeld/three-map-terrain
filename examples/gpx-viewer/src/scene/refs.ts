import type { Group, Vector3 } from 'three'
import type { MapControls } from 'three/addons/controls/MapControls.js'

/** Scene objects that non-React code (pointer, camera rig) needs to reach. */
export const sceneRefs: {
  /** parent of the terrain and overlays; its `scale.z` is the exaggeration */
  world: Group | null
  controls: MapControls | null
  /** terrain under the pointer, in `world` coordinates */
  pointer: Vector3 | null
} = { world: null, controls: null, pointer: null }

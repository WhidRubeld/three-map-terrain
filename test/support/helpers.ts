import { type Object3D, Raycaster, Vector3 } from 'three'

import type { ElevationPixels } from '../../src'

/** Encodes meters into terrarium RGB: `R * 256 + G + B / 256 - 32768`. */
export function encodeTerrarium(meters: number): [number, number, number] {
  const value = meters + 32768
  const integer = Math.floor(value)
  return [
    Math.floor(integer / 256),
    integer % 256,
    Math.round((value - integer) * 256)
  ]
}

/** Builds an `ImageData`-like terrarium tile from `height(x, y)` in meters. */
export function terrariumPixels(
  size: number,
  height: (x: number, y: number) => number
): ElevationPixels {
  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const [r, g, b] = encodeTerrarium(height(x, y))
      data.set([r, g, b, 255], i)
    }
  }
  return { width: size, height: size, data }
}

/** Height of the first surface hit by a vertical ray through `x`, `y`. */
export function raycastZ(object: Object3D, x: number, y: number) {
  object.updateMatrixWorld(true)
  const raycaster = new Raycaster(new Vector3(x, y, 1e6), new Vector3(0, 0, -1))
  const hit = raycaster.intersectObject(object, true).at(0)
  if (!hit) throw new Error(`No surface at ${x}, ${y}`)
  return hit.point.z
}

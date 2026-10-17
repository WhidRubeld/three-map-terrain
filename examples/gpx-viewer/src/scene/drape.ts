import type { Map } from 'three-map-terrain'

import type { Track } from '../gpx/track'
import { fractionalIndex } from '../lib/geo'
import type { Drape } from '../state/viewer'

/** The point on the rendered surface, or at the GPX altitude off the loaded grid. */
export function surfacePoint(map: Map, lat: number, lon: number, alt = 0) {
  return (
    map.getTerrainPositionSync({ lat, lon }, { loadTile: false }) ??
    map.getPosition({ lat, lon, alt }, { loadTile: false })
  )
}

/**
 * Puts the track on the terrain. Every track point sits on the surface
 * (`getTerrainPositionSync` interpolates over the mesh triangles), and the
 * rendered line is resampled to the mesh resolution `cell`: dense recordings
 * are thinned, long straight legs get intermediate vertices so that the line
 * follows the relief instead of cutting through it. `lift` raises everything
 * a little above the surface.
 */
export function drapeTrack(
  map: Map,
  track: Track,
  cell: number,
  lift: number
): Drape {
  const { points: source, elevation } = track
  const n = source.length

  const points = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const ele = elevation[i]
    const p = surfacePoint(
      map,
      source[i].lat,
      source[i].lon,
      Number.isNaN(ele) ? 0 : ele
    )
    points[i * 3] = p.x
    points[i * 3 + 1] = p.y
    points[i * 3 + 2] = p.z + lift
  }

  const line: number[] = []
  const lineIndex: number[] = []
  let last = 0
  const push = (x: number, y: number, z: number, index: number) => {
    line.push(x, y, z)
    lineIndex.push(index)
  }
  push(points[0], points[1], points[2], 0)

  for (let i = 1; i < n; i++) {
    const dx = points[i * 3] - points[last * 3]
    const dy = points[i * 3 + 1] - points[last * 3 + 1]
    const length = Math.hypot(dx, dy)
    if (length < cell * 0.5 && i < n - 1) continue

    const parts = Math.max(1, Math.ceil(length / cell))
    const a = source[last]
    const b = source[i]
    for (let k = 1; k < parts; k++) {
      const t = k / parts
      const p = surfacePoint(
        map,
        a.lat + (b.lat - a.lat) * t,
        a.lon + (b.lon - a.lon) * t
      )
      push(p.x, p.y, p.z + lift, last + (i - last) * t)
    }
    push(points[i * 3], points[i * 3 + 1], points[i * 3 + 2], i)
    last = i
  }

  return {
    points,
    line: Float32Array.from(line),
    lineIndex: Float32Array.from(lineIndex)
  }
}

export interface Vec3Like {
  x: number
  y: number
  z: number
}

/** Terrain-space position on the rendered line at a fractional track point index. */
export function lineAt(
  drape: Drape,
  index: number,
  out: Vec3Like = { x: 0, y: 0, z: 0 }
) {
  const { line, lineIndex } = drape
  const v = fractionalIndex(lineIndex, index)
  const low = Math.floor(v)
  const high = Math.min(low + 1, lineIndex.length - 1)
  const t = v - low
  out.x = line[low * 3] + (line[high * 3] - line[low * 3]) * t
  out.y = line[low * 3 + 1] + (line[high * 3 + 1] - line[low * 3 + 1]) * t
  out.z = line[low * 3 + 2] + (line[high * 3 + 2] - line[low * 3 + 2]) * t
  return out
}

/** Fractional line segment index (for `instanceCount`) at a track point index. */
export const lineVertexAt = (drape: Drape, index: number) =>
  fractionalIndex(drape.lineIndex, index)

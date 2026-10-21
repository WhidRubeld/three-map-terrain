// Cuts flat shapes along the triangles of a terrain tile, so that every piece
// lies in one triangle and, with the triangle's heights, exactly on the mesh.
// Internal.
//
// Grid coordinates: a tile of `n` segments spans `[0, n]²`, columns going
// east, rows south; cell (c, r) is split along its north-east → south-west
// diagonal `col + row = c + r + 1`, as PlaneGeometry splits it.

import type { BufferAttribute, InterleavedBufferAttribute } from 'three'

import type { Tile } from '../terrain/Tile.class'

/** `[minCol, minRow, maxCol, maxRow]` */
export type GridRect = readonly [number, number, number, number]

/** Pieces with a smaller area (cells²) are dropped: slivers of a cut. */
const MIN_AREA = 1e-9

/** Signed area of a flat `[x0, y0, x1, y1, …]` polygon (shoelace). */
export function polygonArea(polygon: readonly number[], stride = 2) {
  let area = 0
  const n = polygon.length
  for (let i = 0, j = n - stride; i < n; j = i, i += stride) {
    area += polygon[j] * polygon[i + 1] - polygon[i] * polygon[j + 1]
  }
  return area / 2
}

/**
 * Keeps the part of a convex polygon where `a·x + b·y ≤ c`
 * (Sutherland–Hodgman). Components after `x`, `y` (`stride` > 2, e.g. a
 * height) are interpolated along the cut edges.
 */
export function clipHalfPlane(
  polygon: readonly number[],
  a: number,
  b: number,
  c: number,
  stride = 2
): number[] {
  const out: number[] = []
  const n = polygon.length
  for (let i = 0; i < n; i += stride) {
    const j = (i + stride) % n
    const da = a * polygon[i] + b * polygon[i + 1] - c
    const db = a * polygon[j] + b * polygon[j + 1] - c
    if (da <= 0) {
      for (let k = 0; k < stride; k++) out.push(polygon[i + k])
    }
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db)
      for (let k = 0; k < stride; k++) {
        out.push(polygon[i + k] + (polygon[j + k] - polygon[i + k]) * t)
      }
    }
  }
  return out
}

/** Clips a convex polygon to a rectangle `[minX, minY, maxX, maxY]`. */
export function clipToRect(
  polygon: readonly number[],
  [minX, minY, maxX, maxY]: readonly number[],
  stride = 2
): number[] {
  let clipped = clipHalfPlane(polygon, -1, 0, -minX, stride)
  clipped = clipHalfPlane(clipped, 1, 0, maxX, stride)
  clipped = clipHalfPlane(clipped, 0, -1, -minY, stride)
  return clipHalfPlane(clipped, 0, 1, maxY, stride)
}

function bounds(polygon: readonly number[]) {
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity]
  for (let i = 0; i < polygon.length; i += 2) {
    minX = Math.min(minX, polygon[i])
    maxX = Math.max(maxX, polygon[i])
    minY = Math.min(minY, polygon[i + 1])
    maxY = Math.max(maxY, polygon[i + 1])
  }
  return [minX, minY, maxX, maxY] as const
}

/**
 * Cuts a convex polygon in grid coordinates, within `rect`, into convex
 * pieces that each lie in one triangle of the terrain mesh.
 */
export function cutPolygon(
  polygon: readonly number[],
  rect: GridRect,
  emit: (piece: number[]) => void
) {
  const clipped = clipToRect(polygon, rect)
  if (clipped.length < 6) return
  const [, minRow, , maxRow] = bounds(clipped)
  for (let r = Math.floor(minRow); r < maxRow; r++) {
    let band = clipHalfPlane(clipped, 0, -1, -r)
    band = clipHalfPlane(band, 0, 1, r + 1)
    if (band.length < 6) continue
    const [minCol, , maxCol] = bounds(band)
    for (let c = Math.floor(minCol); c < maxCol; c++) {
      let cell = clipHalfPlane(band, -1, 0, -c)
      cell = clipHalfPlane(cell, 1, 0, c + 1)
      if (cell.length < 6) continue
      const diagonal = c + r + 1
      for (const piece of [
        clipHalfPlane(cell, 1, 1, diagonal),
        clipHalfPlane(cell, -1, -1, -diagonal)
      ]) {
        if (piece.length >= 6 && Math.abs(polygonArea(piece)) > MIN_AREA) {
          emit(piece)
        }
      }
    }
  }
}

/**
 * Where the segment from `a` to `b` (grid coordinates) crosses the lines of
 * the triangle grid — columns, rows and diagonals — as parameters `t` in
 * `[0, 1]`, sorted, with 0 and 1: between two, the segment lies in one
 * triangle.
 */
export function gridCrossings(
  ax: number,
  ay: number,
  bx: number,
  by: number
): number[] {
  const crossings = [0, 1]
  const add = (from: number, to: number) => {
    if (from === to) return
    const low = Math.min(from, to)
    const high = Math.max(from, to)
    for (let k = Math.floor(low) + 1; k < high; k++) {
      crossings.push((k - from) / (to - from))
    }
  }
  add(ax, bx)
  add(ay, by)
  add(ax + ay, bx + by)
  return crossings.sort((p, q) => p - q)
}

/** A point of the surface: its height and normal. */
export interface SurfacePoint {
  z: number
  nx: number
  ny: number
  nz: number
}

/**
 * Heights and normals of a tile's mesh at grid coordinates, interpolated
 * over the same triangles as `Tile.heightAt` and the GPU: a shape cut with
 * `cutPolygon` and sampled here lies on the terrain and is lit like it.
 */
export class TileSurface {
  readonly n: number
  private readonly position: BufferAttribute | InterleavedBufferAttribute
  private readonly normal: BufferAttribute | InterleavedBufferAttribute

  constructor(tile: Tile) {
    this.n = tile.map.options.tileSegments
    this.position = tile.geometry.attributes.position
    this.normal = tile.geometry.attributes.normal
  }

  sample(col: number, row: number, out: SurfacePoint): SurfacePoint {
    const { n, position, normal } = this
    const cc = Math.min(Math.max(col, 0), n)
    const rr = Math.min(Math.max(row, 0), n)
    const ix = Math.min(Math.floor(cc), n - 1)
    const iy = Math.min(Math.floor(rr), n - 1)
    const fc = cc - ix
    const fr = rr - iy
    const index = (r: number, c: number) => (iy + r) * (n + 1) + ix + c

    // the vertices of the triangle and their weights, as in Tile.heightAt
    let [i0, i1, i2] = [index(0, 0), index(1, 0), index(0, 1)]
    let [w0, w1, w2] = [1 - fr - fc, fr, fc]
    if (fr + fc > 1) {
      ;[i0, i1, i2] = [index(1, 1), index(0, 1), index(1, 0)]
      ;[w0, w1, w2] = [fr + fc - 1, 1 - fr, 1 - fc]
    }
    out.z =
      position.getZ(i0) * w0 + position.getZ(i1) * w1 + position.getZ(i2) * w2
    const nx =
      normal.getX(i0) * w0 + normal.getX(i1) * w1 + normal.getX(i2) * w2
    const ny =
      normal.getY(i0) * w0 + normal.getY(i1) * w1 + normal.getY(i2) * w2
    const nz =
      normal.getZ(i0) * w0 + normal.getZ(i1) * w1 + normal.getZ(i2) * w2
    const length = Math.hypot(nx, ny, nz) || 1
    out.nx = nx / length
    out.ny = ny / length
    out.nz = nz / length
    return out
  }
}

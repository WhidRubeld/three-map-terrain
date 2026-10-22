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
export function polygonArea(
  polygon: ArrayLike<number>,
  stride = 2,
  /** Of the values that are the polygon. */
  length = polygon.length
) {
  let area = 0
  const n = length
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

/**
 * `clipHalfPlane` of the first `n` values of `polygon` (x, y pairs) into
 * `out`; returns how many values it wrote.
 */
function clipInto(
  polygon: Float64Array,
  n: number,
  a: number,
  b: number,
  c: number,
  out: Float64Array
): number {
  let length = 0
  for (let i = 0; i < n; i += 2) {
    const j = i + 2 === n ? 0 : i + 2
    const da = a * polygon[i] + b * polygon[i + 1] - c
    const db = a * polygon[j] + b * polygon[j + 1] - c
    if (da <= 0) {
      out[length++] = polygon[i]
      out[length++] = polygon[i + 1]
    }
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db)
      out[length++] = polygon[i] + (polygon[j] - polygon[i]) * t
      out[length++] = polygon[i + 1] + (polygon[j + 1] - polygon[i + 1]) * t
    }
  }
  return length
}

/** Polygons being cut, reused from call to call (cutting never nests). */
let scratch: Float64Array[] = []

/** Lowest and highest of the x (`axis` 0) or y (1) of the first `n` values. */
function range(polygon: Float64Array, n: number, axis: 0 | 1) {
  let [low, high] = [Infinity, -Infinity]
  for (let i = axis; i < n; i += 2) {
    low = Math.min(low, polygon[i])
    high = Math.max(high, polygon[i])
  }
  return [low, high] as const
}

/**
 * Cuts a convex polygon in grid coordinates, within `rect`, into convex
 * pieces that each lie in one triangle of the terrain mesh. `emit` gets
 * each piece as the first `length` values of `piece` — an array that is
 * reused: read it before returning.
 */
export function cutPolygon(
  polygon: readonly number[],
  [minX, minY, maxX, maxY]: GridRect,
  emit: (piece: Float64Array, length: number) => void
) {
  // every cut adds at most one point
  const size = polygon.length + 2 * 12
  if (scratch.length === 0 || scratch[0].length < size) {
    scratch = Array.from({ length: 6 }, () => new Float64Array(2 * size))
  }
  const [shape, other, band, part, cell, piece] = scratch
  shape.set(polygon)
  let n = clipInto(shape, polygon.length, -1, 0, -minX, other)
  n = clipInto(other, n, 1, 0, maxX, shape)
  n = clipInto(shape, n, 0, -1, -minY, other)
  n = clipInto(other, n, 0, 1, maxY, shape)
  if (n < 6) return
  const [minRow, maxRow] = range(shape, n, 1)
  for (let r = Math.floor(minRow); r < maxRow; r++) {
    let m = clipInto(shape, n, 0, -1, -r, other)
    m = clipInto(other, m, 0, 1, r + 1, band)
    if (m < 6) continue
    const [minCol, maxCol] = range(band, m, 0)
    for (let c = Math.floor(minCol); c < maxCol; c++) {
      let k = clipInto(band, m, -1, 0, -c, part)
      k = clipInto(part, k, 1, 0, c + 1, cell)
      if (k < 6) continue
      const diagonal = c + r + 1
      for (const side of [1, -1]) {
        const length = clipInto(cell, k, side, side, side * diagonal, piece)
        if (length >= 6 && Math.abs(polygonArea(piece, 2, length)) > MIN_AREA) {
          emit(piece, length)
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
  private readonly position: ArrayLike<number>
  private readonly normal: ArrayLike<number>

  constructor(tile: Tile) {
    this.n = tile.map.options.tileSegments
    const { position, normal } = tile.geometry.attributes
    this.position = values(position)
    this.normal = values(normal)
  }

  sample(col: number, row: number, out: SurfacePoint): SurfacePoint {
    const { n, position: p, normal: q } = this
    const cc = Math.min(Math.max(col, 0), n)
    const rr = Math.min(Math.max(row, 0), n)
    const ix = Math.min(Math.floor(cc), n - 1)
    const iy = Math.min(Math.floor(rr), n - 1)
    const fc = cc - ix
    const fr = rr - iy
    const top = iy * (n + 1) + ix
    const bottom = top + n + 1

    // the vertices of the triangle and their weights, as in Tile.heightAt
    let [i0, i1, i2] = [3 * top, 3 * bottom, 3 * (top + 1)]
    let [w0, w1, w2] = [1 - fr - fc, fr, fc]
    if (fr + fc > 1) {
      ;[i0, i1, i2] = [3 * (bottom + 1), 3 * (top + 1), 3 * bottom]
      ;[w0, w1, w2] = [fr + fc - 1, 1 - fr, 1 - fc]
    }
    out.z = p[i0 + 2] * w0 + p[i1 + 2] * w1 + p[i2 + 2] * w2
    const nx = q[i0] * w0 + q[i1] * w1 + q[i2] * w2
    const ny = q[i0 + 1] * w0 + q[i1 + 1] * w1 + q[i2 + 1] * w2
    const nz = q[i0 + 2] * w0 + q[i1 + 2] * w1 + q[i2 + 2] * w2
    const length = Math.hypot(nx, ny, nz) || 1
    out.nx = nx / length
    out.ny = ny / length
    out.nz = nz / length
    return out
  }
}

/** The x, y, z of every item of an attribute, flat: its own array if it can. */
function values(
  attribute: BufferAttribute | InterleavedBufferAttribute
): ArrayLike<number> {
  if ('isBufferAttribute' in attribute && !attribute.normalized) {
    return attribute.array
  }
  const flat = new Float32Array(attribute.count * 3)
  for (let i = 0; i < attribute.count; i++) {
    flat[3 * i] = attribute.getX(i)
    flat[3 * i + 1] = attribute.getY(i)
    flat[3 * i + 2] = attribute.getZ(i)
  }
  return flat
}

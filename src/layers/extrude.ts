// Extrudes footprints into walls, roofs, floors and their edges. Internal:
// `TileContext.extrude` is the public way in.

import { type Color, ShapeUtils, Vector2 } from 'three'

import type { LineBuilder, SurfaceBuilder } from './geometry'

/** Walls turning less than this (sine of ~20°) meet without a corner line. */
const CORNER_SINE = 0.34

/** A ring as flat `[x0, y0, x1, y1, …]` in scene units, not closed. */
export type FlatRing = number[]

/** Signed area of a flat ring, positive counter-clockwise (y up). */
export function flatRingArea(ring: readonly number[]) {
  let area = 0
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    area += ring[j] * ring[i + 1] - ring[i] * ring[j + 1]
  }
  return area / 2
}

function reversed(ring: readonly number[]): FlatRing {
  const out: FlatRing = []
  for (let i = ring.length - 2; i >= 0; i -= 2) out.push(ring[i], ring[i + 1])
  return out
}

/** Where the faces and edges of an extrusion go, and how they look. */
export interface ExtrusionTarget {
  walls: SurfaceBuilder
  roofs: SurfaceBuilder
  /** Only extrusions with a floor (`minHeight > 0`) need it. */
  floors: () => SurfaceBuilder
  /** `undefined` draws no edges. */
  edges: LineBuilder | undefined
  color: Color
  lineColor: Color
  feature: number
  /** Horizontal scene units per meter, and vertical: UVs are in meters. */
  unitsPerMeter: number
  zScale: number
  /** UV of a point of a roof or floor (meters, continuous across tiles). */
  planarUv: (x: number, y: number) => [number, number]
}

/**
 * Polygons (outer ring, then holes) extruded from `bottom` to `top`: walls
 * (UV: meters along the ring, meters up), a roof, a floor if `floor`. With
 * `edges`, the top and bottom of every wall and its corners — the outline,
 * not the triangles.
 */
export function extrude(
  target: ExtrusionTarget,
  polygons: readonly (readonly FlatRing[])[],
  bottom: number,
  top: number,
  floor: boolean
) {
  for (const polygon of polygons) {
    // outer rings counter-clockwise, holes clockwise: the right-hand normal
    // of every edge then points out of the solid
    const rings = polygon.map((ring, i) =>
      flatRingArea(ring) > 0 === (i === 0) ? [...ring] : reversed(ring)
    )
    for (const ring of rings) {
      walls(target, ring, bottom, top)
      if (target.edges) edges(target, target.edges, ring, bottom, top)
    }
    cap(target, target.roofs, rings, top, 1)
    if (floor) cap(target, target.floors(), rings, bottom, -1)
  }
}

function walls(
  target: ExtrusionTarget,
  ring: FlatRing,
  bottom: number,
  top: number
) {
  const { walls: builder, color, feature, unitsPerMeter, zScale } = target
  const height = (top - bottom) / zScale
  const n = ring.length / 2
  let along = 0
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const [ax, ay, bx, by] = [
      ring[2 * i],
      ring[2 * i + 1],
      ring[2 * j],
      ring[2 * j + 1]
    ]
    const length = Math.hypot(bx - ax, by - ay)
    if (length < 1e-9) continue
    const nx = (by - ay) / length
    const ny = -(bx - ax) / length
    const [u0, u1] = [along, along + length / unitsPerMeter]
    along = u1
    const a = builder.vertex(ax, ay, bottom, nx, ny, 0, u0, 0, color, feature)
    const b = builder.vertex(bx, by, bottom, nx, ny, 0, u1, 0, color, feature)
    const c = builder.vertex(bx, by, top, nx, ny, 0, u1, height, color, feature)
    const d = builder.vertex(ax, ay, top, nx, ny, 0, u0, height, color, feature)
    builder.triangle(a, b, c)
    builder.triangle(a, c, d)
  }
}

function edges(
  target: ExtrusionTarget,
  lines: LineBuilder,
  ring: FlatRing,
  bottom: number,
  top: number
) {
  const { lineColor: color, feature } = target
  const n = ring.length / 2
  for (let i = 0; i < n; i++) {
    const h = (i + n - 1) % n
    const j = (i + 1) % n
    const [ax, ay, bx, by] = [
      ring[2 * i],
      ring[2 * i + 1],
      ring[2 * j],
      ring[2 * j + 1]
    ]
    lines.segment(ax, ay, top, bx, by, top, color, feature)
    lines.segment(ax, ay, bottom, bx, by, bottom, color, feature)
    // a corner, not a vertex of a curved wall
    const [ux, uy] = [ax - ring[2 * h], ay - ring[2 * h + 1]]
    const [vx, vy] = [bx - ax, by - ay]
    const turn =
      Math.abs(ux * vy - uy * vx) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))
    if (!(turn < CORNER_SINE && ux * vx + uy * vy > 0)) {
      lines.segment(ax, ay, bottom, ax, ay, top, color, feature)
    }
  }
}

/** A roof (`facing` 1, up) or floor (−1, down) at `z`. */
function cap(
  target: ExtrusionTarget,
  builder: SurfaceBuilder,
  rings: readonly FlatRing[],
  z: number,
  facing: 1 | -1
) {
  const toPoints = (ring: FlatRing) => {
    const points: Vector2[] = []
    for (let i = 0; i < ring.length; i += 2) {
      points.push(new Vector2(ring[i], ring[i + 1]))
    }
    return points
  }
  const contour = toPoints(rings[0])
  const holes = rings.slice(1).map(toPoints)
  // drops a repeated end point, hence the points are listed afterwards
  const faces = ShapeUtils.triangulateShape(contour, holes)
  const points = [...contour, ...holes.flat()]

  const { color, feature, planarUv } = target
  const base = builder.vertexCount
  for (const point of points) {
    const [u, v] = planarUv(point.x, point.y)
    builder.vertex(point.x, point.y, z, 0, 0, facing, u, v, color, feature)
  }
  for (const [a, b, c] of faces) {
    const pa = points[a]
    const pb = points[b]
    const pc = points[c]
    const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y)
    // counter-clockwise seen from where the cap faces
    if (area * facing >= 0) builder.triangle(base + a, base + b, base + c)
    else builder.triangle(base + a, base + c, base + b)
  }
}

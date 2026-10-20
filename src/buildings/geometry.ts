// Extrudes footprints into one merged geometry per terrain tile.

import {
  BufferAttribute,
  BufferGeometry,
  type Color,
  ShapeUtils,
  Vector2
} from 'three'

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

/**
 * Accumulates buildings, then builds one indexed `BufferGeometry` of their
 * faces and, with `lines`, one of their edges for `LineSegments`: the top and
 * bottom of every wall and its vertical corner — the outline, not the
 * triangles.
 */
export class BuildingGeometryBuilder {
  private readonly positions: number[] = []
  private readonly normals: number[] = []
  private readonly colors: number[] = []
  private readonly indices: number[] = []
  private readonly linePositions: number[] = []
  private readonly lineColors: number[] = []

  constructor(private readonly lines = false) {}

  get vertexCount() {
    return this.positions.length / 3
  }

  get lineVertexCount() {
    return this.linePositions.length / 3
  }

  private line(
    [ax, ay, az]: readonly number[],
    [bx, by, bz]: readonly number[],
    color: Color
  ) {
    this.linePositions.push(ax, ay, az, bx, by, bz)
    this.lineColors.push(color.r, color.g, color.b, color.r, color.g, color.b)
  }

  private vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    color: Color
  ) {
    this.positions.push(x, y, z)
    this.normals.push(nx, ny, nz)
    this.colors.push(color.r, color.g, color.b)
  }

  /**
   * Adds one building: polygons (outer ring, then holes) extruded from
   * `bottom` to `top`, with a roof, and a floor if `floor` (parts that do
   * not stand on the ground are seen from below).
   */
  add(
    polygons: readonly (readonly FlatRing[])[],
    bottom: number,
    top: number,
    color: Color,
    floor: boolean,
    lineColor: Color = color
  ) {
    for (const polygon of polygons) {
      // outer rings counter-clockwise, holes clockwise: the right-hand
      // normal of every edge then points out of the solid
      const rings = polygon.map((ring, i) =>
        flatRingArea(ring) > 0 === (i === 0) ? [...ring] : reversed(ring)
      )
      for (const ring of rings) {
        this.walls(ring, bottom, top, color)
        if (this.lines) this.edges(ring, bottom, top, lineColor)
      }
      this.cap(rings, top, color, 1)
      if (floor) this.cap(rings, bottom, color, -1)
    }
  }

  private edges(ring: FlatRing, bottom: number, top: number, color: Color) {
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
      this.line([ax, ay, top], [bx, by, top], color)
      this.line([ax, ay, bottom], [bx, by, bottom], color)
      // a corner, not a vertex of a curved wall
      const [ux, uy] = [ax - ring[2 * h], ay - ring[2 * h + 1]]
      const [vx, vy] = [bx - ax, by - ay]
      const turn =
        Math.abs(ux * vy - uy * vx) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))
      if (!(turn < CORNER_SINE && ux * vx + uy * vy > 0)) {
        this.line([ax, ay, bottom], [ax, ay, top], color)
      }
    }
  }

  private walls(ring: FlatRing, bottom: number, top: number, color: Color) {
    const n = ring.length / 2
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
      const base = this.vertexCount
      this.vertex(ax, ay, bottom, nx, ny, 0, color)
      this.vertex(bx, by, bottom, nx, ny, 0, color)
      this.vertex(bx, by, top, nx, ny, 0, color)
      this.vertex(ax, ay, top, nx, ny, 0, color)
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }

  /** A roof (`facing` 1, up) or floor (−1, down) at `z`. */
  private cap(
    rings: readonly FlatRing[],
    z: number,
    color: Color,
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

    const base = this.vertexCount
    for (const point of points)
      this.vertex(point.x, point.y, z, 0, 0, facing, color)
    for (const [a, b, c] of faces) {
      const pa = points[a]
      const pb = points[b]
      const pc = points[c]
      const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y)
      // counter-clockwise seen from where the cap faces
      if (area * facing >= 0) this.indices.push(base + a, base + b, base + c)
      else this.indices.push(base + a, base + c, base + b)
    }
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry()
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(this.positions), 3)
    )
    geometry.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array(this.normals), 3)
    )
    geometry.setAttribute(
      'color',
      new BufferAttribute(new Float32Array(this.colors), 3)
    )
    const Indices = this.vertexCount > 65535 ? Uint32Array : Uint16Array
    geometry.setIndex(new BufferAttribute(new Indices(this.indices), 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }

  /** The edges, for `LineSegments`; `undefined` without `lines`. */
  buildLines(): BufferGeometry | undefined {
    if (!this.lines) return undefined
    const geometry = new BufferGeometry()
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(this.linePositions), 3)
    )
    geometry.setAttribute(
      'color',
      new BufferAttribute(new Float32Array(this.lineColors), 3)
    )
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }
}

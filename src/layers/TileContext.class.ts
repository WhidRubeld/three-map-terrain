import {
  type BufferGeometry,
  Color,
  type Matrix4,
  type Object3D,
  ShapeUtils,
  Vector2
} from 'three'

import { clipRect, isRing, type Position } from './features'
import { Utils } from '../geo/Utils.class'
import type { SourceTileKey } from '../sources/source-tiles'
import type { Map } from '../terrain/Map.class'
import type { Tile } from '../terrain/Tile.class'
import {
  cutPolygon,
  gridCrossings,
  type GridRect,
  polygonArea,
  type SurfacePoint,
  TileSurface
} from './drape'
import { extrude, type FlatRing } from './extrude'
import { InstanceBuilder, LineBuilder, SurfaceBuilder } from './geometry'

/** `[minX, minY, maxX, maxY]` in a tile's local coordinates. */
export type Rect = readonly [
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
]

/** The features a source tile gave a terrain tile, and where it lies. */
export interface SourceFeatures<F> {
  readonly key: SourceTileKey
  /** The source tile in the terrain tile's local coordinates. */
  readonly rect: Rect
  readonly features: readonly F[]
}

/** UV of a point of a shape, in meters; by default continuous across tiles. */
export type UvMapping = (x: number, y: number, z: number) => [number, number]

/** How a shape is drawn. */
export interface ShapeStyle {
  /** Its vertex color (the default materials draw it). */
  color: Color
  /** Draws only the part inside this rectangle — besides the tile. */
  clip?: Rect
}

export interface ExtrudeStyle {
  color: Color
  /** Of the edges; by default `color`. */
  lineColor?: Color
  /** Also a floor, facing down (parts that do not stand on the ground). */
  floor?: boolean
  /** The parts the faces and edges go to. */
  parts?: Partial<Record<'walls' | 'roofs' | 'floors' | 'edges', string>>
}

const EXTRUSION_PARTS = {
  walls: 'walls',
  roofs: 'roofs',
  floors: 'floors',
  edges: 'edges'
} as const

/** Points of the round caps of a ribbon. */
const CAP_SEGMENTS = 8

/** Points of draped shapes closer than 1/this of a cell are one vertex. */
const VERTEX_GRID = 2 ** 16

/**
 * What a layer draws one terrain tile with: the tile, its source features,
 * the ground, and primitives that put geometry on the terrain — draped on
 * it (`drapePolygon`, `drapeLine`, `drapePath`), standing on it
 * (`extrude`), or anywhere (`face`, `segment`, `add`). Coordinates are the
 * tile's local ones (scene units, x east, y north, z up), where the layer
 * places the tile's objects.
 *
 * Geometry goes into named parts — `'walls'`, `'roofs'`, `'surface'`… —
 * that each get a material and become one object per tile. Wrap what a
 * feature draws in `feature()` to pick and highlight it. Heights read here
 * are tracked: the tile is drawn again when they change, e.g. when a
 * neighbouring tile loads and the seams between them are stitched.
 */
export class TileContext<F> {
  readonly tile: Tile
  readonly map: Map
  readonly sources: readonly SourceFeatures<F>[]
  /** Scene units per meter, horizontally. */
  readonly unitsPerMeter: number
  /** Scene units per meter of height (`map.options.zScale`). */
  readonly zScale: number
  /** The tile itself: `[-tileSize / 2, -tileSize / 2, tileSize / 2, tileSize / 2]`. */
  readonly rect: Rect
  /** The features drawn, in order: `featureIndex` refers to them. */
  readonly features: F[] = []
  /** Objects added with `add()`, and the index of their feature. */
  readonly objects: { object: Object3D; feature: number }[] = []
  /** Keys of the tiles whose heights the drawing read. */
  readonly depends = new Set<string>()

  private readonly surfaces = new globalThis.Map<string, SurfaceBuilder>()
  private readonly lineParts = new globalThis.Map<string, LineBuilder>()
  private readonly instanceParts = new globalThis.Map<string, InstanceBuilder>()
  private readonly own: TileSurface
  private readonly ownKey: string
  /** The surfaces of the neighbours read, by offset (`'dx dy'`). */
  private readonly neighbours = new globalThis.Map<
    string,
    TileSurface | undefined
  >()
  private readonly point: SurfacePoint = { z: 0, nx: 0, ny: 0, nz: 1 }
  private current = -1
  private readonly metersPerTile: number

  private readonly shownParts = new globalThis.Map<string, boolean>()

  constructor(
    tile: Tile,
    sources: readonly SourceFeatures<F>[],
    /** Whether a part's material shows: hidden lines and copies are not built. */
    private readonly shown: (part: string, kind: 'faces' | 'lines') => boolean
  ) {
    this.tile = tile
    this.map = tile.map
    this.sources = sources
    const { tileSize, zScale } = this.map.options
    this.metersPerTile = Utils.tileWidth(this.map.geoLocation.lat, tile.z)
    this.unitsPerMeter = tileSize / this.metersPerTile
    this.zScale = zScale
    this.rect = [-tileSize / 2, -tileSize / 2, tileSize / 2, tileSize / 2]
    this.own = new TileSurface(tile)
    this.ownKey = tile.key()
  }

  /** The index of the feature being drawn, −1 outside `feature()`. */
  get featureIndex() {
    return this.current
  }

  /** The features of every source tile. */
  get allFeatures(): F[] {
    return this.sources.flatMap((source) => source.features)
  }

  // --- coordinates and the ground ---------------------------------------

  /** A `[lon, lat]` position in the tile's local coordinates. */
  toLocal([lon, lat]: Position): [number, number] {
    const { tileSize } = this.map.options
    const f = Utils.position2tileFraction(lat, lon, this.tile.z)
    return [
      (f.x - this.tile.x - 0.5) * tileSize,
      (0.5 - (f.y - this.tile.y)) * tileSize
    ]
  }

  /** UV of a local point in meters east and north, continuous across tiles. */
  planarUv(x: number, y: number): [number, number] {
    const { tileSize } = this.map.options
    const { minX, minY } = this.map.grid
    const gx = this.tile.x + x / tileSize + 0.5
    const gy = this.tile.y + 0.5 - y / tileSize
    return [(gx - minX) * this.metersPerTile, (minY - gy) * this.metersPerTile]
  }

  /**
   * The rendered surface at a local point — of the tile it lies in, if that
   * one is loaded — or `undefined`.
   */
  surfaceAt(x: number, y: number): SurfacePoint | undefined {
    return this.sampleAt(x, y, { z: 0, nx: 0, ny: 0, nz: 1 })
  }

  /**
   * Height of the rendered surface at a local point: of the tile it lies
   * in if loaded, else of this tile's nearest edge.
   */
  groundAt(x: number, y: number): number {
    const surface = this.sampleAt(x, y, this.point)
    if (surface) return surface.z
    const { tileSize } = this.map.options
    return this.tile.heightAt(x / tileSize + 0.5, 0.5 - y / tileSize)
  }

  /** `surfaceAt`, into `out`. */
  private sampleAt(
    x: number,
    y: number,
    out: SurfacePoint
  ): SurfacePoint | undefined {
    const { tileSize, tileSegments } = this.map.options
    const u = x / tileSize + 0.5
    const v = 0.5 - y / tileSize
    // the edges belong to this tile
    const dx = u >= 0 && u <= 1 ? 0 : Math.floor(u)
    const dy = v >= 0 && v <= 1 ? 0 : Math.floor(v)
    const surface = this.surfaceOf(dx, dy)
    return surface?.sample(
      (u - dx) * tileSegments,
      (v - dy) * tileSegments,
      out
    )
  }

  /** The surface of the tile `dx`, `dy` from this one if it is loaded; read from now on. */
  private surfaceOf(dx: number, dy: number): TileSurface | undefined {
    if (dx === 0 && dy === 0) {
      this.depends.add(this.ownKey)
      return this.tile.loaded ? this.own : undefined
    }
    const near = `${String(dx)} ${String(dy)}`
    if (!this.neighbours.has(near)) {
      const key = Utils.getTileKey(
        this.tile.z,
        this.tile.x + dx,
        this.tile.y + dy
      )
      this.depends.add(key)
      const tile = this.map.tileCache[key] as Tile | undefined
      this.neighbours.set(
        near,
        tile?.loaded ? new TileSurface(tile) : undefined
      )
    }
    return this.neighbours.get(near)
  }

  // --- parts and features -------------------------------------------------

  /** The faces of a part. */
  surface(part: string): SurfaceBuilder {
    let builder = this.surfaces.get(part)
    if (!builder) {
      builder = new SurfaceBuilder()
      this.surfaces.set(part, builder)
    }
    return builder
  }

  /**
   * Whether a part's material shows anything (its faces, or for copies their
   * outlines; `kind: 'lines'` its lines): what it hides need not be drawn —
   * the tile is drawn again when it shows. Hidden lines and copies are left
   * out by themselves.
   */
  visible(part: string, kind: 'faces' | 'lines' = 'faces'): boolean {
    const key = `${kind}:${part}`
    let shown = this.shownParts.get(key)
    if (shown === undefined) {
      shown = this.shown(part, kind)
      this.shownParts.set(key, shown)
    }
    return shown
  }

  /** The lines of a part, or `undefined` if its material does not show them. */
  lines(part: string): LineBuilder | undefined {
    if (!this.visible(part, 'lines')) return undefined
    let builder = this.lineParts.get(part)
    if (!builder) {
      builder = new LineBuilder()
      this.lineParts.set(part, builder)
    }
    return builder
  }

  /**
   * Copies of a geometry in a part — trees, lamps — drawn as one
   * `InstancedMesh` per tile: `add(matrix, color?)` places one (local
   * coordinates), belonging to the feature being drawn. The geometry is
   * shared, never disposed by the layer; give it a white `color` attribute
   * for the default materials, which multiply the vertex colors by the
   * copy's color (white by default) and the part's. Copies of a hidden
   * part are not made.
   */
  instances(
    part: string,
    geometry: BufferGeometry
  ): { add: (matrix: Matrix4, color?: Color) => void } {
    if (!this.visible(part)) return { add: () => undefined }
    let builder = this.instanceParts.get(part)
    if (!builder) {
      builder = new InstanceBuilder(geometry)
      this.instanceParts.set(part, builder)
    } else if (builder.geometry !== geometry) {
      throw new Error(`The part ${part} has copies of another geometry`)
    }
    const copies = builder
    return {
      add: (matrix, color) => {
        copies.add(matrix, color, this.current)
      }
    }
  }

  /** Everything built, by part. */
  get parts() {
    return {
      surfaces: this.surfaces,
      lines: this.lineParts,
      instances: this.instanceParts
    }
  }

  /**
   * Draws a feature: what `draw` adds belongs to it, for `pick()` and
   * `highlight()`. Returns `false` (and forgets it) if nothing was drawn.
   */
  feature(feature: F, draw: () => void): boolean {
    const previous = this.current
    const index = this.features.length
    this.features.push(feature)
    this.current = index
    const before = this.size()
    try {
      draw()
    } finally {
      this.current = previous
    }
    if (this.size() > before) return true
    if (this.features.length === index + 1) this.features.pop()
    return false
  }

  private size() {
    let size = this.objects.length
    for (const builder of this.surfaces.values()) size += builder.vertexCount
    for (const builder of this.lineParts.values()) size += builder.vertexCount
    for (const builder of this.instanceParts.values()) size += builder.count
    return size
  }

  /**
   * Adds any object — a model, an `InstancedMesh` — in local coordinates,
   * belonging to the feature being drawn. It is removed when the tile is
   * drawn again or removed; free its resources yourself if they are not
   * shared.
   */
  add(object: Object3D) {
    this.objects.push({ object, feature: this.current })
  }

  // --- primitives ---------------------------------------------------------

  /** A planar convex polygon `[x0, y0, z0, …]` facing `normal` (or its winding). */
  face(
    part: string,
    points: readonly number[],
    {
      color,
      normal,
      uv
    }: { color: Color; normal?: readonly number[]; uv?: UvMapping }
  ) {
    const n = points.length / 3
    if (n < 3) return
    // Newell's normal
    let [nx, ny, nz] = [0, 0, 0]
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const [ax, ay, az] = [points[3 * i], points[3 * i + 1], points[3 * i + 2]]
      const [bx, by, bz] = [points[3 * j], points[3 * j + 1], points[3 * j + 2]]
      nx += (ay - by) * (az + bz)
      ny += (az - bz) * (ax + bx)
      nz += (ax - bx) * (ay + by)
    }
    const length = Math.hypot(nx, ny, nz)
    if (length < 1e-12) return
    let flip = false
    if (normal && nx * normal[0] + ny * normal[1] + nz * normal[2] < 0) {
      flip = true
      ;[nx, ny, nz] = [-nx, -ny, -nz]
    }
    ;[nx, ny, nz] = [nx / length, ny / length, nz / length]

    const mapping = uv ?? this.faceUv(points, nx, ny, nz)
    const builder = this.surface(part)
    const first = builder.vertexCount
    for (let i = 0; i < n; i++) {
      const [x, y, z] = [points[3 * i], points[3 * i + 1], points[3 * i + 2]]
      const [u, v] = mapping(x, y, z)
      builder.vertex(x, y, z, nx, ny, nz, u, v, color, this.current)
    }
    for (let i = 1; i < n - 1; i++) {
      if (flip) builder.triangle(first, first + i + 1, first + i)
      else builder.triangle(first, first + i, first + i + 1)
    }
  }

  /** Meters in the face's plane: along its first edge, and across. */
  private faceUv(
    points: readonly number[],
    nx: number,
    ny: number,
    nz: number
  ): UvMapping {
    const { unitsPerMeter, zScale } = this
    // the face in meters; horizontal faces in map meters (no seams)
    if (Math.abs(nz) > 0.999) return (x, y) => this.planarUv(x, y)
    const meters = (dx: number, dy: number, dz: number) =>
      [dx / unitsPerMeter, dy / unitsPerMeter, dz / zScale] as const
    const [x0, y0, z0] = [points[0], points[1], points[2]]
    let [tx, ty, tz] = meters(points[3] - x0, points[4] - y0, points[5] - z0)
    const tl = Math.hypot(tx, ty, tz) || 1
    ;[tx, ty, tz] = [tx / tl, ty / tl, tz / tl]
    // across: the normal (in meters) × the edge
    const [mx, my, mz] = [nx * unitsPerMeter, ny * unitsPerMeter, nz * zScale]
    let [bx, by, bz] = [my * tz - mz * ty, mz * tx - mx * tz, mx * ty - my * tx]
    const bl = Math.hypot(bx, by, bz) || 1
    ;[bx, by, bz] = [bx / bl, by / bl, bz / bl]
    return (x, y, z) => {
      const [dx, dy, dz] = meters(x - x0, y - y0, z - z0)
      return [dx * tx + dy * ty + dz * tz, dx * bx + dy * by + dz * bz]
    }
  }

  /** A line from `a` to `b` (`[x, y, z]`), if the part is shown. */
  segment(
    part: string,
    a: readonly number[],
    b: readonly number[],
    color: Color
  ) {
    this.lines(part)?.segment(
      a[0],
      a[1],
      a[2],
      b[0],
      b[1],
      b[2],
      color,
      this.current
    )
  }

  /**
   * Polygons (outer ring, then holes; flat `[x0, y0, …]`, not closed)
   * extruded from `bottom` to `top` (scene z): walls, a roof, a floor with
   * `floor`, and the edges if their part is shown.
   */
  extrude(
    polygons: readonly (readonly FlatRing[])[],
    bottom: number,
    top: number,
    { color, lineColor = color, floor = false, parts = {} }: ExtrudeStyle
  ) {
    const names = { ...EXTRUSION_PARTS, ...parts }
    extrude(
      {
        walls: this.surface(names.walls),
        roofs: this.surface(names.roofs),
        floors: () => this.surface(names.floors),
        edges: this.lines(names.edges),
        color,
        lineColor,
        feature: this.current,
        unitsPerMeter: this.unitsPerMeter,
        zScale: this.zScale,
        planarUv: (x, y) => this.planarUv(x, y)
      },
      polygons,
      bottom,
      top,
      floor
    )
  }

  /**
   * A polygon (outer ring, then holes) draped on the terrain: cut along its
   * triangles, it lies exactly on the rendered surface and is lit like it.
   * Draw it with a material that has a polygon offset, as the default one.
   */
  drapePolygon(
    part: string,
    rings: readonly FlatRing[],
    style: ShapeStyle & { uv?: UvMapping }
  ) {
    const [minX, minY, maxX, maxY] = this.clipRect(style.clip)
    const [outerRing, ...holeRings] = rings.map((ring) =>
      clipRect(ring, minX, minY, maxX, maxY)
    )
    if (!isRing(outerRing)) return
    const clipped = [outerRing, ...holeRings.filter(isRing)]
    const points = (ring: readonly number[]) => {
      const out: Vector2[] = []
      for (let i = 0; i < ring.length; i += 2) {
        out.push(new Vector2(ring[i], ring[i + 1]))
      }
      return out
    }
    const [outer, ...holes] = clipped.map(points)
    // drops repeated end points: the points are listed afterwards
    const triangles = ShapeUtils.triangulateShape(outer, holes)
    const all = [outer, ...holes].flat()
    for (const [a, b, c] of triangles) {
      this.drapeConvex(
        part,
        [all[a].x, all[a].y, all[b].x, all[b].y, all[c].x, all[c].y],
        style
      )
    }
  }

  /**
   * A line `[x0, y0, …]` drawn as a ribbon `width` scene units wide draped
   * on the terrain, with round caps. Its UV: `u` across (0 left, 1 right),
   * `v` along in meters — a texture repeating per meter, e.g. markings.
   */
  drapeLine(
    part: string,
    line: readonly number[],
    width: number,
    { caps = true, ...style }: ShapeStyle & { caps?: boolean }
  ) {
    const half = width / 2
    if (!(half > 0) || line.length < 4) return
    const [minX, minY, maxX, maxY] = this.clipRect(style.clip)
    const { unitsPerMeter } = this
    // a frame along a segment: origin, direction, normal (left), meters
    const frame = (
      ax: number,
      ay: number,
      dx: number,
      dy: number,
      along: number
    ): UvMapping => {
      return (x, y) => [
        0.5 - ((x - ax) * -dy + (y - ay) * dx) / (2 * half),
        along + ((x - ax) * dx + (y - ay) * dy) / unitsPerMeter
      ]
    }
    const near = (xs: number[], ys: number[]) =>
      Math.min(...xs) - half <= maxX &&
      Math.max(...xs) + half >= minX &&
      Math.min(...ys) - half <= maxY &&
      Math.max(...ys) + half >= minY
    // a round cap: the half of a disc beyond the end, facing `dx`, `dy`
    // (the other half lies under the ribbon)
    const cap = (cx: number, cy: number, dx: number, dy: number) => {
      const polygon: number[] = []
      for (let k = 0; k <= CAP_SEGMENTS / 2; k++) {
        const angle = (2 * Math.PI * k) / CAP_SEGMENTS - Math.PI / 2
        const [along, across] = [Math.cos(angle) * half, Math.sin(angle) * half]
        polygon.push(
          cx + dx * along - dy * across,
          cy + dy * along + dx * across
        )
      }
      return polygon
    }

    let along = 0
    let previous: [number, number] | undefined
    let end:
      | { x: number; y: number; dx: number; dy: number; uv: UvMapping }
      | undefined
    for (let i = 0; i + 3 < line.length; i += 2) {
      const [ax, ay, bx, by] = [line[i], line[i + 1], line[i + 2], line[i + 3]]
      const length = Math.hypot(bx - ax, by - ay)
      if (length < 1e-9) continue
      const [dx, dy] = [(bx - ax) / length, (by - ay) / length]
      const uv = frame(ax, ay, dx, dy, along)
      const [nx, ny] = [-dy * half, dx * half]
      if (near([ax, bx], [ay, by])) {
        this.drapeConvex(
          part,
          [
            ax + nx,
            ay + ny,
            ax - nx,
            ay - ny,
            bx - nx,
            by - ny,
            bx + nx,
            by + ny
          ],
          { ...style, uv }
        )
        if (previous) {
          // a bevel fills the outer side of a bend: the right of a left
          // turn (the inner side is under both segments)
          const [px, py] = previous
          const turn = px * dy - py * dx
          if (Math.abs(turn) > 1e-4) {
            const side = turn > 0 ? -1 : 1
            this.drapeConvex(
              part,
              [
                ax,
                ay,
                ax - py * half * side,
                ay + px * half * side,
                ax + nx * side,
                ay + ny * side
              ],
              { ...style, uv }
            )
          }
        } else if (caps) {
          this.drapeConvex(part, cap(ax, ay, -dx, -dy), { ...style, uv })
        }
      }
      previous = [dx, dy]
      end = { x: bx, y: by, dx, dy, uv }
      along += length / unitsPerMeter
    }
    if (caps && end && near([end.x], [end.y])) {
      this.drapeConvex(part, cap(end.x, end.y, end.dx, end.dy), {
        ...style,
        uv: end.uv
      })
    }
  }

  /** A line `[x0, y0, …]` draped on the terrain as lines, if the part is shown. */
  drapePath(part: string, line: readonly number[], style: ShapeStyle) {
    const lines = this.lines(part)
    if (!lines) return
    const { tileSize, tileSegments: n } = this.map.options
    const rect = this.clipRect(style.clip)
    this.depends.add(this.ownKey)
    const point = this.point
    const sample = (col: number, row: number) => {
      this.own.sample(col, row, point)
      return [(col / n - 0.5) * tileSize, (0.5 - row / n) * tileSize, point.z]
    }
    for (let i = 0; i + 3 < line.length; i += 2) {
      const segment = clipSegment(
        line[i],
        line[i + 1],
        line[i + 2],
        line[i + 3],
        rect
      )
      if (!segment) continue
      const [ac, ar, bc, br] = [
        (segment[0] / tileSize + 0.5) * n,
        (0.5 - segment[1] / tileSize) * n,
        (segment[2] / tileSize + 0.5) * n,
        (0.5 - segment[3] / tileSize) * n
      ]
      const ts = gridCrossings(ac, ar, bc, br)
      let a = sample(ac, ar)
      for (let k = 1; k < ts.length; k++) {
        const t = ts[k]
        if (t - ts[k - 1] < 1e-12) continue
        const b = sample(ac + (bc - ac) * t, ar + (br - ar) * t)
        lines.segment(
          a[0],
          a[1],
          a[2],
          b[0],
          b[1],
          b[2],
          style.color,
          this.current
        )
        a = b
      }
    }
  }

  /**
   * A convex polygon `[x0, y0, …]` draped on the terrain (what
   * `drapePolygon` and `drapeLine` are made of).
   */
  drapeConvex(
    part: string,
    polygon: readonly number[],
    { color, clip, uv }: ShapeStyle & { uv?: UvMapping }
  ) {
    const { tileSize, tileSegments: n } = this.map.options
    const [minX, minY, maxX, maxY] = this.clipRect(clip)
    const grid: GridRect = [
      (minX / tileSize + 0.5) * n,
      (0.5 - maxY / tileSize) * n,
      (maxX / tileSize + 0.5) * n,
      (0.5 - minY / tileSize) * n
    ]
    if (!(grid[0] < grid[2] && grid[1] < grid[3])) return
    const cells: number[] = []
    for (let i = 0; i < polygon.length; i += 2) {
      cells.push(
        (polygon[i] / tileSize + 0.5) * n,
        (0.5 - polygon[i + 1] / tileSize) * n
      )
    }
    this.depends.add(this.ownKey)
    const builder = this.surface(part)
    const point = this.point
    // the pieces share the points of their cuts: one vertex each
    const vertices = new globalThis.Map<number, number>()
    const vertex = (col: number, row: number) => {
      const key =
        Math.round(col * VERTEX_GRID) * 2 ** 25 + Math.round(row * VERTEX_GRID)
      const known = vertices.get(key)
      if (known !== undefined) return known
      const x = (col / n - 0.5) * tileSize
      const y = (0.5 - row / n) * tileSize
      this.own.sample(col, row, point)
      const [u, v] = uv ? uv(x, y, point.z) : this.planarUv(x, y)
      const index = builder.vertex(
        x,
        y,
        point.z,
        point.nx,
        point.ny,
        point.nz,
        u,
        v,
        color,
        this.current
      )
      vertices.set(key, index)
      return index
    }
    const indices: number[] = []
    cutPolygon(cells, grid, (piece, length) => {
      indices.length = 0
      for (let i = 0; i < length; i += 2) {
        const index = vertex(piece[i], piece[i + 1])
        if (index !== indices.at(-1) && index !== indices[0])
          indices.push(index)
      }
      // rows go south: counter-clockwise in the grid is clockwise in the scene
      const reverse = polygonArea(piece, 2, length) > 0
      for (let i = 1; i < indices.length - 1; i++) {
        if (reverse) builder.triangle(indices[0], indices[i + 1], indices[i])
        else builder.triangle(indices[0], indices[i], indices[i + 1])
      }
    })
  }

  /** The tile, cut down to `clip`. */
  private clipRect(clip?: Rect): Rect {
    const [minX, minY, maxX, maxY] = this.rect
    if (!clip) return this.rect
    return [
      Math.max(minX, clip[0]),
      Math.max(minY, clip[1]),
      Math.min(maxX, clip[2]),
      Math.min(maxY, clip[3])
    ]
  }
}

/** The part of a segment inside a rectangle (Liang–Barsky), or `undefined`. */
function clipSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  [minX, minY, maxX, maxY]: Rect
): [number, number, number, number] | undefined {
  const [dx, dy] = [bx - ax, by - ay]
  let [t0, t1] = [0, 1]
  for (const [p, q] of [
    [-dx, ax - minX],
    [dx, maxX - ax],
    [-dy, ay - minY],
    [dy, maxY - ay]
  ]) {
    if (p === 0) {
      if (q < 0) return undefined
      continue
    }
    const r = q / p
    if (p < 0) t0 = Math.max(t0, r)
    else t1 = Math.min(t1, r)
    if (t0 > t1) return undefined
  }
  return [ax + dx * t0, ay + dy * t0, ax + dx * t1, ay + dy * t1]
}

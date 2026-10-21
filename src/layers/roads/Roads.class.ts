import { Color, type ColorRepresentation, type Material } from 'three'

import {
  type BridgeChain,
  type BridgePiece,
  clipLine,
  clipSegmentT,
  deckAt,
  deckProfile,
  type DeckProfile,
  joinBridges,
  lengthTo,
  RAMP_GRADE
} from './bridges'
import {
  LINK_WIDTH,
  ROAD_KINDS,
  ROAD_WIDTHS,
  type RoadFeature,
  type RoadKind
} from './features'
import { RoadSource, type RoadSourceProps } from './RoadSource.class'
import { clipToRect } from '../drape'
import {
  type DrawFeatures,
  type FeatureHit,
  FeatureLayer,
  type LayerMaterial,
  type Look
} from '../FeatureLayer.class'
import type { Rect, TileContext, UvMapping } from '../TileContext.class'
import { Utils } from '../../geo/Utils.class'
import type { SourceTileKey } from '../../sources/source-tiles'
import type { Tile } from '../../terrain/Tile.class'

export interface RoadsOptions {
  /** Where the roads come from: a `RoadSource`, or the props to create one. */
  source: RoadSource | RoadSourceProps
  /**
   * How the roads are drawn: the look — by default the map's, the roads in
   * a darker shade of its color, bridges in its color — one material for
   * every face, or a material per part: `'surface'` and `'rails'` (roads
   * and railways on the terrain; give them a polygon offset), `'deck'` (the
   * top of bridges),
   * `'structure'` (their sides, bottom and piers), `'lines'` (center lines
   * and outlines). Roads and decks have UVs `u` across (0 to 1), `v` along
   * in meters: a texture with markings repeats along them.
   */
  material?: LayerMaterial
  /** Replaces or extends the roads' geometry. See `FeatureLayer`. */
  build?: (
    ctx: TileContext<RoadFeature>,
    draw: DrawFeatures<RoadFeature>
  ) => void
  /** The kinds of road drawn; all by default. */
  kinds: readonly RoadKind[]
  /** Meters across by kind, for roads the source gives no width. */
  widths: Partial<Record<RoadKind, number>>
  /**
   * Draw bridges as decks at their own height — over valleys, roads and
   * rivers, on piers — or, `false`, on the terrain like the other roads.
   */
  bridges: boolean
  /** Color `highlight()` uses by default. */
  highlightColor: ColorRepresentation
  /** Terrain tiles below this zoom get no roads. */
  minZoom: number
}

export const defaultRoadsOptions: Readonly<
  Omit<RoadsOptions, 'source' | 'material' | 'build'>
> = Object.freeze({
  kinds: ROAD_KINDS,
  widths: {},
  bridges: true,
  highlightColor: 0xffb020,
  minZoom: 12
})

/** The road under a ray: the feature and where it was hit. */
export type RoadHit = FeatureHit<RoadFeature>

/** Roads: the look's color times this; bridges keep it. */
const ROAD_SHADE = 0.8
const WHITE = new Color(0xffffff)
/** Draped roads are drawn this far in front of the terrain (depth units). */
const SURFACE_OFFSET = { factor: -1, units: -4 }
/** Meters a deck is thick. */
const DECK_DEPTH = 1.2
/** Least meters a deck stays above the ground, reached ramping up from its ends. */
const CLEARANCE = 5
/** A pier every this many meters, where the deck is this high above the ground. */
const PIER_SPACING = 40
const PIER_MIN_HEIGHT = 3
/** A pier's size: meters along the bridge, and its share of the width across. */
const PIER_ALONG = 1.5
const PIER_ACROSS = 0.6
/** Meters piers reach below the ground. */
const FOUNDATION = 0.5
/** Meters within which the ends of bridge pieces meet. */
const JOIN_TOLERANCE = 1.5
/** Miters of decks are at most this many half widths long. */
const MITER_LIMIT = 2

/** A road's lines in map units (tiles at the map's zoom), and their bounds. */
interface Prepared {
  zoom: number
  lines: Float64Array[]
  bbox: [number, number, number, number]
}

/** A point of a deck: on its center line, with its left and right edges. */
interface DeckPoint {
  x: number
  y: number
  /** Meters along the bridge. */
  s: number
  /** The top of the deck (scene units). */
  z: number
  lx: number
  ly: number
  rx: number
  ry: number
  /** The road of the segment starting here. */
  feature: RoadFeature
}

interface Pier {
  feature: RoadFeature
  /** Footprint corners `[x0, y0, …]` in map units. */
  corners: number[]
  x: number
  y: number
  bottom: number
  top: number
}

/** A bridge ready to draw, in map units. */
interface Deck {
  points: DeckPoint[]
  piers: Pier[]
  bbox: [number, number, number, number]
  /** Changes when the deck does: tiles drawing it are drawn again. */
  signature: string
}

/**
 * Roads and railways on the terrain: `map.addLayer(new Roads({ source: {
 * api: 'openfreemap' } }))`. Every terrain tile draws the part of the roads
 * in it as ribbons cut along the terrain's triangles, lying exactly on its
 * surface. Bridges are decks at their own height: joined across tiles,
 * stretched over the ground between their ends, on piers. Tunnels are not
 * drawn.
 */
export class Roads extends FeatureLayer<RoadFeature> {
  declare readonly source: RoadSource
  readonly options: Omit<RoadsOptions, 'source'>

  private readonly kinds: ReadonlySet<RoadKind>
  private readonly prepared = new WeakMap<RoadFeature, Prepared>()
  /** Bridge pieces by source tile. */
  private readonly pieces = new globalThis.Map<string, BridgePiece[]>()
  private decks: Deck[] = []
  private decksDirty = false
  /** The signature of the decks each tile drew. */
  private readonly drawnDecks = new globalThis.Map<Tile, string>()

  constructor({
    source,
    ...props
  }: Pick<RoadsOptions, 'source'> & Partial<RoadsOptions>) {
    const options = { ...defaultRoadsOptions, ...props }
    super({
      source: source instanceof RoadSource ? source : new RoadSource(source),
      build: options.build,
      material: options.material,
      highlightColor: options.highlightColor,
      minZoom: options.minZoom,
      name: 'roads'
    })
    this.options = options
    this.kinds = new Set(options.kinds)
  }

  /** Meters across a road. */
  width(feature: RoadFeature): number {
    if (feature.width !== undefined && feature.width > 0) return feature.width
    const width = this.options.widths[feature.kind] ?? ROAD_WIDTHS[feature.kind]
    return feature.link ? width * LINK_WIDTH : width
  }

  // --- the terrain and the bridges spanning it ----------------------------

  override tileLoaded(tile: Tile) {
    super.tileLoaded(tile)
    this.groundChanged()
  }

  override tileChanged(tile: Tile) {
    super.tileChanged(tile)
    this.groundChanged()
  }

  override tileRemoved(tile: Tile) {
    super.tileRemoved(tile)
    this.drawnDecks.delete(tile)
    this.groundChanged()
  }

  private groundChanged() {
    if (this.pieces.size === 0) return
    this.decksDirty = true
    this.schedule()
  }

  protected override sourceLoaded(
    key: SourceTileKey,
    features: readonly RoadFeature[]
  ) {
    if (!this.options.bridges || !this.map || this.pieces.has(key.key)) return
    const pieces = features.flatMap((feature) =>
      feature.bridge && !feature.tunnel && this.kinds.has(feature.kind)
        ? this.bridgePieces(feature, key)
        : []
    )
    this.pieces.set(key.key, pieces)
    if (pieces.length > 0) {
      this.decksDirty = true
      this.schedule()
    }
  }

  protected override sourceDropped(key: string) {
    const pieces = this.pieces.get(key)
    this.pieces.delete(key)
    if (pieces && pieces.length > 0) {
      this.decksDirty = true
      this.schedule()
    }
  }

  /** The lines of a bridge cut to its source tile, in map units. */
  private bridgePieces(feature: RoadFeature, { z, x, y }: SourceTileKey) {
    const zoom = this.map?.options.zoom ?? z
    const scale = 2 ** (zoom - z)
    const rect: Rect = [x * scale, y * scale, (x + 1) * scale, (y + 1) * scale]
    const pieces: BridgePiece[] = []
    for (const line of this.lines(feature).lines) {
      for (const run of clipLine(line, rect)) {
        pieces.push({ feature, points: run.points, cut: run.cut })
      }
    }
    return pieces
  }

  protected override prepare() {
    if (!this.decksDirty || !this.map) return
    this.decksDirty = false
    this.decks = this.buildDecks()
    for (const tile of this.loadedTiles) {
      if (this.deckSignature(tile) !== this.drawnDecks.get(tile)) {
        this.invalidate([tile])
      }
    }
  }

  private deckSignature(tile: Tile) {
    return this.decks
      .filter((deck) => overlaps(deck.bbox, tileRect(tile)))
      .map((deck) => deck.signature)
      .join('|')
  }

  /** The rendered surface at a point in map units, if its tile is loaded. */
  private groundAt(x: number, y: number): number | undefined {
    const map = this.map
    if (!map) return undefined
    const tile = map.tileCache[
      Utils.getTileKey(map.options.zoom, Math.floor(x), Math.floor(y))
    ] as Tile | undefined
    if (!tile?.loaded || tile.mesh.parent !== map.terrain) return undefined
    return tile.heightAt(x - tile.x, y - tile.y)
  }

  private buildDecks(): Deck[] {
    const map = this.map
    if (!map) return []
    const { zoom, tileSegments, zScale } = map.options
    const meters = Utils.tileWidth(map.geoLocation.lat, zoom)
    const chains = joinBridges(
      [...this.pieces.values()].flat(),
      JOIN_TOLERANCE / meters,
      meters
    )
    // the terrain is piecewise linear: twice per cell finds its shape
    const step = Math.max(1, meters / tileSegments / 2)
    // ramps (on another bridge) after the bridges they join
    const profiles = new globalThis.Map<BridgeChain, DeckProfile | undefined>()
    for (let pass = 0; pass < 3; pass++) {
      for (const chain of chains) {
        profiles.set(chain, this.profile(chain, profiles, meters, step, zScale))
      }
    }
    return chains.flatMap((chain) => {
      const profile = profiles.get(chain)
      return profile ? [this.deck(chain, profile, meters, zScale)] : []
    })
  }

  private halfWidth(feature: RoadFeature, meters: number) {
    return this.width(feature) / 2 / meters
  }

  private profile(
    chain: BridgeChain,
    profiles: ReadonlyMap<BridgeChain, DeckProfile | undefined>,
    meters: number,
    step: number,
    zScale: number
  ): DeckProfile | undefined {
    const { points, features } = chain
    const length = lengthTo(points, points.length - 2, meters)
    const samples: { s: number; ground: number | undefined }[] = []
    let along = 0
    for (let i = 0; i + 3 < points.length; i += 2) {
      const [ax, ay, bx, by] = [
        points[i],
        points[i + 1],
        points[i + 2],
        points[i + 3]
      ]
      const segment = Math.hypot(bx - ax, by - ay)
      if (segment === 0) continue
      const [dx, dy] = [(bx - ax) / segment, (by - ay) / segment]
      const half = this.halfWidth(features[i / 2], meters)
      const n = Math.max(1, Math.ceil((segment * meters) / step))
      for (let k = i === 0 ? 0 : 1; k <= n; k++) {
        const t = k / n
        const [x, y] = [ax + (bx - ax) * t, ay + (by - ay) * t]
        const center = this.groundAt(x, y)
        // across the deck: it rests on the highest ground under it
        const sides = [
          this.groundAt(x - dy * half, y + dx * half),
          this.groundAt(x + dy * half, y - dx * half)
        ].filter((z): z is number => z !== undefined)
        samples.push({
          s: along + segment * t * meters,
          ground: center === undefined ? undefined : Math.max(center, ...sides)
        })
      }
      along += segment * meters
    }

    const endHeight = (end: 0 | 1) => {
      const at = chain.ends[end]
      const i = end === 0 ? 0 : points.length - 2
      if (at.type === 'ground') return this.groundAt(points[i], points[i + 1])
      if (at.type === 'on') {
        const other = profiles.get(at.bridge)
        return other && deckAt(other, at.s)
      }
      return undefined
    }
    const [start, end] = [endHeight(0), endHeight(1)]
    const fixed = [
      start === undefined ? undefined : 0,
      end === undefined ? undefined : length
    ].filter((s): s is number => s !== undefined)
    const over = deckProfile(samples, length, {
      start,
      end,
      clearance: () => 0
    })
    // a bridge that clears nothing on this terrain — an overpass where the
    // elevation has no embankments — rises to the clearance from its ends
    const clears = (profile: DeckProfile) =>
      samples.some(
        ({ s, ground }) =>
          ground !== undefined &&
          deckAt(profile, s) - ground >= CLEARANCE * zScale - 1e-9
      )
    if (!over || clears(over)) return over
    return deckProfile(samples, length, {
      start,
      end,
      clearance: (s) =>
        Math.min(
          CLEARANCE,
          ...fixed.map((at) => RAMP_GRADE * Math.abs(s - at))
        ) * zScale
    })
  }

  /** The deck's points — the bridge's and the profile's bends — and piers. */
  private deck(
    chain: BridgeChain,
    profile: DeckProfile,
    meters: number,
    zScale: number
  ): Deck {
    const { points, features } = chain
    const count = points.length / 2
    const vertexS: number[] = [0]
    for (let i = 1; i < count; i++) {
      vertexS.push(
        vertexS[i - 1] +
          Math.hypot(
            points[2 * i] - points[2 * i - 2],
            points[2 * i + 1] - points[2 * i - 1]
          ) *
            meters
      )
    }
    const length = vertexS[count - 1]
    const direction = (i: number) => {
      const [dx, dy] = [
        points[2 * i + 2] - points[2 * i],
        points[2 * i + 3] - points[2 * i + 1]
      ]
      const d = Math.hypot(dx, dy) || 1
      return [dx / d, dy / d]
    }

    const deckPoints: DeckPoint[] = []
    const at = (s: number, i: number, vertex: boolean) => {
      const t =
        vertexS[i + 1] === vertexS[i]
          ? 0
          : (s - vertexS[i]) / (vertexS[i + 1] - vertexS[i])
      const x = points[2 * i] + (points[2 * i + 2] - points[2 * i]) * t
      const y = points[2 * i + 1] + (points[2 * i + 3] - points[2 * i + 1]) * t
      let [dx, dy] = direction(i)
      let half = this.halfWidth(features[i], meters)
      let scale = 1
      if (vertex && i > 0) {
        // a miter between the segments
        const [px, py] = direction(i - 1)
        const [mx, my] = [px + dx, py + dy]
        const m = Math.hypot(mx, my)
        if (m > 1e-9) {
          scale = Math.min(
            MITER_LIMIT,
            1 / Math.max((mx * dx + my * dy) / m, 1e-9)
          )
          ;[dx, dy] = [mx / m, my / m]
        }
        half = Math.max(half, this.halfWidth(features[i - 1], meters))
      }
      const [nx, ny] = [-dy * half * scale, dx * half * scale]
      deckPoints.push({
        x,
        y,
        s,
        z: deckAt(profile, s),
        lx: x + nx,
        ly: y + ny,
        rx: x - nx,
        ry: y - ny,
        feature: features[Math.min(i, features.length - 1)]
      })
    }
    for (let i = 0; i < count - 1; i++) {
      at(vertexS[i], i, true)
      for (const s of profile.s) {
        if (s > vertexS[i] + 1e-6 && s < vertexS[i + 1] - 1e-6) at(s, i, false)
      }
    }
    at(length, count - 2, false)
    // the last point ends the last segment: its normal is that segment's

    const piers: Pier[] = []
    const n = Math.floor(length / PIER_SPACING)
    for (let k = 1; k <= n; k++) {
      const s = (length * k) / (n + 1)
      const i = Math.max(0, vertexS.findIndex((v) => v > s) - 1)
      const t = (s - vertexS[i]) / (vertexS[i + 1] - vertexS[i] || 1)
      const x = points[2 * i] + (points[2 * i + 2] - points[2 * i]) * t
      const y = points[2 * i + 1] + (points[2 * i + 3] - points[2 * i + 1]) * t
      const [dx, dy] = direction(i)
      const along = PIER_ALONG / 2 / meters
      const across = this.halfWidth(features[i], meters) * PIER_ACROSS
      const corners = [
        x + dx * along - dy * across,
        y + dy * along + dx * across,
        x - dx * along - dy * across,
        y - dy * along + dx * across,
        x - dx * along + dy * across,
        y - dy * along - dx * across,
        x + dx * along + dy * across,
        y + dy * along - dx * across
      ]
      const grounds = [this.groundAt(x, y)]
      for (let c = 0; c < 8; c += 2)
        grounds.push(this.groundAt(corners[c], corners[c + 1]))
      if (grounds.some((z) => z === undefined)) continue
      const low = Math.min(...(grounds as number[]))
      const top = deckAt(profile, s) - DECK_DEPTH * zScale
      if (top - low < PIER_MIN_HEIGHT * zScale) continue
      piers.push({
        feature: features[i],
        corners,
        x,
        y,
        bottom: low - FOUNDATION * zScale,
        top
      })
    }

    const bbox: [number, number, number, number] = [
      Infinity,
      Infinity,
      -Infinity,
      -Infinity
    ]
    for (const p of deckPoints) {
      for (const [x, y] of [
        [p.lx, p.ly],
        [p.rx, p.ry]
      ]) {
        bbox[0] = Math.min(bbox[0], x)
        bbox[1] = Math.min(bbox[1], y)
        bbox[2] = Math.max(bbox[2], x)
        bbox[3] = Math.max(bbox[3], y)
      }
    }
    const signature = [
      ...deckPoints.map(
        (p) => `${p.x.toFixed(9)},${p.y.toFixed(9)},${p.z.toFixed(4)}`
      ),
      ...piers.map((p) => `${p.x.toFixed(9)},${p.bottom.toFixed(4)}`)
    ].join(';')
    return { points: deckPoints, piers, bbox, signature }
  }

  // --- drawing ------------------------------------------------------------

  /** Draped roads are pulled in front of the terrain they lie on. */
  protected override createMaterial(
    part: string,
    kind: 'faces' | 'lines',
    look: Look
  ): Material {
    const material = super.createMaterial(part, kind, look)
    if (kind === 'faces' && (part === 'surface' || part === 'rails')) {
      material.polygonOffset = true
      material.polygonOffsetFactor = SURFACE_OFFSET.factor
      material.polygonOffsetUnits = SURFACE_OFFSET.units
    }
    return material
  }

  /**
   * Roads in the layer's own color, or a shade of the look's; the bridges'
   * structure in the map's color.
   */
  protected override partColor(
    part: string,
    _kind: 'faces' | 'lines',
    look: Look
  ): ColorRepresentation {
    if (part === 'structure') {
      return this.map?.materialOptions.color ?? look.color ?? 0xffffff
    }
    return (
      this.ownLook.color ??
      new Color(look.color ?? 0xffffff).multiplyScalar(ROAD_SHADE)
    )
  }

  protected override draw(
    ctx: TileContext<RoadFeature>,
    features: readonly RoadFeature[]
  ) {
    // the parts' materials have the colors
    const [road, structure] = [WHITE, WHITE]
    const wanted = new Set(features)
    const { tile } = ctx
    const { tileSize } = ctx.map.options
    const toLocal = (line: Float64Array) => {
      const local: number[] = []
      for (let i = 0; i < line.length; i += 2) {
        local.push(
          (line[i] - tile.x - 0.5) * tileSize,
          (0.5 - (line[i + 1] - tile.y)) * tileSize
        )
      }
      return local
    }

    for (const source of ctx.sources) {
      const clip = source.rect
      const bounds = toMapRect(clip, tile)
      for (const feature of source.features) {
        if (
          !wanted.has(feature) ||
          feature.tunnel ||
          !this.kinds.has(feature.kind)
        )
          continue
        if (feature.bridge && this.options.bridges) continue
        const prepared = this.lines(feature)
        const width = this.width(feature)
        // half the width, in map units
        const reach = ((width / 2) * ctx.unitsPerMeter) / tileSize
        if (!overlaps(grow(prepared.bbox, reach), bounds)) continue
        // railways apart: they look different
        const part = feature.kind === 'rail' ? 'rails' : 'surface'
        ctx.feature(feature, () => {
          for (const line of prepared.lines) {
            const local = toLocal(line)
            ctx.drapeLine(part, local, width * ctx.unitsPerMeter, {
              color: road,
              clip
            })
            ctx.drapePath('lines', local, { color: road, clip })
          }
        })
      }
    }

    const rect = tileRect(tile)
    for (const deck of this.decks) {
      if (overlaps(deck.bbox, rect))
        this.drawDeck(ctx, deck, wanted, { road, structure })
    }
    this.drawnDecks.set(tile, this.deckSignature(tile))
  }

  /** A road's lines in map units, cached. */
  private lines(feature: RoadFeature): Prepared {
    const zoom = this.map?.options.zoom ?? 0
    const cached = this.prepared.get(feature)
    if (cached?.zoom === zoom) return cached
    const { geometry } = feature
    const lines =
      geometry.type === 'LineString'
        ? [geometry.coordinates]
        : geometry.coordinates
    const bbox: [number, number, number, number] = [
      Infinity,
      Infinity,
      -Infinity,
      -Infinity
    ]
    const prepared: Prepared = {
      zoom,
      bbox,
      lines: lines.map((line) => {
        const flat = new Float64Array(line.length * 2)
        for (const [i, [lon, lat]] of line.entries()) {
          const f = Utils.position2tileFraction(lat, lon, zoom)
          flat[2 * i] = f.x
          flat[2 * i + 1] = f.y
          bbox[0] = Math.min(bbox[0], f.x)
          bbox[1] = Math.min(bbox[1], f.y)
          bbox[2] = Math.max(bbox[2], f.x)
          bbox[3] = Math.max(bbox[3], f.y)
        }
        return flat
      })
    }
    this.prepared.set(feature, prepared)
    return prepared
  }

  private drawDeck(
    ctx: TileContext<RoadFeature>,
    deck: Deck,
    wanted: ReadonlySet<RoadFeature>,
    { road, structure }: { road: Color; structure: Color }
  ) {
    const { tile, map } = ctx
    const { tileSize } = map.options
    const local = (x: number, y: number) =>
      [(x - tile.x - 0.5) * tileSize, (0.5 - (y - tile.y)) * tileSize] as const
    const rect = ctx.rect
    const depth = DECK_DEPTH * ctx.zScale
    const { points } = deck
    const last = points.length - 1
    // the sides of the tile no neighbour continues: the deck's section shows
    const open = sides(ctx)

    // the segments and piers of each road of the bridge
    const byFeature = new globalThis.Map<
      RoadFeature,
      { segments: number[]; piers: Pier[] }
    >()
    const of = (feature: RoadFeature) => {
      let entry = byFeature.get(feature)
      if (!entry) {
        entry = { segments: [], piers: [] }
        byFeature.set(feature, entry)
      }
      return entry
    }
    for (let i = 0; i < last; i++) of(points[i].feature).segments.push(i)
    for (const pier of deck.piers) {
      const inside =
        pier.x >= tile.x &&
        pier.x < tile.x + 1 &&
        pier.y >= tile.y &&
        pier.y < tile.y + 1
      if (inside) of(pier.feature).piers.push(pier)
    }

    for (const [feature, { segments, piers }] of byFeature) {
      if (!wanted.has(feature)) continue
      ctx.feature(feature, () => {
        for (const i of segments) {
          const [a, b] = [points[i], points[i + 1]]
          const [al, bl, br, ar] = [
            local(a.lx, a.ly),
            local(b.lx, b.ly),
            local(b.rx, b.ry),
            local(a.rx, a.ry)
          ]
          const top = clipToRect(
            [
              al[0],
              al[1],
              a.z,
              bl[0],
              bl[1],
              b.z,
              br[0],
              br[1],
              b.z,
              ar[0],
              ar[1],
              a.z
            ],
            rect,
            3
          )
          if (top.length < 9) continue
          // u across, v along in meters
          const [ca, cb] = [local(a.x, a.y), local(b.x, b.y)]
          const length = Math.hypot(cb[0] - ca[0], cb[1] - ca[1]) || 1
          const [dx, dy] = [(cb[0] - ca[0]) / length, (cb[1] - ca[1]) / length]
          const half = Math.hypot(al[0] - ca[0], al[1] - ca[1]) || 1
          const uv: UvMapping = (x, y) => [
            0.5 - ((x - ca[0]) * -dy + (y - ca[1]) * dx) / (2 * half),
            a.s + ((x - ca[0]) * dx + (y - ca[1]) * dy) / ctx.unitsPerMeter
          ]
          ctx.face('deck', top, { color: road, normal: [0, 0, 1], uv })
          const bottom = top.map((value, k) =>
            k % 3 === 2 ? value - depth : value
          )
          ctx.face('structure', bottom, {
            color: structure,
            normal: [0, 0, -1]
          })

          // the sides
          for (const [p, q] of [
            [al, bl],
            [ar, br]
          ] as const) {
            const cut = clipSegmentT(p[0], p[1], q[0], q[1], rect)
            if (!cut) continue
            const [t0, t1] = cut
            const point = (t: number) =>
              [
                p[0] + (q[0] - p[0]) * t,
                p[1] + (q[1] - p[1]) * t,
                a.z + (b.z - a.z) * t
              ] as const
            const [u, v] = [point(t0), point(t1)]
            const outward = [p[0] - ca[0], p[1] - ca[1], 0]
            ctx.face(
              'structure',
              [
                u[0],
                u[1],
                u[2],
                v[0],
                v[1],
                v[2],
                v[0],
                v[1],
                v[2] - depth,
                u[0],
                u[1],
                u[2] - depth
              ],
              { color: structure, normal: outward }
            )
            ctx.segment('lines', u, v, road)
            ctx.segment(
              'lines',
              [u[0], u[1], u[2] - depth],
              [v[0], v[1], v[2] - depth],
              road
            )
          }

          // where the deck is cut: at the ends of the bridge, and at the
          // edges of tiles that no neighbour continues
          const n = top.length / 3
          for (let k = 0; k < n; k++) {
            const j = (k + 1) % n
            const [px, py, pz, qx, qy, qz] = [
              top[3 * k],
              top[3 * k + 1],
              top[3 * k + 2],
              top[3 * j],
              top[3 * j + 1],
              top[3 * j + 2]
            ]
            const side = open.find(({ on }) => on(px, py) && on(qx, qy))
            const end =
              (i === 0 && onSegment(px, py, qx, qy, al, ar)) ||
              (i === last - 1 && onSegment(px, py, qx, qy, bl, br))
            if (!side && !end) continue
            const normal = side
              ? side.normal
              : i === 0
                ? [-dx, -dy, 0]
                : [dx, dy, 0]
            ctx.face(
              'structure',
              [px, py, pz, qx, qy, qz, qx, qy, qz - depth, px, py, pz - depth],
              { color: structure, normal }
            )
          }
        }

        for (const pier of piers) {
          const corners: (readonly [number, number])[] = []
          for (let c = 0; c < 8; c += 2)
            corners.push(local(pier.corners[c], pier.corners[c + 1]))
          const [cx, cy] = local(pier.x, pier.y)
          for (let c = 0; c < 4; c++) {
            const [p, q] = [corners[c], corners[(c + 1) % 4]]
            ctx.face(
              'structure',
              [
                p[0],
                p[1],
                pier.bottom,
                q[0],
                q[1],
                pier.bottom,
                q[0],
                q[1],
                pier.top,
                p[0],
                p[1],
                pier.top
              ],
              {
                color: structure,
                normal: [(p[0] + q[0]) / 2 - cx, (p[1] + q[1]) / 2 - cy, 0]
              }
            )
            ctx.segment(
              'lines',
              [p[0], p[1], pier.bottom],
              [p[0], p[1], pier.top],
              road
            )
          }
        }
      })
    }
  }
}

/** A tile in map units. */
const tileRect = (tile: Tile): Rect => [tile.x, tile.y, tile.x + 1, tile.y + 1]

/** A rectangle in a tile's local coordinates, in map units. */
function toMapRect([minX, minY, maxX, maxY]: Rect, tile: Tile): Rect {
  const { tileSize } = tile.map.options
  return [
    tile.x + 0.5 + minX / tileSize,
    tile.y + 0.5 - maxY / tileSize,
    tile.x + 0.5 + maxX / tileSize,
    tile.y + 0.5 - minY / tileSize
  ]
}

const overlaps = (a: Rect, b: Rect) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]

const grow = ([minX, minY, maxX, maxY]: Rect, by: number): Rect => [
  minX - by,
  minY - by,
  maxX + by,
  maxY + by
]

/** Whether segment `p`–`q` lies on the line through `a` and `b`. */
function onSegment(
  px: number,
  py: number,
  qx: number,
  qy: number,
  a: readonly [number, number],
  b: readonly [number, number]
) {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const length = Math.hypot(dx, dy)
  if (length === 0) return false
  const distance = (x: number, y: number) =>
    Math.abs((x - a[0]) * dy - (y - a[1]) * dx) / length
  return distance(px, py) < length * 1e-6 && distance(qx, qy) < length * 1e-6
}

/** The sides of a tile with no placed neighbour: a cut deck shows there. */
function sides(ctx: TileContext<RoadFeature>) {
  const { tile, map, rect } = ctx
  const [minX, minY, maxX, maxY] = rect
  const epsilon = (maxX - minX) * 1e-9
  const all = [
    {
      dx: -1,
      dy: 0,
      normal: [-1, 0, 0],
      on: (x: number) => Math.abs(x - minX) < epsilon
    },
    {
      dx: 1,
      dy: 0,
      normal: [1, 0, 0],
      on: (x: number) => Math.abs(x - maxX) < epsilon
    },
    {
      dx: 0,
      dy: 1,
      normal: [0, -1, 0],
      on: (_: number, y: number) => Math.abs(y - minY) < epsilon
    },
    {
      dx: 0,
      dy: -1,
      normal: [0, 1, 0],
      on: (_: number, y: number) => Math.abs(y - maxY) < epsilon
    }
  ]
  return all.filter(({ dx, dy }) => {
    const key = Utils.getTileKey(tile.z, tile.x + dx, tile.y + dy)
    // drawn again when that neighbour loads
    ctx.depends.add(key)
    const neighbour = map.tileCache[key] as Tile | undefined
    return !(neighbour?.loaded && neighbour.mesh.parent === map.terrain)
  })
}

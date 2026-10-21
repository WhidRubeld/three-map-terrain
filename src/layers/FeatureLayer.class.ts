import {
  type BufferAttribute,
  BufferGeometry,
  Color,
  type ColorRepresentation,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  type Intersection,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Object3D,
  type Raycaster,
  Vector3
} from 'three'

import { isAbortError } from '../io/fetch'
import type { FeatureSource } from '../sources/feature-source'
import { type SourceTileKey, SourceTiles } from '../sources/source-tiles'
import type { GeoLocation, Map, MapLayer } from '../terrain/Map.class'
import type { MaterialOptions } from '../terrain/material'
import type { Tile } from '../terrain/Tile.class'
import { Footprint } from './footprint'
import { FEATURE_ATTRIBUTE } from './geometry'
import { Utils } from '../geo/Utils.class'
import {
  addDrawer,
  type Drawer,
  type DrawJob,
  kick,
  removeDrawer,
  sliced
} from './scheduler'
import {
  type Rect,
  type SourceFeatures,
  TileContext
} from './TileContext.class'

/**
 * How a layer's parts are drawn: the look (the map's material options —
 * `color`, `lights`, `wireframe`, `fillOpacity`, `fog` — overridden by
 * these), one material for its faces, or a material per part (`undefined`:
 * the look's). Materials you pass are yours: the layer never disposes them.
 */
export type LayerMaterial =
  Partial<MaterialOptions> | Material | ((part: string) => Material | undefined)

/** Draws the given features with the layer's own geometry — or all of them. */
export type DrawFeatures<F> = (features?: readonly F[]) => void

export interface FeatureLayerOptions<F> {
  /** Where the features come from. */
  source: FeatureSource<F>
  /**
   * Draws one terrain tile: replace or extend the layer's geometry. `draw`
   * draws features (all by default) as the layer does, so that you can draw
   * some yourself and leave the rest to it. Plain `FeatureLayer`s draw
   * nothing themselves.
   */
  build?: (ctx: TileContext<F>, draw: DrawFeatures<F>) => void
  /** See `LayerMaterial`; by default the map's look. */
  material?: LayerMaterial
  /** Color `highlight()` uses by default. */
  highlightColor?: ColorRepresentation
  /** Terrain tiles below this zoom get nothing. */
  minZoom?: number
  /** Name of the layer's group. */
  name?: string
}

/** The feature under a ray, and where it was hit. */
export interface FeatureHit<F> extends GeoLocation {
  feature: F
  /** The hit in world coordinates. */
  point: Vector3
}

/**
 * A layer whose drawing takes the ground — water, roads, buildings — so that
 * others keep clear of it: `new Trees({ avoid: [water, roads] })`.
 */
export interface GroundCover {
  /**
   * Whether what the layer drew covers a point of the ground, or comes
   * within `margin` of it — in map units (tiles at the map's zoom).
   */
  covers(x: number, y: number, margin?: number): boolean
  /** Calls `listener` with every tile drawn (again) or removed; returns how to stop. */
  onTileDrawn(listener: (tile: Tile) => void): () => void
  /**
   * Whether a tile is still to be drawn (its data loading, its drawing
   * queued): layers keeping clear of this one wait for it.
   */
  pending?(tile: Tile): boolean
  whenReady(): Promise<void>
}

/** The material options resolved against the map's: the layer's look. */
export type Look = MaterialOptions

type PartKind = 'faces' | 'lines'

interface TileEntry<F> {
  tile: Tile
  keys: SourceTileKey[]
  /** While the source tiles load. */
  loading: boolean
  /** Set once the source tiles are loaded. */
  sources: SourceFeatures<F>[] | undefined
  /** Keys of the tiles whose heights the drawing read. */
  depends: Set<string>
  features: F[]
  objects: Object3D[]
  /** The part of every object the layer built: its material follows the look. */
  parts: globalThis.Map<Object3D, { part: string; kind: PartKind }>
  /** Parts (`kind:part`) left out because their material hid them. */
  skipped: Set<string>
  /** Objects from `ctx.add()`, and the index of their feature. */
  custom: globalThis.Map<Object3D, number>
  /** What the tile's faces cover, made when first asked. */
  footprint: Footprint | undefined
  /** Copies of a geometry: the feature of every copy. */
  instanced: globalThis.Map<InstancedMesh, number[]>
  /** The outlines of copies in wireframe, sharing their matrices. */
  outlines: globalThis.Map<InstancedMesh, InstancedMesh>
  overlays: Object3D[]
  done: Promise<void>
}

/** A ray hitting a feature behind the terrain this far (scene units) is hidden. */
const OCCLUSION_TOLERANCE = 0.01

const FOCUS = new Vector3()
const MATRIX = new Matrix4()

/** Overlays of highlighted features are drawn in front of them. */
const HIGHLIGHT_OFFSET = { factor: -2, units: -8 }

/** Whether a layer's material option is a look (not a material or a function). */
const isLook = (
  option: LayerMaterial | undefined
): option is Partial<MaterialOptions> =>
  typeof option === 'object' && !('isMaterial' in option)

const sameColor = (a?: ColorRepresentation, b?: ColorRepresentation) =>
  a === b ||
  (a !== undefined && b !== undefined && new Color(a).equals(new Color(b)))

const sameLook = (a: Look, b: Look) =>
  a.lights === b.lights &&
  a.wireframe === b.wireframe &&
  a.fog === b.fog &&
  (a.fillOpacity ?? 0) === (b.fillOpacity ?? 0) &&
  sameColor(a.color, b.color)

const matches = (feature: unknown, target: unknown) =>
  feature === target ||
  (typeof target === 'object' && target !== null
    ? (target as { id?: unknown }).id !== undefined &&
      (target as { id?: unknown }).id === (feature as { id?: unknown }).id
    : target === (feature as { id?: unknown } | null)?.id)

/**
 * A layer of features drawn tile by tile on the terrain — the base of
 * `Buildings` and `Roads`, and of your own layers (beta). It loads its
 * source's tiles for every terrain tile (shared, cancelled when unused),
 * calls `build` with a `TileContext` to draw them, and keeps the drawing in
 * step with the terrain: tiles are drawn again when the heights they read
 * change. Tiles are drawn a few at a time between frames, the nearest to
 * `map.focus` first. It resolves materials per part (changed in place when
 * the look does), picks features (not behind the terrain), highlights them
 * with any material, and survives `map.clean()`.
 *
 *     map.addLayer(new FeatureLayer({
 *       source: { minZoom: 14, maxZoom: 14, load: loadTrees },
 *       build(ctx) {
 *         for (const tree of ctx.allFeatures) ctx.feature(tree, () => …)
 *       }
 *     }))
 */
export class FeatureLayer<F> implements MapLayer, GroundCover {
  readonly source: FeatureSource<F>
  /** Holds the objects of every tile; added to `map.terrain`. */
  readonly group = new Group()
  map: Map | undefined
  readonly highlightColor: ColorRepresentation
  readonly minZoom: number

  /** The look, resolved when attached and when the map's changes. */
  protected look: Look | undefined
  protected materialOption: LayerMaterial | undefined

  private readonly buildTile:
    ((ctx: TileContext<F>, draw: DrawFeatures<F>) => void) | undefined
  private readonly sourceTiles: SourceTiles<F[]>
  private readonly tiles = new globalThis.Map<Tile, TileEntry<F>>()
  private readonly objects = new globalThis.Map<Object3D, TileEntry<F>>()
  /** Materials by part, and whether the layer made (and disposes) them. */
  private readonly materials = new globalThis.Map<
    string,
    { material: Material; own: boolean }
  >()
  private readonly highlightMaterials: Material[] = []
  private highlighted: { target: unknown; color: Color } | undefined
  private readonly dirty = new Set<TileEntry<F>>()
  /** `prepare()` is due before the next tile is drawn. */
  private stale = false
  private preparing = false
  /** Tiles whose source tiles are loading. */
  private loadingTiles = 0
  private readonly drawer: Drawer
  private readonly drawnListeners = new Set<(tile: Tile) => void>()
  /** Changes whenever a tile's objects do: `covers()` caches by it. */
  private version = 0
  private coverCache:
    | {
        x: number
        y: number
        version: number
        footprints: { footprint: Footprint; tile: Tile }[]
      }
    | undefined

  constructor({
    source,
    build,
    material,
    highlightColor = 0xffb020,
    minZoom = 0,
    name = 'features'
  }: FeatureLayerOptions<F>) {
    this.source = source
    this.buildTile = build
    this.materialOption = material
    this.highlightColor = highlightColor
    this.minZoom = minZoom
    this.group.name = name
    // names the layer in warnings: 'buildings' → 'Buildings'
    this.sourceTiles = new SourceTiles(
      name.charAt(0).toUpperCase() + name.slice(1),
      (tile) => this.source.load(tile)
    )
    this.drawer = {
      next: (waiting) => this.nextJob(waiting),
      loading: () => this.loadingTiles > 0
    }
  }

  get attribution() {
    return this.source.attribution ?? ''
  }

  /** Number of features drawn (a feature crossing tiles counts once per tile). */
  get count(): number {
    let count = 0
    for (const entry of this.tiles.values()) count += entry.features.length
    return count
  }

  // --- MapLayer -----------------------------------------------------------

  attach(map: Map) {
    this.map = map
    map.terrain.add(this.group)
    this.look = this.resolveLook(map)
    addDrawer(this.drawer)
  }

  detach() {
    for (const tile of [...this.tiles.keys()]) this.tileRemoved(tile)
    this.group.removeFromParent()
    this.disposeMaterials()
    this.look = undefined
    this.map = undefined
    this.stale = false
    removeDrawer(this.drawer)
  }

  /** Removes the layer from its map and frees its resources. */
  dispose() {
    if (this.map) this.map.removeLayer(this)
  }

  tileLoaded(tile: Tile) {
    if (!this.map || this.tiles.has(tile)) return
    // tiles that waited for this one's heights
    this.invalidateDepending(tile)
    if (tile.z < this.minZoom) return
    const entry: TileEntry<F> = {
      tile,
      keys: [],
      loading: true,
      sources: undefined,
      depends: new Set(),
      features: [],
      objects: [],
      parts: new globalThis.Map<Object3D, { part: string; kind: PartKind }>(),
      skipped: new Set<string>(),
      custom: new globalThis.Map<Object3D, number>(),
      footprint: undefined,
      instanced: new globalThis.Map<InstancedMesh, number[]>(),
      outlines: new globalThis.Map<InstancedMesh, InstancedMesh>(),
      overlays: [],
      done: Promise.resolve()
    }
    this.tiles.set(tile, entry)
    entry.done = this.load(entry)
  }

  tileChanged(tile: Tile) {
    this.invalidateDepending(tile)
  }

  tileRemoved(tile: Tile) {
    const entry = this.tiles.get(tile)
    if (!entry) return
    this.tiles.delete(tile)
    this.dirty.delete(entry)
    this.removeObjects(entry)
    for (const { key } of entry.keys) {
      if (this.sourceTiles.release(key)) this.sourceDropped(key)
    }
    this.invalidateDepending(tile)
    this.drawn(tile)
    // layers waiting for it may go on
    kick()
  }

  // --- the ground it takes ----------------------------------------------------

  /**
   * Whether the layer's faces cover a point of the ground (seen from above),
   * or come within `margin` of it — in map units (tiles at the map's zoom).
   * Faces reaching into a neighbouring tile count there too.
   */
  covers(x: number, y: number, margin = 0): boolean {
    const map = this.map
    if (!map) return false
    const { tileSize } = map.options
    const [tx, ty] = [Math.floor(x), Math.floor(y)]
    let cache = this.coverCache
    // points of one tile ask one after another: its 3 × 3 tiles' faces once
    if (cache?.x !== tx || cache.y !== ty || cache.version !== this.version) {
      cache = { x: tx, y: ty, version: this.version, footprints: [] }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const tile = map.tileCache[
            Utils.getTileKey(map.options.zoom, tx + dx, ty + dy)
          ] as Tile | undefined
          const entry = tile && this.tiles.get(tile)
          if (!entry) continue
          entry.footprint ??= new Footprint(
            entry.objects.flatMap((object) =>
              (object as Partial<Mesh>).isMesh &&
              !entry.custom.has(object) &&
              !entry.instanced.has(object as InstancedMesh)
                ? [(object as Mesh).geometry]
                : []
            )
          )
          if (!entry.footprint.empty) {
            cache.footprints.push({
              footprint: entry.footprint,
              tile: entry.tile
            })
          }
        }
      }
      this.coverCache = cache
    }
    for (const { footprint, tile } of cache.footprints) {
      const lx = (x - tile.x - 0.5) * tileSize
      const ly = (0.5 - (y - tile.y)) * tileSize
      if (footprint.covers(lx, ly, margin * tileSize)) return true
    }
    return false
  }

  /** Whether a tile is still to be drawn: its features loading, or its drawing queued. */
  pending(tile: Tile): boolean {
    const entry = this.tiles.get(tile)
    return (
      entry !== undefined &&
      (entry.loading || (entry.sources !== undefined && this.dirty.has(entry)))
    )
  }

  /**
   * Calls `listener` with every tile the layer draws (again) or removes —
   * e.g. to draw what depends on it again. Returns how to stop.
   */
  onTileDrawn(listener: (tile: Tile) => void): () => void {
    this.drawnListeners.add(listener)
    return () => this.drawnListeners.delete(listener)
  }

  private drawn(tile: Tile) {
    for (const listener of this.drawnListeners) {
      try {
        listener(tile)
      } catch (error) {
        console.error(error)
      }
    }
  }

  /**
   * The map's look changed: the materials follow — changed in place, the
   * geometry kept; a material function is asked again.
   */
  materialChanged(map: Map) {
    const previous = this.look
    this.look = this.resolveLook(map)
    this.restyle(previous, false)
  }

  /**
   * Changes how the layer is drawn (see `LayerMaterial`): a look is merged
   * into the layer's own (`color: undefined` takes the map's again), a
   * material or a function replaces it, `undefined` takes the map's look.
   * The materials change in place; the geometry is kept.
   */
  setMaterial(material: LayerMaterial | undefined) {
    const current = this.materialOption
    this.materialOption =
      isLook(material) && isLook(current)
        ? { ...current, ...material }
        : material
    if (!this.map) return
    const previous = this.look
    this.look = this.resolveLook(this.map)
    this.restyle(previous, true)
  }

  /** Resolves once every loaded terrain tile is drawn (or failed to load). */
  async whenReady(): Promise<void> {
    for (;;) {
      await Promise.all([...this.tiles.values()].map((entry) => entry.done))
      if (!this.hasWork()) return
      await sliced()
    }
  }

  /** Draws the given tiles again — all by default — e.g. after your data changed. */
  invalidate(tiles?: Iterable<Tile>) {
    const entries = tiles
      ? [...tiles].flatMap((tile) => this.tiles.get(tile) ?? [])
      : this.tiles.values()
    for (const entry of entries) this.dirty.add(entry)
    this.schedule()
  }

  // --- picking and highlighting --------------------------------------------

  /**
   * The feature hit by a ray — e.g. after `raycaster.setFromCamera(pointer,
   * camera)` — with its geolocation, or `undefined`; not one hidden behind
   * the terrain.
   */
  pick(raycaster: Raycaster): FeatureHit<F> | undefined {
    const { map } = this
    if (!map) return undefined
    map.terrain.updateWorldMatrix(true, true)
    const targets: Object3D[] = []
    for (const entry of this.tiles.values()) {
      for (const object of entry.objects) {
        if ((object as Partial<Mesh>).isMesh || entry.custom.has(object)) {
          targets.push(object)
        }
      }
    }
    const hits = raycaster.intersectObjects(targets, true)
    const hit = hits.find((candidate) => this.pickIntersection(candidate))
    if (!hit) return undefined
    const ground = raycaster
      .intersectObjects(
        Object.values(map.tileCache).flatMap((tile) =>
          tile.loaded && tile.mesh.parent === map.terrain ? [tile.mesh] : []
        ),
        false
      )
      .at(0)
    if (ground && ground.distance < hit.distance - OCCLUSION_TOLERANCE) {
      return undefined
    }
    return this.pickIntersection(hit)
  }

  /**
   * The feature of a raycaster intersection — e.g. a React Three Fiber
   * pointer event — or `undefined` if it is not on one of the layer's objects.
   */
  pickIntersection({
    object,
    face,
    index,
    instanceId,
    point
  }: Pick<Intersection, 'object' | 'face' | 'point'> &
    Partial<Pick<Intersection, 'index' | 'instanceId'>>):
    FeatureHit<F> | undefined {
    const { map } = this
    if (!map) return undefined
    let feature: F | undefined
    const entry = this.objects.get(object)
    const attribute = (object as Partial<Mesh>).geometry?.getAttribute(
      FEATURE_ATTRIBUTE
    ) as BufferAttribute | undefined
    const copies = entry?.instanced.get(object as InstancedMesh)
    if (entry && copies) {
      if (instanceId !== undefined) {
        feature = entry.features.at(copies[instanceId])
      }
    } else if (entry && attribute) {
      const vertex = (object as Partial<Mesh>).isMesh ? face?.a : index
      if (vertex !== undefined) {
        feature = entry.features.at(attribute.getX(vertex))
      }
    } else {
      // an object added with ctx.add(), or a child of one
      for (let node: Object3D | null = object; node; node = node.parent) {
        const owner = this.objects.get(node)
        const featureIndex = owner?.custom.get(node)
        if (owner && featureIndex !== undefined) {
          feature = owner.features.at(featureIndex)
          break
        }
      }
    }
    if (feature === undefined) return undefined
    const local = map.terrain.worldToLocal(point.clone())
    return { ...map.getLocation(local), point, feature }
  }

  /**
   * Highlights a feature — one from `pick()` (with its pieces in other tiles
   * if it has an `id`), or every feature with that `id` — in `color`, over
   * whatever material it has; `highlight()` clears it.
   */
  highlight(target?: F | string | number, color?: ColorRepresentation) {
    this.highlighted =
      target === undefined
        ? undefined
        : { target, color: new Color(color ?? this.highlightColor) }
    for (const material of this.highlightMaterials.splice(0)) {
      material.dispose()
    }
    for (const entry of this.tiles.values()) this.paint(entry)
  }

  // --- for layers -----------------------------------------------------------

  /** Which features of a source tile a terrain tile draws; all by default. */
  protected select(_tile: Tile, _source: SourceTileKey, features: F[]): F[] {
    return features
  }

  /** The layer's own geometry: what `draw` in `build` does. */
  protected draw(_ctx: TileContext<F>, _features: readonly F[]): void {
    // a plain FeatureLayer draws what `build` draws
  }

  /** A source tile's features arrived (e.g. to join features across tiles). */
  protected sourceLoaded(_key: SourceTileKey, _features: readonly F[]): void {
    // nothing by default
  }

  /** A source tile is no longer used by any terrain tile. */
  protected sourceDropped(_key: string): void {
    // nothing by default
  }

  /**
   * Called before tiles are drawn again: update what spans tiles (e.g.
   * joined features) and `invalidate()` the tiles it changes.
   */
  protected prepare(): void {
    // nothing by default
  }

  /** The terrain tiles whose features are loaded. */
  protected get loadedTiles(): Tile[] {
    return [...this.tiles.values()].flatMap((entry) =>
      entry.sources ? [entry.tile] : []
    )
  }

  /** The layer's own look: its material option if that is one, else none. */
  protected get ownLook(): Partial<MaterialOptions> {
    return isLook(this.materialOption) ? this.materialOption : {}
  }

  /** The look: the map's material options with the layer's own. */
  protected resolveLook(map: Map): Look {
    const merged: Partial<MaterialOptions> = { ...map.materialOptions }
    const own = Object.entries(this.ownLook) as [string, unknown][]
    for (const [key, value] of own) {
      // `undefined` takes the map's
      if (value !== undefined) Object.assign(merged, { [key]: value })
    }
    const { lights, wireframe, fillOpacity, fog, color } =
      merged as MaterialOptions
    return { lights, wireframe, fillOpacity, fog, color }
  }

  /**
   * The color of a part's built-in material, which multiplies the vertex
   * colors: the layer's own `color`, else white. Layers give their parts
   * the colors of their look here, so that a new look only changes the
   * materials.
   */
  protected partColor(
    _part: string,
    _kind: PartKind,
    _look: Look
  ): ColorRepresentation {
    return this.ownLook.color ?? 0xffffff
  }

  /**
   * Whether a look change needs the tiles drawn again — when the drawing
   * depends on more than the materials (e.g. colors per feature).
   */
  protected redrawsOn(_previous: Look, _next: Look): boolean {
    return false
  }

  /**
   * The look's material for a part: unlit or lit (`lights`), in
   * `partColor` times the vertex colors; in `wireframe` the lines show and
   * the faces are hidden (still picked) or a light fill (`fillOpacity`).
   */
  protected createMaterial(part: string, kind: PartKind, look: Look): Material {
    const color = this.partColor(part, kind, look)
    if (kind === 'lines') {
      return new LineBasicMaterial({
        color,
        vertexColors: true,
        fog: look.fog,
        visible: look.wireframe
      })
    }
    const opacity = look.wireframe ? Math.min(1, look.fillOpacity ?? 0) : 1
    const parameters = {
      color,
      vertexColors: true,
      fog: look.fog,
      visible: opacity > 0,
      // a fill under the lines: seen through, hiding none of them
      ...(opacity < 1 && { transparent: true, opacity, depthWrite: false })
    }
    return look.lights
      ? new MeshLambertMaterial(parameters)
      : new MeshBasicMaterial(parameters)
  }

  /** The material of a part: yours if you gave one, else the look's. */
  protected material(part: string, kind: PartKind): Material {
    const key = `${kind}:${part}`
    const cached = this.materials.get(key)
    if (cached) return cached.material
    const yours = this.optionMaterial(part, kind)
    const material =
      yours ?? this.createMaterial(part, kind, this.requireLook())
    this.materials.set(key, { material, own: yours === undefined })
    return material
  }

  /** Whether a tile can be drawn now; else it waits (e.g. for other layers). */
  protected canDraw(_tile: Tile): boolean {
    return true
  }

  /** Draws tiles again soon, a few at a time between frames. */
  protected schedule() {
    if (!this.preparing) this.stale = true
    kick()
  }

  protected requireLook(): Look {
    if (!this.look) throw new Error('The layer is not attached to a map')
    return this.look
  }

  // --- internals ------------------------------------------------------------

  /** The material you gave for a part, if any. */
  private optionMaterial(part: string, kind: PartKind): Material | undefined {
    const option = this.materialOption
    if (typeof option === 'function') return option(part)
    if (!isLook(option) && option !== undefined && kind === 'faces') {
      return option
    }
    return undefined
  }

  private async load(entry: TileEntry<F>) {
    const { minZoom, maxZoom } = this.source
    entry.keys = this.sourceTiles.covering(entry.tile, minZoom, maxZoom)
    let results: F[][]
    this.loadingTiles++
    try {
      results = await Promise.all(
        entry.keys.map((key) => this.sourceTiles.acquire(key))
      )
    } catch (error) {
      if (!isAbortError(error) && this.tiles.get(entry.tile) === entry) {
        console.error(error)
      }
      return
    } finally {
      entry.loading = false
      this.loadingTiles--
      // layers waiting for this one may go on
      kick()
    }
    // removed (or the map cleaned) while loading
    if (this.tiles.get(entry.tile) !== entry || !this.map) return

    entry.sources = entry.keys.map((key, i) => {
      this.sourceLoaded(key, results[i])
      return {
        key,
        rect: this.sourceRect(entry.tile, key),
        features: this.select(entry.tile, key, results[i])
      }
    })
    this.dirty.add(entry)
    this.schedule()
  }

  /** A source tile in a terrain tile's local coordinates. */
  private sourceRect(tile: Tile, { z, x, y }: SourceTileKey): Rect {
    const { tileSize } = tile.map.options
    const scale = 2 ** (tile.z - z)
    return [
      (x * scale - tile.x - 0.5) * tileSize,
      (0.5 - ((y + 1) * scale - tile.y)) * tileSize,
      ((x + 1) * scale - tile.x - 0.5) * tileSize,
      (0.5 - (y * scale - tile.y)) * tileSize
    ]
  }

  private invalidateDepending(tile: Tile) {
    const key = tile.key()
    let any = false
    for (const entry of this.tiles.values()) {
      if (entry.depends.has(key)) {
        this.dirty.add(entry)
        any = true
      }
    }
    if (any) this.schedule()
  }

  /** Whether tiles are left to draw (or `prepare()` to run). */
  private hasWork(): boolean {
    if (this.stale) return true
    for (const entry of this.dirty) {
      if (this.tiles.get(entry.tile) === entry && entry.sources) return true
    }
    return false
  }

  /** The tile to draw next — the nearest to the map's focus — for the scheduler. */
  private nextJob(waiting: boolean): DrawJob | undefined {
    const map = this.map
    if (!map) return undefined
    if (this.stale) {
      this.stale = false
      this.preparing = true
      try {
        this.prepare()
      } catch (error) {
        console.error(error)
      } finally {
        this.preparing = false
      }
    }
    if (this.dirty.size === 0) return undefined
    const { tileSize } = map.options
    const focus = map.focus
      ? map.terrain.worldToLocal(FOCUS.copy(map.focus))
      : map.getPosition({ ...map.geoLocation, alt: 0 }, { loadTile: false })
    let next: TileEntry<F> | undefined
    let distance = Infinity
    for (const entry of this.dirty) {
      // drawn when it loads, or gone
      if (this.tiles.get(entry.tile) !== entry || !entry.sources) {
        this.dirty.delete(entry)
        continue
      }
      if (!waiting && !this.canDraw(entry.tile)) continue
      const { x, y } = entry.tile.mesh.position
      const d = Math.hypot(x - focus.x, y - focus.y) / tileSize
      if (d < distance) [next, distance] = [entry, d]
    }
    if (!next) return undefined
    const entry = next
    return {
      distance,
      run: () => {
        this.dirty.delete(entry)
        if (entry.sources) this.render(entry, entry.sources)
      }
    }
  }

  private render(entry: TileEntry<F>, sources: SourceFeatures<F>[]) {
    this.removeObjects(entry)
    const skipped = new Set<string>()
    const ctx = new TileContext<F>(entry.tile, sources, (part, kind) => {
      const shown = this.shows(part, kind)
      if (!shown) skipped.add(`${kind}:${part}`)
      return shown
    })
    const draw: DrawFeatures<F> = (features) => {
      this.draw(ctx, features ?? ctx.allFeatures)
    }
    if (this.buildTile) this.buildTile(ctx, draw)
    else draw()

    entry.features = ctx.features
    entry.depends = ctx.depends
    entry.skipped = skipped
    const name = (part: string) =>
      `${this.group.name} ${part} ${entry.tile.key()}`
    const { surfaces, lines, instances } = ctx.parts
    for (const [part, builder] of surfaces) {
      const geometry = builder.build()
      if (geometry) {
        const mesh = new Mesh(geometry, this.material(part, 'faces'))
        mesh.name = name(part)
        entry.objects.push(mesh)
        entry.parts.set(mesh, { part, kind: 'faces' })
      }
    }
    for (const [part, builder] of lines) {
      const geometry = builder.build()
      if (geometry) {
        const segments = new LineSegments(
          geometry,
          this.material(part, 'lines')
        )
        segments.name = name(part)
        entry.objects.push(segments)
        entry.parts.set(segments, { part, kind: 'lines' })
      }
    }
    for (const [part, builder] of instances) {
      const mesh = builder.build(this.material(part, 'faces'))
      if (mesh) {
        mesh.name = name(part)
        entry.instanced.set(mesh, builder.features)
        entry.objects.push(mesh)
        entry.parts.set(mesh, { part, kind: 'faces' })
      }
    }
    for (const { object, feature } of ctx.objects) {
      entry.custom.set(object, feature)
      entry.objects.push(object)
    }
    for (const object of entry.objects) {
      object.position.add(entry.tile.mesh.position)
      this.objects.set(object, entry)
      this.group.add(object)
    }
    this.outline(entry)
    this.paint(entry)
    this.drawn(entry.tile)
  }

  /**
   * Whether a part is drawn: lines if their material shows, copies if their
   * faces or outlines do. Faces always are (they are picked).
   */
  private shows(part: string, kind: PartKind): boolean {
    if (kind === 'lines') return this.material(part, 'lines').visible
    return (
      this.material(part, 'faces').visible ||
      this.outlineMaterial(part) !== undefined
    )
  }

  /**
   * The material of the outlines of a part's copies: in wireframe, for
   * copies with the look's material — the lines of their triangles.
   */
  private outlineMaterial(part: string): Material | undefined {
    const look = this.requireLook()
    if (!look.wireframe) return undefined
    this.material(part, 'faces')
    if (!this.materials.get(`faces:${part}`)?.own) return undefined
    const key = `outline:${part}`
    let cached = this.materials.get(key)
    if (!cached) {
      cached = {
        material: new MeshBasicMaterial({
          color: this.partColor(part, 'lines', look),
          wireframe: true,
          fog: look.fog
        }),
        own: true
      }
      this.materials.set(key, cached)
    }
    return cached.material
  }

  /** Outlines the copies of a tile — or removes them — as the look wants. */
  private outline(entry: TileEntry<F>) {
    for (const [mesh, outline] of entry.outlines) {
      outline.removeFromParent()
      entry.outlines.delete(mesh)
    }
    for (const mesh of entry.instanced.keys()) {
      const part = entry.parts.get(mesh)?.part
      const material =
        part === undefined ? undefined : this.outlineMaterial(part)
      if (!material) continue
      const outline = new InstancedMesh(mesh.geometry, material, 0)
      // the copies' own matrices and colors: freed with them
      outline.instanceMatrix = mesh.instanceMatrix
      outline.instanceColor = mesh.instanceColor
      outline.count = mesh.count
      outline.boundingBox = mesh.boundingBox
      outline.boundingSphere = mesh.boundingSphere
      outline.position.copy(mesh.position)
      outline.name = `${mesh.name} outline`
      // the copies are picked, and exported
      outline.raycast = () => undefined
      outline.userData.export = false
      entry.outlines.set(mesh, outline)
      this.group.add(outline)
    }
  }

  private removeObjects(entry: TileEntry<F>) {
    this.clearOverlays(entry)
    for (const outline of entry.outlines.values()) outline.removeFromParent()
    entry.outlines.clear()
    for (const object of entry.objects) {
      this.objects.delete(object)
      object.removeFromParent()
      if (entry.instanced.has(object as InstancedMesh)) {
        // its copies; the geometry is shared
        ;(object as InstancedMesh).dispose()
      } else if (!entry.custom.has(object)) {
        ;(object as Mesh).geometry.dispose()
      }
    }
    entry.objects = []
    entry.parts.clear()
    entry.custom.clear()
    entry.instanced.clear()
    entry.footprint = undefined
    entry.features = []
    this.version++
  }

  private clearOverlays(entry: TileEntry<F>) {
    for (const overlay of entry.overlays) {
      overlay.removeFromParent()
      // copies of copies share the geometry: only their matrices are theirs
      if ((overlay as Partial<InstancedMesh>).isInstancedMesh) {
        ;(overlay as InstancedMesh).dispose()
      } else (overlay as Mesh).geometry.dispose()
    }
    entry.overlays = []
  }

  /**
   * Gives every object the material of its part in the current look — the
   * geometry kept — and draws again the tiles that left out a part now
   * shown, or all if `redrawsOn` says so. `replaced`: the option itself
   * changed, every material is made again.
   */
  private restyle(previous: Look | undefined, replaced: boolean) {
    const look = this.look
    if (!look) return
    const changed = replaced || !previous || !sameLook(previous, look)
    // the same look: nothing to do but ask a material function again
    if (!changed && typeof this.materialOption !== 'function') return
    const old = [...this.materials.entries()]
    this.materials.clear()
    // the look's materials are kept if it is the same; yours are asked again
    for (const [key, cached] of old) {
      const at = key.indexOf(':')
      const kind = key.slice(0, at)
      if (
        !changed &&
        cached.own &&
        kind !== 'outline' &&
        this.optionMaterial(key.slice(at + 1), kind as PartKind) === undefined
      ) {
        this.materials.set(key, cached)
      }
    }
    const redraw: TileEntry<F>[] = []
    for (const entry of this.tiles.values()) {
      for (const [object, { part, kind }] of entry.parts) {
        ;(object as Mesh).material = this.material(part, kind)
      }
      this.outline(entry)
      for (const key of entry.skipped) {
        const at = key.indexOf(':')
        if (this.shows(key.slice(at + 1), key.slice(0, at) as PartKind)) {
          redraw.push(entry)
          break
        }
      }
    }
    for (const [key, { material, own }] of old) {
      if (own && this.materials.get(key)?.material !== material) {
        material.dispose()
      }
    }
    // highlights in the new look
    for (const material of this.highlightMaterials.splice(0)) {
      material.dispose()
    }
    for (const entry of this.tiles.values()) this.paint(entry)
    if (previous && changed && this.redrawsOn(previous, look)) {
      this.invalidate()
    } else if (redraw.length > 0) {
      this.invalidate(redraw.map((entry) => entry.tile))
    }
  }

  /** Draws the highlighted features of a tile over themselves. */
  private paint(entry: TileEntry<F>) {
    this.clearOverlays(entry)
    const { highlighted } = this
    const indices = new Set<number>()
    if (highlighted) {
      for (const [i, feature] of entry.features.entries()) {
        if (matches(feature, highlighted.target)) indices.add(i)
      }
    }
    if (!highlighted || indices.size === 0) return

    // copies: the highlighted ones again, in front
    for (const [mesh, features] of entry.instanced) {
      if (!(mesh.material as Material).visible) continue
      const copies = features.flatMap((feature, i) =>
        indices.has(feature) ? [i] : []
      )
      if (copies.length === 0) continue
      const overlay = new InstancedMesh(
        mesh.geometry,
        this.highlightMaterial('faces', highlighted.color),
        copies.length
      )
      copies.forEach((copy, i) => {
        mesh.getMatrixAt(copy, MATRIX)
        overlay.setMatrixAt(i, MATRIX)
      })
      overlay.computeBoundingSphere()
      overlay.raycast = () => undefined
      overlay.userData.export = false
      mesh.add(overlay)
      entry.overlays.push(overlay)
    }

    for (const object of entry.objects) {
      if (
        entry.custom.has(object) ||
        entry.instanced.has(object as InstancedMesh)
      )
        continue
      const { geometry, material } = object as Mesh
      if (!(material as Material).visible) continue
      const isMesh = (object as Partial<Mesh>).isMesh === true
      const overlay = overlayGeometry(geometry, indices, isMesh)
      if (!overlay) continue
      const highlight = isMesh
        ? new Mesh(overlay, this.highlightMaterial('faces', highlighted.color))
        : new LineSegments(
            overlay,
            this.highlightMaterial('lines', highlighted.color)
          )
      // never picked: the highlighted feature itself is
      highlight.raycast = () => undefined
      highlight.userData.export = false
      object.add(highlight)
      entry.overlays.push(highlight)
    }
  }

  private highlightMaterial(kind: 'faces' | 'lines', color: Color): Material {
    const look = this.requireLook()
    const material =
      kind === 'lines'
        ? new LineBasicMaterial({ color, fog: look.fog })
        : new (look.lights ? MeshLambertMaterial : MeshBasicMaterial)({
            color,
            fog: look.fog,
            polygonOffset: true,
            polygonOffsetFactor: HIGHLIGHT_OFFSET.factor,
            polygonOffsetUnits: HIGHLIGHT_OFFSET.units
          })
    this.highlightMaterials.push(material)
    return material
  }

  private disposeMaterials() {
    for (const { material, own } of this.materials.values()) {
      if (own) material.dispose()
    }
    this.materials.clear()
    for (const material of this.highlightMaterials.splice(0)) {
      material.dispose()
    }
  }
}

/**
 * The faces (or line segments) of the features `indices` as a geometry of
 * their own — copied, so that disposing it never touches the original.
 */
function overlayGeometry(
  geometry: BufferGeometry,
  indices: ReadonlySet<number>,
  isMesh: boolean
): BufferGeometry | undefined {
  const feature = geometry.getAttribute(FEATURE_ATTRIBUTE) as
    BufferAttribute | undefined
  if (!feature) return undefined
  const position = geometry.getAttribute('position')
  const normal = geometry.getAttribute('normal') as BufferAttribute | undefined
  const index = geometry.getIndex()
  const vertices: number[] = []
  if (isMesh && index) {
    for (let i = 0; i < index.count; i += 3) {
      if (indices.has(feature.getX(index.getX(i)))) {
        vertices.push(index.getX(i), index.getX(i + 1), index.getX(i + 2))
      }
    }
  } else {
    for (let i = 0; i < position.count; i++) {
      if (indices.has(feature.getX(i))) vertices.push(i)
    }
  }
  if (vertices.length === 0) return undefined
  const positions: number[] = []
  const normals: number[] = []
  for (const v of vertices) {
    positions.push(position.getX(v), position.getY(v), position.getZ(v))
    if (normal) normals.push(normal.getX(v), normal.getY(v), normal.getZ(v))
  }
  const overlay = new BufferGeometry()
  overlay.setAttribute('position', new Float32BufferAttribute(positions, 3))
  if (normal) {
    overlay.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  }
  overlay.computeBoundingSphere()
  return overlay
}

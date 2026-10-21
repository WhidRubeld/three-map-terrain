import {
  type BufferAttribute,
  BufferGeometry,
  Color,
  type ColorRepresentation,
  Float32BufferAttribute,
  Group,
  type Intersection,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type Object3D,
  type Raycaster,
  type Vector3
} from 'three'

import { isAbortError } from '../io/fetch'
import type { FeatureSource } from '../sources/feature-source'
import { type SourceTileKey, SourceTiles } from '../sources/source-tiles'
import type { GeoLocation, Map, MapLayer } from '../terrain/Map.class'
import type { MaterialOptions } from '../terrain/material'
import type { Tile } from '../terrain/Tile.class'
import { FEATURE_ATTRIBUTE } from './geometry'
import {
  type Rect,
  type SourceFeatures,
  TileContext
} from './TileContext.class'

/**
 * How a layer's parts are drawn: the look (the map's material options —
 * `color`, `lights`, `wireframe`, `fog` — overridden by these), one
 * material for its faces, or a material per part (`undefined`: the look's).
 * Materials you pass are yours: the layer never disposes them.
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

/** The material options resolved against the map's: the layer's look. */
export type Look = MaterialOptions

interface TileEntry<F> {
  tile: Tile
  keys: SourceTileKey[]
  /** Set once the source tiles are loaded. */
  sources: SourceFeatures<F>[] | undefined
  /** Keys of the tiles whose heights the drawing read. */
  depends: Set<string>
  features: F[]
  objects: Object3D[]
  /** Objects from `ctx.add()`, and the index of their feature. */
  custom: globalThis.Map<Object3D, number>
  overlays: Object3D[]
  done: Promise<void>
}

/** A ray hitting a feature behind the terrain this far (scene units) is hidden. */
const OCCLUSION_TOLERANCE = 0.01

/** Overlays of highlighted features are drawn in front of them. */
const HIGHLIGHT_OFFSET = { factor: -2, units: -8 }

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
 * change. It resolves materials per part, picks features (not behind the
 * terrain), highlights them with any material, and survives `map.clean()`.
 *
 *     map.addLayer(new FeatureLayer({
 *       source: { minZoom: 14, maxZoom: 14, load: loadTrees },
 *       build(ctx) {
 *         for (const tree of ctx.allFeatures) ctx.feature(tree, () => …)
 *       }
 *     }))
 */
export class FeatureLayer<F> implements MapLayer {
  readonly source: FeatureSource<F>
  /** Holds the objects of every tile; added to `map.terrain`. */
  readonly group = new Group()
  map: Map | undefined
  readonly highlightColor: ColorRepresentation
  readonly minZoom: number

  /** The look, resolved when attached and when the map's changes. */
  protected look: Look | undefined
  protected readonly materialOption: LayerMaterial | undefined

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
  private flushing: Promise<void> | undefined

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
  }

  detach() {
    for (const tile of [...this.tiles.keys()]) this.tileRemoved(tile)
    this.group.removeFromParent()
    this.disposeMaterials()
    this.look = undefined
    this.map = undefined
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
      sources: undefined,
      depends: new Set(),
      features: [],
      objects: [],
      custom: new globalThis.Map<Object3D, number>(),
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
  }

  /** The map's look changed: draw everything again in the new one. */
  materialChanged(map: Map) {
    this.disposeMaterials()
    this.look = this.resolveLook(map)
    for (const entry of this.tiles.values()) this.dirty.add(entry)
    this.flush()
  }

  /** Resolves once every loaded terrain tile is drawn (or failed to load). */
  async whenReady(): Promise<void> {
    for (;;) {
      await Promise.all([...this.tiles.values()].map((entry) => entry.done))
      if (!this.flushing) return
      await this.flushing
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
    point
  }: Pick<Intersection, 'object' | 'face' | 'point'> &
    Partial<Pick<Intersection, 'index'>>): FeatureHit<F> | undefined {
    const { map } = this
    if (!map) return undefined
    let feature: F | undefined
    const entry = this.objects.get(object)
    const attribute = (object as Partial<Mesh>).geometry?.getAttribute(
      FEATURE_ATTRIBUTE
    ) as BufferAttribute | undefined
    if (entry && attribute) {
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

  /** The look: the map's material options with the layer's own. */
  protected resolveLook(map: Map): Look {
    const own =
      this.materialOption === undefined ||
      this.materialOption instanceof Material ||
      typeof this.materialOption === 'function'
        ? {}
        : this.materialOption
    const { lights, wireframe, fog, color } = { ...map.materialOptions, ...own }
    return { lights, wireframe, fog, color }
  }

  /**
   * The look's material for a part: unlit or lit (`lights`), with the
   * vertex colors; faces hidden in `wireframe` (they are still picked),
   * lines shown only there.
   */
  protected createMaterial(
    _part: string,
    kind: 'faces' | 'lines',
    look: Look
  ): Material {
    if (kind === 'lines') {
      return new LineBasicMaterial({
        vertexColors: true,
        fog: look.fog,
        visible: look.wireframe
      })
    }
    const parameters = {
      vertexColors: true,
      fog: look.fog,
      visible: !look.wireframe
    }
    return look.lights
      ? new MeshLambertMaterial(parameters)
      : new MeshBasicMaterial(parameters)
  }

  /** The material of a part: yours if you gave one, else the look's. */
  protected material(part: string, kind: 'faces' | 'lines'): Material {
    const key = `${kind}:${part}`
    const cached = this.materials.get(key)
    if (cached) return cached.material
    const option = this.materialOption
    let material: Material | undefined
    if (typeof option === 'function') material = option(part)
    else if (option instanceof Material && kind === 'faces') material = option
    const own = material === undefined
    material ??= this.createMaterial(part, kind, this.requireLook())
    this.materials.set(key, { material, own })
    return material
  }

  /** Draws tiles again once the current task is done. */
  protected schedule() {
    this.flushing ??= Promise.resolve().then(() => {
      this.flushing = undefined
      this.flush()
    })
  }

  protected requireLook(): Look {
    if (!this.look) throw new Error('The layer is not attached to a map')
    return this.look
  }

  // --- internals ------------------------------------------------------------

  private async load(entry: TileEntry<F>) {
    const { minZoom, maxZoom } = this.source
    entry.keys = this.sourceTiles.covering(entry.tile, minZoom, maxZoom)
    let results: F[][]
    try {
      results = await Promise.all(
        entry.keys.map((key) => this.sourceTiles.acquire(key))
      )
    } catch (error) {
      if (!isAbortError(error) && this.tiles.get(entry.tile) === entry) {
        console.error(error)
      }
      return
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

  private flush() {
    try {
      this.prepare()
    } catch (error) {
      console.error(error)
    }
    const entries = [...this.dirty]
    this.dirty.clear()
    for (const entry of entries) {
      if (this.tiles.get(entry.tile) !== entry || !entry.sources) continue
      try {
        this.render(entry, entry.sources)
      } catch (error) {
        console.error(error)
      }
    }
  }

  private render(entry: TileEntry<F>, sources: SourceFeatures<F>[]) {
    this.removeObjects(entry)
    const ctx = new TileContext<F>(
      entry.tile,
      sources,
      (part) => this.material(part, 'lines').visible
    )
    const draw: DrawFeatures<F> = (features) => {
      this.draw(ctx, features ?? ctx.allFeatures)
    }
    if (this.buildTile) this.buildTile(ctx, draw)
    else draw()

    entry.features = ctx.features
    entry.depends = ctx.depends
    const { surfaces, lines } = ctx.parts
    for (const [part, builder] of surfaces) {
      const geometry = builder.build()
      if (geometry) {
        const mesh = new Mesh(geometry, this.material(part, 'faces'))
        mesh.name = `${this.group.name} ${part} ${entry.tile.key()}`
        entry.objects.push(mesh)
      }
    }
    for (const [part, builder] of lines) {
      const geometry = builder.build()
      if (geometry) {
        const segments = new LineSegments(
          geometry,
          this.material(part, 'lines')
        )
        segments.name = `${this.group.name} ${part} ${entry.tile.key()}`
        entry.objects.push(segments)
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
    this.paint(entry)
  }

  private removeObjects(entry: TileEntry<F>) {
    this.clearOverlays(entry)
    for (const object of entry.objects) {
      this.objects.delete(object)
      object.removeFromParent()
      if (!entry.custom.has(object)) {
        ;(object as Mesh).geometry.dispose()
      }
    }
    entry.objects = []
    entry.custom.clear()
    entry.features = []
  }

  private clearOverlays(entry: TileEntry<F>) {
    for (const overlay of entry.overlays) {
      overlay.removeFromParent()
      ;(overlay as Mesh).geometry.dispose()
    }
    entry.overlays = []
  }

  /** Draws the highlighted features of a tile over themselves. */
  private paint(entry: TileEntry<F>) {
    this.clearOverlays(entry)
    const { highlighted } = this
    if (!highlighted) return
    const indices = new Set<number>()
    for (const [i, feature] of entry.features.entries()) {
      if (matches(feature, highlighted.target)) indices.add(i)
    }
    if (indices.size === 0) return

    for (const object of entry.objects) {
      if (entry.custom.has(object)) continue
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

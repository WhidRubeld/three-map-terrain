import {
  type BufferGeometry,
  Color,
  type ColorRepresentation,
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

import type { BuildingFeature, BuildingId, Position, Ring } from './features'
import { clipRect, isColor, isRing, ringAnchor } from './features'
import { BuildingGeometryBuilder, type FlatRing } from './geometry'
import {
  BuildingSource,
  type BuildingSourceProps
} from './BuildingSource.class'
import { isAbortError } from '../io/fetch'
import type { GeoLocation, Map, MapLayer } from '../terrain/Map.class'
import type { MaterialOptions } from '../terrain/quad-texture-material'
import type { Tile } from '../terrain/Tile.class'
import { Utils } from '../geo/Utils.class'

export interface BuildingsOptions {
  /** Where the footprints come from: a `BuildingSource`, or the props to create one. */
  source: BuildingSource | BuildingSourceProps
  /**
   * How the buildings are drawn — the same options as the terrain's
   * `material`, and by default the map's: in its `color`, lit like it, in
   * `wireframe` (their edges) with it. Or your own material for the faces;
   * it gets `vertexColors`.
   */
  material?: Partial<MaterialOptions> | Material
  /** Outline the solid buildings with their edges, in a darker shade. */
  edges: boolean
  /**
   * Cut the buildings at the edge of the map's `nTiles × nTiles` grid — and
   * draw the parts of those outside that reach in — so that the city ends
   * with the terrain. Inside the grid buildings are never cut.
   */
  clip: boolean
  /** Draw buildings in the color the source gives them, if any. */
  featureColors: boolean
  /** Color `highlight()` uses by default. */
  highlightColor: ColorRepresentation
  /** Height in meters of buildings the source has none for. */
  defaultHeight: number
  /** Terrain tiles below this zoom get no buildings. */
  minZoom: number
}

export const defaultBuildingsOptions: Readonly<
  Omit<BuildingsOptions, 'source' | 'material'>
> = Object.freeze({
  edges: false,
  clip: true,
  featureColors: false,
  highlightColor: 0xffb020,
  defaultHeight: 6,
  minZoom: 13
})

/** The building under a ray: the feature and where it was hit. */
export interface BuildingHit extends GeoLocation {
  feature: BuildingFeature
  /** The hit in world coordinates. */
  point: Vector3
}

/** Meters the walls reach below the lowest ground under them. */
const FOUNDATION = 0.5
/** On a slope, at least this much of a grounded building stays above ground (m). */
const MIN_EXPOSED = 3
/** A terrain tile loads at most 4^this source tiles. */
const MAX_SOURCE_LEVELS = 2
/** Edges over solid buildings: their color times this. */
const EDGE_SHADE = 0.62

interface SourceTile {
  refs: number
  controller: AbortController
  features: Promise<BuildingFeature[]>
}

interface TileBuildings {
  tile: Tile
  mesh?: Mesh<BufferGeometry, Material>
  lines?: LineSegments<BufferGeometry, LineBasicMaterial>
  /** Buildings in the order of their vertices. */
  features: BuildingFeature[]
  /** First vertex of each building, then the vertex count. */
  starts: number[]
  /** The same for the vertices of `lines`. */
  lineStarts: number[]
  sources: string[]
  done: Promise<void>
}

/** The drawing options resolved against the map's. */
interface Style extends MaterialOptions {
  /** Draw `lines`: in wireframe, or as edges over the faces. */
  lines: boolean
}

const isPolygon = (
  geometry: BuildingFeature['geometry']
): geometry is Extract<BuildingFeature['geometry'], { type: 'Polygon' }> =>
  geometry.type === 'Polygon'

const polygonsOf = (feature: BuildingFeature): readonly (readonly Ring[])[] =>
  isPolygon(feature.geometry)
    ? [feature.geometry.coordinates]
    : feature.geometry.coordinates

/**
 * 3D buildings on the terrain, as a `MapLayer`: `map.addLayer(new
 * Buildings({ source: { api: 'openfreemap' } }))`. Every loaded terrain tile
 * gets one mesh with the buildings whose center lies in it, standing on the
 * rendered surface; heights are scaled by the map's `zScale`.
 */
export class Buildings implements MapLayer {
  readonly source: BuildingSource
  readonly options: Omit<BuildingsOptions, 'source'>
  /** Holds one mesh per terrain tile; added to `map.terrain`. */
  readonly group = new Group()
  map: Map | undefined

  private material: Material | undefined
  private lineMaterial: LineBasicMaterial | undefined
  private ownMaterial = false
  private style: Style | undefined
  private readonly tiles = new globalThis.Map<Tile, TileBuildings>()
  /** Meshes and lines, to find the building of an intersection. */
  private readonly objects = new globalThis.Map<Object3D, TileBuildings>()
  private readonly sourceTiles = new globalThis.Map<string, SourceTile>()
  private highlighted:
    { target: BuildingFeature | BuildingId; color: Color } | undefined
  private warnedZoom = false

  constructor({
    source,
    ...options
  }: Pick<BuildingsOptions, 'source'> & Partial<BuildingsOptions>) {
    this.source =
      source instanceof BuildingSource ? source : new BuildingSource(source)
    this.options = { ...defaultBuildingsOptions, ...options }
    this.group.name = 'buildings'
  }

  get attribution() {
    return this.source.attribution
  }

  /** Number of buildings drawn. */
  get count(): number {
    let count = 0
    for (const entry of this.tiles.values()) count += entry.features.length
    return count
  }

  attach(map: Map) {
    this.map = map
    map.terrain.add(this.group)
    this.setupStyle(map)
  }

  /** The terrain's style changed: draw the buildings in the new one. */
  materialChanged(map: Map) {
    this.disposeMaterials()
    this.setupStyle(map)
    for (const entry of this.tiles.values()) {
      if (!entry.mesh) continue
      this.removeObjects(entry)
      const { features } = entry
      entry.features = []
      entry.starts = [0]
      entry.lineStarts = [0]
      this.createObjects(entry, features)
      this.placeObjects(entry)
    }
  }

  private setupStyle(map: Map) {
    const { material, edges } = this.options
    const own = material instanceof Material ? {} : material
    const { lights, wireframe, fog, color } = { ...map.materialOptions, ...own }
    this.style = { lights, wireframe, fog, color, lines: wireframe || edges }

    if (material instanceof Material) {
      this.material = material
      material.vertexColors = true
    } else {
      const parameters = {
        vertexColors: true,
        fog,
        // edges are drawn over the faces
        polygonOffset: edges,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
      }
      this.material = lights
        ? new MeshLambertMaterial(parameters)
        : new MeshBasicMaterial(parameters)
      this.ownMaterial = true
    }
    if (this.style.lines) {
      this.lineMaterial = new LineBasicMaterial({ vertexColors: true, fog })
    }
  }

  detach() {
    for (const tile of [...this.tiles.keys()]) this.tileRemoved(tile)
    this.group.removeFromParent()
    this.disposeMaterials()
    this.map = undefined
  }

  private disposeMaterials() {
    if (this.ownMaterial) this.material?.dispose()
    this.lineMaterial?.dispose()
    this.material = undefined
    this.lineMaterial = undefined
    this.ownMaterial = false
    this.style = undefined
  }

  /** Removes the buildings from their map and frees their resources. */
  dispose() {
    if (this.map) this.map.removeLayer(this)
  }

  tileLoaded(tile: Tile) {
    if (!this.map || tile.z < this.options.minZoom || this.tiles.has(tile))
      return
    const entry: TileBuildings = {
      tile,
      features: [],
      starts: [0],
      lineStarts: [0],
      sources: [],
      done: Promise.resolve()
    }
    this.tiles.set(tile, entry)
    entry.done = this.build(entry)
  }

  tileRemoved(tile: Tile) {
    const entry = this.tiles.get(tile)
    if (!entry) return
    this.tiles.delete(tile)
    for (const key of entry.sources) this.release(key)
    this.removeObjects(entry)
  }

  private removeObjects(entry: TileBuildings) {
    for (const object of [entry.mesh, entry.lines]) {
      if (!object) continue
      this.objects.delete(object)
      object.removeFromParent()
      object.geometry.dispose()
    }
    entry.mesh = undefined
    entry.lines = undefined
  }

  private placeObjects(entry: TileBuildings) {
    for (const object of [entry.mesh, entry.lines]) {
      if (!object) continue
      object.position.copy(entry.tile.mesh.position)
      this.objects.set(object, entry)
      this.group.add(object)
    }
    if (this.highlighted) {
      this.paint(entry, this.highlighted.target, this.highlighted.color)
    }
  }

  /** Resolves once every loaded terrain tile has its buildings (or failed to). */
  async whenReady(): Promise<void> {
    await Promise.all([...this.tiles.values()].map((entry) => entry.done))
  }

  /**
   * The building hit by a ray — e.g. after `raycaster.setFromCamera(pointer,
   * camera)` — with its geolocation, or `undefined`.
   */
  pick(raycaster: Raycaster): BuildingHit | undefined {
    if (!this.map) return undefined
    this.group.updateWorldMatrix(true, true)
    // the faces, also in wireframe where they are hidden
    const meshes = [...this.tiles.values()].flatMap((entry) =>
      entry.mesh ? [entry.mesh] : []
    )
    const hit = raycaster.intersectObjects(meshes, false).at(0)
    return hit && this.pickIntersection(hit)
  }

  /**
   * The building of a raycaster intersection — e.g. a React Three Fiber
   * pointer event — or `undefined` if it is not on one of the meshes.
   */
  pickIntersection({
    object,
    face,
    index,
    point
  }: Pick<Intersection, 'object' | 'face' | 'point'> &
    Partial<Pick<Intersection, 'index'>>): BuildingHit | undefined {
    const { map } = this
    const entry = this.objects.get(object)
    if (!map || !entry) return undefined
    // a face of the mesh, or a segment of the lines
    const [starts, vertex] =
      object === entry.mesh
        ? [entry.starts, face?.a]
        : [entry.lineStarts, index]
    if (vertex === undefined) return undefined
    const feature = entry.features[featureIndex(starts, vertex)]
    const local = map.terrain.worldToLocal(point.clone())
    return { ...map.getLocation(local), point, feature }
  }

  /**
   * Colors one building — a feature from `pick()`, or every building with
   * that `id` — and restores the previous one; `highlight()` clears it.
   */
  highlight(
    target?: BuildingFeature | BuildingId,
    color: ColorRepresentation = this.options.highlightColor
  ) {
    const previous = this.highlighted
    this.highlighted =
      target === undefined ? undefined : { target, color: new Color(color) }
    for (const entry of this.tiles.values()) {
      if (previous) this.paint(entry, previous.target, undefined)
      if (this.highlighted) {
        this.paint(entry, this.highlighted.target, this.highlighted.color)
      }
    }
  }

  // --- loading ---------------------------------------------------------

  private async build(entry: TileBuildings) {
    const keys = this.sourceTilesFor(entry.tile)
    entry.sources = keys.map(({ key }) => key)
    let results: BuildingFeature[][]
    try {
      results = await Promise.all(keys.map((key) => this.acquire(key)))
    } catch (error) {
      if (!isAbortError(error) && this.tiles.get(entry.tile) === entry) {
        console.error(error)
      }
      return
    }
    // removed (or the map cleaned) while loading
    if (this.tiles.get(entry.tile) !== entry || !this.map || !this.material) {
      return
    }

    const owned = results.flatMap((features, i) =>
      features.filter((feature) => this.owns(entry.tile, keys[i], feature))
    )
    this.createObjects(entry, owned)
    this.placeObjects(entry)
  }

  /** Source tiles covering a terrain tile, at the zoom the source has. */
  private sourceTilesFor({ z, x, y }: Tile) {
    const { minZoom, maxZoom } = this.source
    const zoom = Math.max(minZoom, Math.min(z, maxZoom))
    if (zoom <= z) {
      const scale = 2 ** (z - zoom)
      const sx = Math.floor(x / scale)
      const sy = Math.floor(y / scale)
      return [{ z: zoom, x: sx, y: sy, key: `${zoom}/${sx}/${sy}` }]
    }
    if (zoom - z > MAX_SOURCE_LEVELS) {
      if (!this.warnedZoom) {
        console.warn(
          `Buildings: the source starts at zoom ${minZoom}, too deep for terrain zoom ${z}`
        )
        this.warnedZoom = true
      }
      return []
    }
    const scale = 2 ** (zoom - z)
    const tiles = []
    for (let i = 0; i < scale; i++) {
      for (let j = 0; j < scale; j++) {
        const sx = x * scale + i
        const sy = y * scale + j
        tiles.push({ z: zoom, x: sx, y: sy, key: `${zoom}/${sx}/${sy}` })
      }
    }
    return tiles
  }

  /** Shares one request per source tile between the terrain tiles using it. */
  private acquire({
    z,
    x,
    y,
    key
  }: {
    z: number
    x: number
    y: number
    key: string
  }) {
    let entry = this.sourceTiles.get(key)
    if (!entry) {
      const controller = new AbortController()
      entry = {
        refs: 0,
        controller,
        features: this.source.load({ z, x, y, signal: controller.signal })
      }
      this.sourceTiles.set(key, entry)
    }
    entry.refs++
    return entry.features
  }

  private release(key: string) {
    const entry = this.sourceTiles.get(key)
    if (!entry || --entry.refs > 0) return
    this.sourceTiles.delete(key)
    entry.controller.abort()
  }

  /**
   * A building belongs to the tile its center (of the first outer ring's
   * bounding box) lies in — once, although sources return it for every tile
   * it touches. With `clip`, one whose center is outside the grid belongs
   * to the nearest tile of the grid, which draws the part reaching in.
   */
  private owns(
    tile: Tile,
    source: { z: number; x: number; y: number },
    feature: BuildingFeature
  ) {
    const outer = polygonsOf(feature).at(0)?.at(0)
    if (!outer || outer.length < 3) return false
    const [lon, lat] = ringAnchor(outer)
    const anchorAt = (z: number) => {
      const f = Utils.position2tileFraction(lat, lon, z)
      return [Math.floor(f.x), Math.floor(f.y)]
    }
    const clamp = (value: number, min: number, max: number) =>
      Math.max(min, Math.min(max, value))

    let [x, y] = anchorAt(tile.z)
    const grid = this.clipGrid(tile)
    const outside =
      grid !== undefined &&
      (x < grid.minX || x > grid.maxX || y < grid.minY || y > grid.maxY)
    if (grid && outside) {
      x = clamp(x, grid.minX, grid.maxX)
      y = clamp(y, grid.minY, grid.maxY)
    }
    if (x !== tile.x || y !== tile.y) return false
    if (source.z <= tile.z) return true

    // several source tiles cover the terrain tile: one of them draws it
    let [sx, sy] = anchorAt(source.z)
    if (outside) {
      const scale = 2 ** (source.z - tile.z)
      sx = clamp(sx, tile.x * scale, tile.x * scale + scale - 1)
      sy = clamp(sy, tile.y * scale, tile.y * scale + scale - 1)
    }
    return sx === source.x && sy === source.y
  }

  /** The grid buildings of `tile` are cut at, if they are. */
  private clipGrid(tile: Tile) {
    if (!this.options.clip || !this.map) return undefined
    const grid = this.map.grid
    const inGrid =
      tile.z === grid.zoom &&
      tile.x >= grid.minX &&
      tile.x <= grid.maxX &&
      tile.y >= grid.minY &&
      tile.y <= grid.maxY
    return inGrid ? grid : undefined
  }

  /** Polygons cut at the grid, in `tile`'s local coordinates. */
  private clipToGrid(tile: Tile, polygons: FlatRing[][]): FlatRing[][] {
    const grid = this.clipGrid(tile)
    if (!grid || !this.map) return polygons
    const { tileSize } = this.map.options
    const minX = (grid.minX - tile.x - 0.5) * tileSize
    const maxX = (grid.maxX + 1 - tile.x - 0.5) * tileSize
    const maxY = (0.5 - (grid.minY - tile.y)) * tileSize
    const minY = (0.5 - (grid.maxY + 1 - tile.y)) * tileSize
    const inside = (ring: FlatRing) => {
      for (let i = 0; i < ring.length; i += 2) {
        const [x, y] = [ring[i], ring[i + 1]]
        if (x < minX || x > maxX || y < minY || y > maxY) return false
      }
      return true
    }
    return polygons.flatMap(([outer, ...holes]) => {
      if (inside(outer)) return [[outer, ...holes]]
      const cut = clipRect(outer, minX, minY, maxX, maxY)
      if (!isRing(cut)) return []
      const cutHoles = holes
        .map((hole) => clipRect(hole, minX, minY, maxX, maxY))
        .filter(isRing)
      return [[cut, ...cutHoles]]
    })
  }

  // --- geometry --------------------------------------------------------

  /** The faces (`mesh`) and the edges (`lines`) of a tile's buildings. */
  private createObjects(entry: TileBuildings, features: BuildingFeature[]) {
    const { map, material, lineMaterial, style } = this
    if (!map || !material || !style) return
    const { tile } = entry
    const { tileSize, tileSegments, zScale } = map.options
    const { defaultHeight } = this.options
    // the terrain is piecewise linear: sampling the walls this densely finds
    // its lowest point under them
    const step = tileSize / tileSegments / 2
    const builder = new BuildingGeometryBuilder(style.lines)
    const color = new Color()
    const lineColor = new Color()

    const toLocal = ([lon, lat]: Position): [number, number] => {
      const f = Utils.position2tileFraction(lat, lon, tile.z)
      return [
        (f.x - tile.x - 0.5) * tileSize,
        (0.5 - (f.y - tile.y)) * tileSize
      ]
    }

    for (const feature of features) {
      const height = feature.height ?? defaultHeight
      const minHeight = Math.max(0, feature.minHeight ?? 0)
      if (!(height > minHeight)) continue

      const polygons = this.clipToGrid(
        tile,
        polygonsOf(feature).map((polygon) =>
          polygon.map((ring) => this.flatRing(ring, toLocal))
        )
      )
      if (!polygons.some((polygon) => polygon[0] && polygon[0].length >= 6))
        continue

      let low = Infinity
      let high = -Infinity
      for (const polygon of polygons) {
        const outer = polygon[0]
        const n = outer.length / 2
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n
          const [ax, ay, bx, by] = [
            outer[2 * i],
            outer[2 * i + 1],
            outer[2 * j],
            outer[2 * j + 1]
          ]
          const samples = Math.max(
            1,
            Math.ceil(Math.hypot(bx - ax, by - ay) / step)
          )
          for (let k = 0; k < samples; k++) {
            const t = k / samples
            const z = this.groundAt(
              tile,
              ax + (bx - ax) * t,
              ay + (by - ay) * t
            )
            low = Math.min(low, z)
            high = Math.max(high, z)
          }
        }
      }
      if (!Number.isFinite(low)) continue

      // heights count from the lowest ground (OSM `height`); on a slope at
      // least MIN_EXPOSED meters stay above the highest ground
      const floating = minHeight > 0
      const bottom = floating
        ? low + minHeight * zScale
        : low - FOUNDATION * zScale
      const top = floating
        ? low + height * zScale
        : Math.max(
            low + height * zScale,
            high + Math.min(height, MIN_EXPOSED) * zScale
          )

      this.baseColor(feature, color)
      builder.add(
        polygons,
        bottom,
        top,
        color,
        floating,
        this.lineColor(color, lineColor)
      )
      entry.features.push(feature)
      entry.starts.push(builder.vertexCount)
      entry.lineStarts.push(builder.lineVertexCount)
    }
    if (entry.features.length === 0) return

    entry.mesh = new Mesh(builder.build(), material)
    entry.mesh.name = `buildings ${tile.key()}`
    // in wireframe the edges replace the faces, which stay pickable
    entry.mesh.visible = !style.wireframe
    const lines = builder.buildLines()
    if (lines && lineMaterial) {
      entry.lines = new LineSegments(lines, lineMaterial)
      entry.lines.name = `building edges ${tile.key()}`
    }
  }

  /** A ring in the tile mesh's local coordinates, without a closing duplicate. */
  private flatRing(
    ring: Ring,
    toLocal: (position: Position) => [number, number]
  ) {
    const flat: FlatRing = []
    for (const position of ring) {
      const [x, y] = toLocal(position)
      const n = flat.length
      if (n >= 2 && flat[n - 2] === x && flat[n - 1] === y) continue
      flat.push(x, y)
    }
    const n = flat.length
    if (n >= 4 && flat[0] === flat[n - 2] && flat[1] === flat[n - 1]) {
      flat.length = n - 2
    }
    return flat
  }

  /**
   * Height of the rendered terrain under a point given in `tile`'s local
   * coordinates — from the neighbour it lies in if that one is loaded.
   */
  private groundAt(tile: Tile, x: number, y: number) {
    const { map } = this
    const tileSize = map?.options.tileSize ?? 1
    const u = x / tileSize + 0.5
    const v = 0.5 - y / tileSize
    const dx = Math.floor(u)
    const dy = Math.floor(v)
    if (dx !== 0 || dy !== 0) {
      const neighbour =
        map?.tileCache[Utils.getTileKey(tile.z, tile.x + dx, tile.y + dy)]
      if (neighbour?.loaded) return neighbour.heightAt(u - dx, v - dy)
    }
    return tile.heightAt(u, v)
  }

  // --- colors ----------------------------------------------------------

  private baseColor(feature: BuildingFeature, target: Color) {
    const color = this.style?.color ?? 0xffffff
    return this.options.featureColors && feature.color && isColor(feature.color)
      ? target.set(feature.color)
      : target.set(color)
  }

  /** Lines of the wireframe have the building's color, edges a darker one. */
  private lineColor(color: Color, target: Color) {
    target.copy(color)
    return this.style?.wireframe ? target : target.multiplyScalar(EDGE_SHADE)
  }

  /** Paints the matching buildings of a tile; `undefined` restores them. */
  private paint(
    entry: TileBuildings,
    target: BuildingFeature | BuildingId,
    color: Color | undefined
  ) {
    const faces = entry.mesh?.geometry.getAttribute('color')
    const lines = entry.lines?.geometry.getAttribute('color')
    const face = new Color()
    const line = new Color()
    let changed = false
    for (const [i, feature] of entry.features.entries()) {
      const match =
        typeof target === 'object' ? feature === target : feature.id === target
      if (!match) continue
      if (color) face.copy(color)
      else this.baseColor(feature, face)
      this.lineColor(face, line)
      for (let v = entry.starts[i]; v < entry.starts[i + 1]; v++) {
        faces?.setXYZ(v, face.r, face.g, face.b)
      }
      for (let v = entry.lineStarts[i]; v < entry.lineStarts[i + 1]; v++) {
        lines?.setXYZ(v, line.r, line.g, line.b)
      }
      changed = true
    }
    if (changed && faces) faces.needsUpdate = true
    if (changed && lines) lines.needsUpdate = true
  }
}

/** Index of the building a vertex belongs to: the last start at or before it. */
function featureIndex(starts: readonly number[], vertex: number) {
  let low = 0
  let high = starts.length - 2
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (starts[mid] <= vertex) low = mid
    else high = mid - 1
  }
  return low
}

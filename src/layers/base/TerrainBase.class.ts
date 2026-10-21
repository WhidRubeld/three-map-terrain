import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Vector3
} from 'three'

import { Utils } from '../../geo/Utils.class'
import type { Map, MapLayer } from '../../terrain/Map.class'
import type { MaterialOptions } from '../../terrain/material'
import type { Tile } from '../../terrain/Tile.class'

export interface TerrainBaseOptions {
  /** Meters the base reaches below the lowest point of the terrain. */
  depth: number
  /**
   * How it is drawn — by default like the terrain, in a darker shade of its
   * color — or your own material.
   */
  material?: Partial<MaterialOptions> | Material
}

export const defaultTerrainBaseOptions: Readonly<
  Omit<TerrainBaseOptions, 'material'>
> = Object.freeze({ depth: 50 })

/** The terrain's color times this, for the sides. */
const SIDE_SHADE = 0.72

/**
 * Closes the terrain into a solid block — side walls down from its outer
 * edges and a bottom — as a `MapLayer`: `map.addLayer(new TerrainBase())`.
 * A cut-out of the world for a diorama look, and a closed model to export
 * (`map.export('stl')` for 3D printing). It follows the loaded tiles; in
 * wireframe it is drawn as its outline.
 */
export class TerrainBase implements MapLayer {
  readonly options: Omit<TerrainBaseOptions, 'material'> &
    Pick<TerrainBaseOptions, 'material'>
  /** Holds the base mesh; added to `map.terrain`. */
  readonly group = new Group()
  map: Map | undefined

  private object:
    | Mesh<BufferGeometry, Material>
    | LineSegments<BufferGeometry, Material>
    | undefined
  private material: Material | undefined
  private ownMaterial = false
  private wireframe = false

  constructor(options: Partial<TerrainBaseOptions> = {}) {
    this.options = { ...defaultTerrainBaseOptions, ...options }
    this.group.name = 'terrain base'
  }

  attach(map: Map) {
    this.map = map
    map.terrain.add(this.group)
    this.setupMaterial(map)
    this.update()
  }

  detach() {
    this.removeObject()
    this.group.removeFromParent()
    if (this.ownMaterial) this.material?.dispose()
    this.material = undefined
    this.map = undefined
  }

  tileLoaded() {
    this.update()
  }

  tileRemoved(tile: Tile) {
    this.update(tile)
  }

  materialChanged(map: Map) {
    if (this.ownMaterial) this.material?.dispose()
    this.setupMaterial(map)
    this.update()
  }

  private setupMaterial(map: Map) {
    const { material } = this.options
    const style = {
      ...map.materialOptions,
      ...(material instanceof Material ? {} : material)
    }
    this.wireframe = style.wireframe
    if (material instanceof Material) {
      this.material = material
      this.ownMaterial = false
      return
    }
    const color =
      material?.color === undefined
        ? new Color(style.color ?? 0xffffff).multiplyScalar(SIDE_SHADE)
        : new Color(material.color)
    const { fog } = style
    this.material = this.wireframe
      ? new LineBasicMaterial({ color, fog })
      : style.lights
        ? new MeshLambertMaterial({ color, fog })
        : new MeshBasicMaterial({ color, fog })
    this.ownMaterial = true
  }

  private removeObject() {
    this.object?.removeFromParent()
    this.object?.geometry.dispose()
    this.object = undefined
  }

  /** Rebuilds the base around the loaded tiles (but `without`). */
  private update(without?: Tile) {
    const { map, material } = this
    this.removeObject()
    if (!map || !material) return

    const tiles = Object.values(map.tileCache).filter(
      (tile) =>
        tile.loaded && tile.mesh.parent === map.terrain && tile !== without
    )
    if (tiles.length === 0) return
    const placed = new Set(tiles.map((tile) => tile.key()))
    const { tileSegments: n, tileSize, zScale } = map.options

    let low = Infinity
    for (const tile of tiles) {
      tile.geometry.computeBoundingBox()
      low = Math.min(low, tile.geometry.boundingBox?.min.z ?? Infinity)
    }
    const bottom = low - this.options.depth * zScale

    const builder = new SolidBuilder(this.wireframe)
    for (const tile of tiles) {
      const { x, y } = tile.mesh.position
      const position = tile.geometry.attributes.position
      const point = (index: number) =>
        new Vector3(
          x + position.getX(index),
          y + position.getY(index),
          position.getZ(index)
        )
      const edge = (indices: number[], outward: Vector3) => {
        builder.wall(indices.map(point), bottom, outward)
      }
      const open = (dx: number, dy: number) =>
        !placed.has(Utils.getTileKey(tile.z, tile.x + dx, tile.y + dy))
      const range = Array.from({ length: n + 1 }, (_, i) => i)

      // rows run north → south, columns west → east
      if (open(0, -1)) edge(range, new Vector3(0, 1, 0))
      if (open(0, 1))
        edge(
          range.map((i) => n * (n + 1) + i),
          new Vector3(0, -1, 0)
        )
      if (open(-1, 0))
        edge(
          range.map((i) => i * (n + 1)),
          new Vector3(-1, 0, 0)
        )
      if (open(1, 0))
        edge(
          range.map((i) => i * (n + 1) + n),
          new Vector3(1, 0, 0)
        )

      const half = tileSize / 2
      builder.floor(x - half, y - half, x + half, y + half, bottom)
    }

    const geometry = builder.build()
    this.object = this.wireframe
      ? new LineSegments(geometry, material)
      : new Mesh(geometry, material)
    this.object.name = 'terrain base'
    this.group.add(this.object)
  }
}

/** Walls and floors with flat normals, facing out — or their outline. */
class SolidBuilder {
  private readonly positions: number[] = []
  private readonly normals: number[] = []
  private readonly lines: number[] = []

  constructor(private readonly outline: boolean) {}

  private line(a: Vector3, b: Vector3) {
    this.lines.push(a.x, a.y, a.z, b.x, b.y, b.z)
  }

  private triangle(a: Vector3, b: Vector3, c: Vector3, outward: Vector3) {
    const normal = new Vector3()
      .subVectors(b, a)
      .cross(new Vector3().subVectors(c, a))
    // counter-clockwise seen from outside
    const [p, q] = normal.dot(outward) >= 0 ? [b, c] : [c, b]
    for (const vertex of [a, p, q]) {
      this.positions.push(vertex.x, vertex.y, vertex.z)
      this.normals.push(outward.x, outward.y, outward.z)
    }
  }

  /** A wall from the points of a terrain edge down to `bottom`. */
  wall(top: Vector3[], bottom: number, outward: Vector3) {
    if (this.outline) {
      // the profile of the terrain, the bottom edge, the corners
      for (let i = 0; i + 1 < top.length; i++) this.line(top[i], top[i + 1])
      const [first, last] = [top[0], top[top.length - 1]]
      const down = (point: Vector3) => new Vector3(point.x, point.y, bottom)
      this.line(down(first), down(last))
      this.line(first, down(first))
      this.line(last, down(last))
      return
    }
    for (let i = 0; i + 1 < top.length; i++) {
      const [a, b] = [top[i], top[i + 1]]
      const a0 = new Vector3(a.x, a.y, bottom)
      const b0 = new Vector3(b.x, b.y, bottom)
      this.triangle(a, a0, b0, outward)
      this.triangle(a, b0, b, outward)
    }
  }

  /** A floor facing down. */
  floor(x0: number, y0: number, x1: number, y1: number, z: number) {
    if (this.outline) return // its edges are the walls' bottom edges
    const down = new Vector3(0, 0, -1)
    const corners = [
      new Vector3(x0, y0, z),
      new Vector3(x1, y0, z),
      new Vector3(x1, y1, z),
      new Vector3(x0, y1, z)
    ]
    this.triangle(corners[0], corners[1], corners[2], down)
    this.triangle(corners[0], corners[2], corners[3], down)
  }

  build() {
    const geometry = new BufferGeometry()
    if (this.outline) {
      geometry.setAttribute(
        'position',
        new BufferAttribute(new Float32Array(this.lines), 3)
      )
      return geometry
    }
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(this.positions), 3)
    )
    geometry.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array(this.normals), 3)
    )
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }
}

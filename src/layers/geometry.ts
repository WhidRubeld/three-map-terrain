// Accumulates the geometry of one part of a layer's tile — faces or lines —
// with the attributes materials and picking read.

import { BufferAttribute, BufferGeometry, type Color } from 'three'

/**
 * Name of the per-vertex attribute holding the index of the feature a vertex
 * belongs to (in the tile's `features`): picking reads it, and shaders can.
 */
export const FEATURE_ATTRIBUTE = 'featureIndex'

/**
 * The faces of one part (walls, roofs, road surface…): `position`,
 * `normal`, `uv` (in meters, so that textures repeat per meter), `color`
 * and `featureIndex`, indexed.
 */
export class SurfaceBuilder {
  private readonly positions: number[] = []
  private readonly normals: number[] = []
  private readonly uvs: number[] = []
  private readonly colors: number[] = []
  private readonly features: number[] = []
  private readonly indices: number[] = []

  get vertexCount() {
    return this.positions.length / 3
  }

  /** Adds a vertex; returns its index. */
  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    color: Color,
    feature: number
  ): number {
    this.positions.push(x, y, z)
    this.normals.push(nx, ny, nz)
    this.uvs.push(u, v)
    this.colors.push(color.r, color.g, color.b)
    this.features.push(feature)
    return this.positions.length / 3 - 1
  }

  triangle(a: number, b: number, c: number) {
    this.indices.push(a, b, c)
  }

  /** The geometry, or `undefined` if nothing was added. */
  build(): BufferGeometry | undefined {
    if (this.indices.length === 0) return undefined
    const geometry = new BufferGeometry()
    const set = (name: string, values: number[], size: number) =>
      geometry.setAttribute(
        name,
        new BufferAttribute(new Float32Array(values), size)
      )
    set('position', this.positions, 3)
    set('normal', this.normals, 3)
    set('uv', this.uvs, 2)
    set('color', this.colors, 3)
    set(FEATURE_ATTRIBUTE, this.features, 1)
    const Indices = this.vertexCount > 65535 ? Uint32Array : Uint16Array
    geometry.setIndex(new BufferAttribute(new Indices(this.indices), 1))
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }
}

/** The lines of one part (edges, outlines), for `LineSegments`. */
export class LineBuilder {
  private readonly positions: number[] = []
  private readonly colors: number[] = []
  private readonly features: number[] = []

  get vertexCount() {
    return this.positions.length / 3
  }

  segment(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    color: Color,
    feature: number
  ) {
    this.positions.push(ax, ay, az, bx, by, bz)
    this.colors.push(color.r, color.g, color.b, color.r, color.g, color.b)
    this.features.push(feature, feature)
  }

  /** The geometry, or `undefined` if nothing was added. */
  build(): BufferGeometry | undefined {
    if (this.positions.length === 0) return undefined
    const geometry = new BufferGeometry()
    const set = (name: string, values: number[], size: number) =>
      geometry.setAttribute(
        name,
        new BufferAttribute(new Float32Array(values), size)
      )
    set('position', this.positions, 3)
    set('color', this.colors, 3)
    set(FEATURE_ATTRIBUTE, this.features, 1)
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    return geometry
  }
}

import getPixels from 'get-pixels'
import { Mesh, MeshNormalMaterial, PlaneGeometry } from 'three'
import ndarray from 'ndarray'

import { QuadTextureMaterial } from './quad-texture-material'
import { Utils } from './Utils.class'
import { Map } from './Map.class'

const tileMaterial = new MeshNormalMaterial({ wireframe: true })

export class Tile {
  map: Map
  x: number
  y: number
  z: number

  baseURL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'

  shape: number[] | null
  elevation: Float32Array | null

  seamX: boolean
  seamY: boolean

  mesh: Mesh
  geometry: PlaneGeometry

  constructor(map: Map, z: number, x: number, y: number) {
    this.map = map
    this.z = z
    this.x = x
    this.y = y

    this.shape = null
    this.elevation = null

    this.seamX = false
    this.seamY = false
  }

  key() {
    return Utils.getTileKey(this.z, this.x, this.y)
  }

  keyNeighX() {
    return `${this.z}/${this.x + 1}/${this.y}`
  }

  keyNeighY() {
    return `${this.z}/${this.x}/${this.y + 1}`
  }

  mapUrl() {
    return this.map.source.mapUrl(this.z, this.x, this.y)
  }

  url() {
    return `${this.baseURL}/${this.z}/${this.x}/${this.y}.png`
  }

  computeElevation(pixels: ndarray.NdArray<Uint8Array>) {
    this.shape = pixels.shape
    const elevation = new Float32Array(pixels.shape[0] * pixels.shape[1])
    for (let i = 0; i < pixels.shape[0]; i++) {
      for (let j = 0; j < pixels.shape[1]; j++) {
        const ij = i + pixels.shape[0] * j
        const rgba = ij * 4
        elevation[ij] =
          pixels.data[rgba] * 256.0 +
          pixels.data[rgba + 1] +
          pixels.data[rgba + 2] / 256.0 -
          32768.0
      }
    }
    this.elevation = elevation
  }

  buildGeometry() {
    const geometry = new PlaneGeometry(
      this.map.options.tileSize,
      this.map.options.tileSize,
      this.map.options.tileSegments,
      this.map.options.tileSegments
    )
    const nPosition = Math.sqrt(geometry.attributes.position.count)
    const nElevation = Math.sqrt(this.elevation?.length || 0)
    const ratio = nElevation / (nPosition - 1)
    let x, y
    for (let i = 0; i < geometry.attributes.position.count - nPosition; i++) {
      if (i % nPosition === nPosition - 1) continue
      x = Math.floor(i / nPosition)
      y = i % nPosition

      if (!this.elevation) break
      const elevation =
        this.elevation[
          Math.round(Math.round(x * ratio) * nElevation + y * ratio)
        ] * this.map.options.zScale

      geometry.attributes.position.setZ(i, elevation)
    }
    geometry.computeVertexNormals()
    this.geometry = geometry
  }

  childrens() {
    return [
      new Tile(this.map, this.z + 1, this.x * 2, this.y * 2),
      new Tile(this.map, this.z + 1, this.x * 2, this.y * 2 + 1),
      new Tile(this.map, this.z + 1, this.x * 2 + 1, this.y * 2),
      new Tile(this.map, this.z + 1, this.x * 2 + 1, this.y * 2 + 1)
    ]
  }

  buildMaterial() {
    const urls = this.childrens().map((tile) => tile.mapUrl())
    return QuadTextureMaterial(urls, this.map.materialOptions)
  }

  buildmesh() {
    this.buildMaterial().then((material) => {
      this.mesh.material = material
    })
    this.mesh = new Mesh(this.geometry, tileMaterial)
  }

  fetch() {
    return new Promise<Tile>((resolve) => {
      getPixels(this.url(), (err, pixels) => {
        if (err) console.error(err)
        this.computeElevation(pixels)
        this.buildGeometry()
        this.buildmesh()
        resolve(this)
      })
    })
  }

  setPosition(center: { x: number; y: number }) {
    const { x, y, z } = Utils.tile2position(
      this.z,
      this.x,
      this.y,
      center,
      this.map.options.tileSize
    )
    this.mesh.position.set(x, y, z)
  }

  resolveSeamY(neighbor?: Tile) {
    const tPosition = this.mesh.geometry.attributes.position.count
    const nPosition = Math.sqrt(tPosition)

    if (neighbor) {
      const nPositionN = Math.sqrt(
        neighbor.mesh.geometry.attributes.position.count
      )
      if (nPosition !== nPositionN) {
        console.error(
          'resolveSeamY only implemented for geometries of same size'
        )
        return
      }
    }

    for (let i = tPosition - nPosition; i < tPosition; i++) {
      const z = neighbor
        ? neighbor.mesh.geometry.attributes.position.getZ(
            i - (tPosition - nPosition)
          )
        : this.mesh.geometry.attributes.position.getZ(i - nPosition)
      this.mesh.geometry.attributes.position.setZ(i, z)
    }
  }

  resolveSeamX(neighbor?: Tile) {
    const tPosition = this.mesh.geometry.attributes.position.count
    const nPosition = Math.sqrt(tPosition)

    if (neighbor) {
      const nPositionN = Math.sqrt(
        neighbor.mesh.geometry.attributes.position.count
      )
      if (nPosition !== nPositionN) {
        console.error(
          'resolveSeamX only implemented for geometries of same size'
        )
        return
      }
    }

    for (let i = nPosition - 1; i <= tPosition; i += nPosition) {
      const z = neighbor
        ? neighbor.mesh.geometry.attributes.position.getZ(i - nPosition + 1)
        : this.mesh.geometry.attributes.position.getZ(i - 1)
      this.mesh.geometry.attributes.position.setZ(i, z)
    }
  }

  resolveSeams(cache: { [key: string]: Tile }) {
    this.resolveSeamY(cache[this.keyNeighY()])
    this.resolveSeamX(cache[this.keyNeighX()])

    this.seamY = true
    this.seamX = true

    this.mesh.geometry.attributes.position.needsUpdate = true
    this.mesh.geometry.computeVertexNormals()
  }
}

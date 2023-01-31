import getPixels from 'get-pixels'
import { Mesh, MeshNormalMaterial, PlaneGeometry } from 'three'
import ndarray from 'ndarray'

import {
  QuadTextureMaterial,
  defaultTextureOptions,
  QuadTextureMaterialOptions
} from './quad-texture-material'
import { Utils } from './Utils.class'
import { defaultMapOptions, MapOptions } from './Map.class'

const tileMaterial = new MeshNormalMaterial({ wireframe: true })

export class Tile {
  x: number
  y: number
  z: number
  mapCenter: { x: number; y: number } = { x: 0, y: 0 }
  position: {
    x: number
    y: number
    z: number
  }

  mapUrl: string
  baseURL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
  shape: number[] | null = null
  elevation: Float32Array | null = null
  seamX = false
  seamY = false

  options = defaultMapOptions
  materialOptions = defaultTextureOptions
  mesh: Mesh = new Mesh()
  geometry = new PlaneGeometry()

  constructor(
    z: number,
    x: number,
    y: number,
    mapCenter: { x: number; y: number },
    mapUrl: string,
    options: MapOptions,
    materialOptions: QuadTextureMaterialOptions
  ) {
    this.z = z
    this.x = x
    this.y = y
    this.mapCenter = mapCenter
    this.position = Utils.tile2position(
      this.z,
      this.x,
      this.y,
      this.mapCenter,
      this.options.tileSize
    )
    this.mapUrl = mapUrl
    this.options = options
    this.materialOptions = materialOptions
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
      this.options.tileSize,
      this.options.tileSize,
      this.options.tileSegments,
      this.options.tileSegments
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
        ] * this.options.zScale

      geometry.attributes.position.setZ(i, elevation)
    }
    geometry.computeVertexNormals()
    this.geometry = geometry
  }

  childrens() {
    return [
      new Tile(
        this.z + 1,
        this.x * 2,
        this.y * 2,
        this.mapCenter,
        this.mapUrl,
        this.options,
        this.materialOptions
      ),
      new Tile(
        this.z + 1,
        this.x * 2,
        this.y * 2 + 1,
        this.mapCenter,
        this.mapUrl,
        this.options,
        this.materialOptions
      ),
      new Tile(
        this.z + 1,
        this.x * 2 + 1,
        this.y * 2,
        this.mapCenter,
        this.mapUrl,
        this.options,
        this.materialOptions
      ),
      new Tile(
        this.z + 1,
        this.x * 2 + 1,
        this.y * 2 + 1,
        this.mapCenter,
        this.mapUrl,
        this.options,
        this.materialOptions
      )
    ]
  }

  buildMaterial() {
    const urls = this.childrens().map((tile) => tile.mapUrl)
    return QuadTextureMaterial(urls, this.materialOptions)
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
        this.mesh.position.set(
          this.position.x,
          this.position.y,
          this.position.z
        )
        resolve(this)
      })
    })
  }

  resolveSeamY(neighbor: Tile) {
    const tPosition = this.mesh.geometry.attributes.position.count
    const nPosition = Math.sqrt(tPosition)
    const nPositionN = Math.sqrt(
      neighbor.mesh.geometry.attributes.position.count
    )
    if (nPosition !== nPositionN) {
      console.error('resolveSeamY only implemented for geometries of same size')
      return
    }
    for (let i = tPosition - nPosition; i < tPosition; i++) {
      this.mesh.geometry.attributes.position.setZ(
        i,
        neighbor.mesh.geometry.attributes.position.getZ(
          i - (tPosition - nPosition)
        )
      )
    }
  }

  resolveSeamX(neighbor: Tile) {
    const tPosition = this.mesh.geometry.attributes.position.count
    const nPosition = Math.sqrt(tPosition)
    const nPositionN = Math.sqrt(
      neighbor.mesh.geometry.attributes.position.count
    )
    if (nPosition !== nPositionN) {
      console.error('resolveSeamX only implemented for geometries of same size')
      return
    }
    for (let i = nPosition - 1; i < tPosition; i += nPosition) {
      this.mesh.geometry.attributes.position.setZ(
        i,
        neighbor.mesh.geometry.attributes.position.getZ(i - nPosition + 1)
      )
    }
  }

  resolveSeams(cache: { [key: string]: Tile }) {
    let worked = false
    const neighY = cache[this.keyNeighY()]
    const neighX = cache[this.keyNeighX()]
    if (this.seamY === false && neighY && neighY.mesh) {
      this.resolveSeamY(neighY)
      this.seamY = true
      worked = true
    }
    if (this.seamX === false && neighX && neighX.mesh) {
      this.resolveSeamX(neighX)
      this.seamX = true
      worked = true
    }
    if (worked) {
      this.mesh.geometry.attributes.position.needsUpdate = true
      this.mesh.geometry.computeVertexNormals()
    }
  }
}

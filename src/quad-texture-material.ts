import {
  CanvasTexture,
  type Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SRGBColorSpace,
  Texture
} from 'three'

import { createCanvas2D, loadImage, releaseImage } from './image'

export interface QuadTextureMaterialOptions {
  /** `true` → lit `MeshLambertMaterial`, `false` → unlit `MeshBasicMaterial` */
  lights: boolean
  wireframe: boolean
  fog: boolean
}

export const defaultTextureOptions: Readonly<QuadTextureMaterialOptions> =
  Object.freeze({
    lights: true,
    wireframe: false,
    fog: true
  })

/** Texture URLs of the four child tiles, in `[NW, SW, NE, SE]` order. */
export type QuadTextureUrls = readonly [
  nw: string,
  sw: string,
  ne: string,
  se: string
]

export type QuadTextureCanvas = HTMLCanvasElement | OffscreenCanvas

export type TileMaterial = MeshLambertMaterial | MeshBasicMaterial

const isRejected = (
  result: PromiseSettledResult<unknown>
): result is PromiseRejectedResult => result.status === 'rejected'

/**
 * Loads the four child tiles (zoom + 1) and stitches them into a single
 * texture laid out to match the `PlaneGeometry` UVs:
 *
 *     NW | NE
 *     ---+---
 *     SW | SE
 *
 * Built-in materials can then sample it as a regular `map`, so no custom
 * shader code depends on three.js internals.
 */
export async function loadQuadTexture(
  urls: QuadTextureUrls,
  signal?: AbortSignal
): Promise<CanvasTexture<QuadTextureCanvas>> {
  const results = await Promise.allSettled(
    urls.map((url) => loadImage(url, signal))
  )
  const images = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  )

  try {
    const failure = results.find(isRejected)
    if (failure) throw failure.reason

    const [nw, sw, ne, se] = images
    const width = Math.max(...images.map((image) => image.width))
    const height = Math.max(...images.map((image) => image.height))
    const { canvas, context } = createCanvas2D(width * 2, height * 2)

    context.drawImage(nw, 0, 0, width, height)
    context.drawImage(ne, width, 0, width, height)
    context.drawImage(sw, 0, height, width, height)
    context.drawImage(se, width, height, width, height)

    const texture = new CanvasTexture<QuadTextureCanvas>(canvas)
    texture.colorSpace = SRGBColorSpace
    return texture
  } finally {
    for (const image of images) releaseImage(image)
  }
}

export function createQuadTextureMaterial(
  map: Texture,
  options: Partial<QuadTextureMaterialOptions> = {}
): TileMaterial {
  const { lights, wireframe, fog } = { ...defaultTextureOptions, ...options }
  const parameters = { map, wireframe, fog }
  return lights
    ? new MeshLambertMaterial(parameters)
    : new MeshBasicMaterial(parameters)
}

export async function QuadTextureMaterial(
  urls: QuadTextureUrls,
  options: Partial<QuadTextureMaterialOptions> = {},
  signal?: AbortSignal
): Promise<TileMaterial> {
  return createQuadTextureMaterial(await loadQuadTexture(urls, signal), options)
}

/** Disposes a material together with its `map` texture. */
export function disposeMaterial(material: Material) {
  if ('map' in material && material.map instanceof Texture) {
    material.map.dispose()
  }
  material.dispose()
}

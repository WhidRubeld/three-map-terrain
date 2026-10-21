import {
  CanvasTexture,
  type ColorRepresentation,
  type Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SRGBColorSpace,
  Texture
} from 'three'

import { applyColorFilter, colorFilter } from './color-filter'
import { createCanvas2D, loadImage, releaseImage } from '../io/image'
import type { TileImageSource } from '../sources/Source.class'
import { type TileRegion, WHOLE_TILE } from '../sources/tile-source'

/**
 * How a surface is drawn. The terrain (the map's `material`) and the
 * buildings (their `material`, by default the map's) share these options.
 */
export interface MaterialOptions {
  /** `true` → lit `MeshLambertMaterial`, `false` → unlit `MeshBasicMaterial` */
  lights: boolean
  /** Draw lines: the terrain's triangles, the buildings' edges. */
  wireframe: boolean
  fog: boolean
  /**
   * The color of the surface. It tints imagery (white leaves it as it is);
   * without imagery (`source: { api: 'none' }`) the terrain has this color.
   * White by default.
   */
  color?: ColorRepresentation
}

export interface QuadTextureMaterialOptions extends MaterialOptions {
  /**
   * A CSS filter of color functions for the imagery, e.g. `'grayscale(1)'`
   * or `'saturate(0.4) brightness(1.1)'`, to tone it down to the buildings:
   * `grayscale`, `sepia`, `saturate`, `hue-rotate`, `invert`, `opacity`,
   * `brightness`, `contrast`. The library applies it to the pixels, so it
   * looks the same in every browser (Safari has no canvas filters).
   * `'none'` by default; an invalid filter is ignored with a warning.
   */
  filter?: string
}

export const defaultTextureOptions: Readonly<QuadTextureMaterialOptions> =
  Object.freeze({
    lights: true,
    wireframe: false,
    fog: true,
    color: 0xffffff,
    filter: 'none'
  })

/** Texture URLs of the four child tiles, in `[NW, SW, NE, SE]` order. */
export type QuadTextureUrls = readonly [
  nw: string,
  sw: string,
  ne: string,
  se: string
]

/** A child texture: an image, or the `region` of an ancestor's image. */
export interface QuadTextureTile {
  image: TileImageSource
  region?: TileRegion
}

/** A child texture by URL, or a function loading it. */
export type QuadTextureInput = string | (() => Promise<QuadTextureTile>)

/** The four child textures, in `[NW, SW, NE, SE]` order. */
export type QuadTextureInputs = readonly [
  nw: QuadTextureInput,
  sw: QuadTextureInput,
  ne: QuadTextureInput,
  se: QuadTextureInput
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
  inputs: QuadTextureInputs,
  signal?: AbortSignal,
  /** A CSS filter of color functions, e.g. `'grayscale(1)'` */
  filter = 'none'
): Promise<CanvasTexture<QuadTextureCanvas>> {
  const results = await Promise.allSettled(
    inputs.map((input) =>
      typeof input === 'string'
        ? loadImage(input, signal).then((image): QuadTextureTile => ({ image }))
        : input()
    )
  )
  const tiles = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : []
  )

  try {
    const failure = results.find(isRejected)
    if (failure) throw failure.reason

    const [nw, sw, ne, se] = tiles
    // children cut out of an ancestor keep the resolution they have there
    const size = (tile: QuadTextureTile, side: 'width' | 'height') =>
      Math.max(
        1,
        Math.round(tile.image[side] * (tile.region ?? WHOLE_TILE).size)
      )
    const width = Math.max(...tiles.map((tile) => size(tile, 'width')))
    const height = Math.max(...tiles.map((tile) => size(tile, 'height')))
    const steps = colorFilter(filter)
    const { canvas, context } = createCanvas2D(
      width * 2,
      height * 2,
      steps.length > 0 ? { willReadFrequently: true } : undefined
    )

    const draw = ({ image, region }: QuadTextureTile, x: number, y: number) => {
      if (!region || region.size === 1) {
        context.drawImage(image, x, y, width, height)
        return
      }
      const { width: w, height: h } = image
      context.drawImage(
        image,
        region.left * w,
        region.top * h,
        region.size * w,
        region.size * h,
        x,
        y,
        width,
        height
      )
    }
    draw(nw, 0, 0)
    draw(ne, width, 0)
    draw(sw, 0, height)
    draw(se, width, height)
    if (steps.length > 0) {
      const pixels = context.getImageData(0, 0, width * 2, height * 2)
      applyColorFilter(pixels.data, steps)
      context.putImageData(pixels, 0, 0)
    }

    const texture = new CanvasTexture<QuadTextureCanvas>(canvas)
    texture.colorSpace = SRGBColorSpace
    return texture
  } finally {
    // children cut out of one ancestor share its image
    for (const image of new Set(tiles.map((tile) => tile.image))) {
      releaseImage(image)
    }
  }
}

/** The terrain material: with the stitched imagery as `map`, or plain (`null`). */
export function createQuadTextureMaterial(
  map: Texture | null,
  options: Partial<MaterialOptions> = {}
): TileMaterial {
  const { lights, wireframe, fog, color } = {
    ...defaultTextureOptions,
    ...options
  }
  const parameters = { map, color: color ?? 0xffffff, wireframe, fog }
  return lights
    ? new MeshLambertMaterial(parameters)
    : new MeshBasicMaterial(parameters)
}

export async function QuadTextureMaterial(
  inputs: QuadTextureInputs,
  options: Partial<QuadTextureMaterialOptions> = {},
  signal?: AbortSignal
): Promise<TileMaterial> {
  return createQuadTextureMaterial(
    await loadQuadTexture(inputs, signal, options.filter),
    options
  )
}

/** Disposes a material together with its `map` texture. */
export function disposeMaterial(material: Material) {
  if ('map' in material && material.map instanceof Texture) {
    material.map.dispose()
  }
  material.dispose()
}

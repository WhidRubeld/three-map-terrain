import {
  CanvasTexture,
  type ColorRepresentation,
  type Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SRGBColorSpace,
  type Texture
} from 'three'

import {
  type Canvas2D,
  createCanvas2D,
  loadImage,
  releaseImage
} from '../io/image'
import type { TileImageSource } from '../sources/Source.class'
import { type TileRegion, WHOLE_TILE } from '../sources/tile-source'
import type { Tile } from './Tile.class'

/**
 * The look of a surface — the terrain's (the map's `material`) and, by
 * default, its layers': a starting point for the built-in materials. For
 * any other look, give the terrain a material factory (`create`) and the
 * layers their own materials.
 */
export interface MaterialOptions {
  /** `true` → lit `MeshLambertMaterial`, `false` → unlit `MeshBasicMaterial` */
  lights: boolean
  /** Draw lines: the terrain's triangles, the layers' edges. */
  wireframe: boolean
  fog: boolean
  /**
   * The color of the surface. It tints imagery (white leaves it as it is);
   * without imagery (`source: { api: 'none' }`) the terrain has this color.
   * White by default.
   */
  color?: ColorRepresentation
}

/** A 2D canvas context: what `process` draws on. */
export type Context2D = Canvas2D

/**
 * Draws on a tile's imagery once its four children are stitched, before it
 * becomes a texture — on the CPU: tone it (`getImageData` /
 * `putImageData`), blend in a hillshade, render your own data into it.
 */
export type ImageryProcessor = (
  context: Context2D,
  info: {
    readonly width: number
    readonly height: number
    /** The terrain tile. */
    readonly z: number
    readonly x: number
    readonly y: number
  }
) => void | Promise<void>

/** What a terrain tile's material is made of. */
export interface TerrainMaterialInput {
  /**
   * The tile's imagery: its four children at zoom + 1 stitched into one
   * sRGB texture (`NW | NE / SW | SE`, matching the mesh UVs), or `null`
   * without imagery. The tile owns and disposes it.
   */
  texture: Texture | null
  tile: Tile
  /** The map's material options. */
  options: TerrainMaterialOptions
}

/**
 * Makes the material of a terrain tile — any material: PBR maps, a
 * `ShaderMaterial`, a node material for `WebGPURenderer`. Called again for
 * every texture and every `setMaterial()`; the material is the tile's,
 * disposed when replaced (the imagery texture is not: the tile owns it).
 */
export type TerrainMaterialFactory = (input: TerrainMaterialInput) => Material

export interface TerrainMaterialOptions extends MaterialOptions {
  /** Draws on the stitched imagery before it becomes a texture. */
  process?: ImageryProcessor
  /** Makes the material; by default `createTerrainMaterial`, the look. */
  create?: TerrainMaterialFactory
}

export const defaultMaterialOptions: Readonly<TerrainMaterialOptions> =
  Object.freeze({
    lights: true,
    wireframe: false,
    fog: true,
    color: 0xffffff
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
  /** Draws on the stitched canvas (its context, width, height). */
  process?: (
    context: Context2D,
    width: number,
    height: number
  ) => void | Promise<void>
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
    const { canvas, context } = createCanvas2D(
      width * 2,
      height * 2,
      // processors mostly read the pixels
      process ? { willReadFrequently: true } : undefined
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
    if (process) {
      await process(context, width * 2, height * 2)
      signal?.throwIfAborted()
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

/**
 * The built-in terrain material, from the look: lit or unlit, with the
 * imagery as its `map` tinted by `color` (or plain in `color` without
 * imagery), in wireframe if asked.
 */
export function createTerrainMaterial({
  texture,
  options
}: Pick<TerrainMaterialInput, 'texture'> & {
  options: Partial<MaterialOptions>
}): MeshLambertMaterial | MeshBasicMaterial {
  const { lights, wireframe, fog, color } = {
    ...defaultMaterialOptions,
    ...options
  }
  const parameters = { map: texture, color: color ?? 0xffffff, wireframe, fog }
  return lights
    ? new MeshLambertMaterial(parameters)
    : new MeshBasicMaterial(parameters)
}

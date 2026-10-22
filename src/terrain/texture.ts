// A terrain tile's texture: imagery tiles stitched on one canvas. Internal;
// `loadQuadTexture` is the public way in.

import { CanvasTexture, SRGBColorSpace } from 'three'

import { createCanvas2D, loadImage, releaseImage } from '../io/image'
import { WHOLE_TILE } from '../sources/tile-source'
import type {
  Context2D,
  QuadTextureCanvas,
  QuadTextureInput,
  QuadTextureTile
} from './material'

const isRejected = (
  result: PromiseSettledResult<unknown>
): result is PromiseRejectedResult => result.status === 'rejected'

/**
 * Loads `k × k` imagery tiles — column by column from the west, each from
 * the north: `[NW, SW, NE, SE]` for 2 × 2 — and stitches them into one
 * texture laid out to match the `PlaneGeometry` UVs.
 */
export async function loadTextureGrid(
  inputs: readonly QuadTextureInput[],
  signal?: AbortSignal,
  /** Draws on the stitched canvas (its context, width, height). */
  process?: (
    context: Context2D,
    width: number,
    height: number
  ) => void | Promise<void>
): Promise<CanvasTexture<QuadTextureCanvas>> {
  const k = Math.round(Math.sqrt(inputs.length))
  if (k < 1 || k * k !== inputs.length) {
    throw new Error(`A texture of ${String(inputs.length)} tiles is no square`)
  }
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

    // tiles cut out of an ancestor keep the resolution they have there
    const size = (tile: QuadTextureTile, side: 'width' | 'height') =>
      Math.max(
        1,
        Math.round(tile.image[side] * (tile.region ?? WHOLE_TILE).size)
      )
    const width = Math.max(...tiles.map((tile) => size(tile, 'width')))
    const height = Math.max(...tiles.map((tile) => size(tile, 'height')))
    const { canvas, context } = createCanvas2D(
      width * k,
      height * k,
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
    // row by row, as the canvas is laid out
    for (let row = 0; row < k; row++) {
      for (let col = 0; col < k; col++) {
        draw(tiles[col * k + row], col * width, row * height)
      }
    }
    if (process) {
      await process(context, width * k, height * k)
      signal?.throwIfAborted()
    }

    const texture = new CanvasTexture<QuadTextureCanvas>(canvas)
    texture.colorSpace = SRGBColorSpace
    return texture
  } finally {
    // tiles cut out of one ancestor share its image
    for (const image of new Set(tiles.map((tile) => tile.image))) {
      releaseImage(image)
    }
  }
}

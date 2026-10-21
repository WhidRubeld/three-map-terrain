// Browser-native image helpers (replace get-pixels + Node polyfills).

import { fetchResponse, readBody, retry, TransientError } from './fetch'
import type { TileImageSource } from '../sources/Source.class'

export type Canvas2D =
  CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export type DecodedImage = ImageBitmap | HTMLImageElement

/** The body arrived but could not be decoded (e.g. truncated by the server). */
class DecodeError extends TransientError {}

export function createCanvas2D(
  width: number,
  height: number,
  settings?: CanvasRenderingContext2DSettings
): { canvas: HTMLCanvasElement | OffscreenCanvas; context: Canvas2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', settings)
    if (context) return { canvas, context }
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', settings)
  if (!context) throw new Error('2D canvas context is not available')
  return { canvas, context }
}

async function fetchBlob(
  url: string,
  signal: AbortSignal | undefined,
  cache: RequestCache
): Promise<Blob> {
  const response = await fetchResponse(url, signal, cache)
  return readBody(url, () => response.blob())
}

type FetchedImage =
  | { bitmap: ImageBitmap }
  | { bitmap?: undefined; blob: Blob; error: DecodeError }

/** Fetches and decodes with retries; returns the last undecodable body. */
async function fetchImageBitmap(
  url: string,
  signal: AbortSignal | undefined,
  options?: ImageBitmapOptions
): Promise<FetchedImage> {
  let blob: Blob | undefined
  try {
    return await retry(signal, async (index) => {
      blob = await fetchBlob(url, signal, index === 0 ? 'default' : 'reload')
      try {
        return { bitmap: await createImageBitmap(blob, options) }
      } catch (cause) {
        throw new DecodeError(`Failed to decode ${url}`, { cause })
      }
    })
  } catch (error) {
    if (!(error instanceof DecodeError) || !blob) throw error
    return { blob, error }
  }
}

async function decodeWithImageElement(blob: Blob): Promise<HTMLImageElement> {
  const objectUrl = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = objectUrl
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

/**
 * Loads an image for display, retrying transient failures. If the file still
 * cannot be decoded (tile servers occasionally send truncated bodies), fall
 * back to `<img>`, which renders whatever was received — like
 * `THREE.TextureLoader` would.
 */
export async function loadImage(
  url: string,
  signal?: AbortSignal
): Promise<DecodedImage> {
  const result = await fetchImageBitmap(url, signal)
  if (result.bitmap) return result.bitmap
  if (typeof Image === 'undefined') throw result.error
  return decodeWithImageElement(result.blob).catch(() => {
    throw result.error
  })
}

/** Closes `ImageBitmap`s; other images are left to the garbage collector. */
export function releaseImage(image: TileImageSource) {
  if ('close' in image) image.close()
}

/**
 * Loads an image and returns its raw RGBA pixels without color management.
 * Strict on purpose: a partially decoded elevation tile would produce bogus
 * terrain, so it is better to fail.
 */
export async function loadImageData(
  url: string,
  signal?: AbortSignal
): Promise<ImageData> {
  const result = await fetchImageBitmap(url, signal, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none'
  })
  if (!result.bitmap) throw result.error
  const { bitmap } = result
  try {
    const { context } = createCanvas2D(bitmap.width, bitmap.height, {
      willReadFrequently: true
    })
    context.drawImage(bitmap, 0, 0)
    return context.getImageData(0, 0, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

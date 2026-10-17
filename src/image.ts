// Browser-native image helpers (replace get-pixels + Node polyfills).

export type Canvas2D = CanvasDrawImage & CanvasImageData

export type DecodedImage = ImageBitmap | HTMLImageElement

/** Backoff before each retry of a transient failure, in ms. */
export const RETRY_DELAYS = [250, 1000, 3000] as const

/** HTTP statuses worth another attempt (timeouts, rate limits, server errors). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/** A failure that may succeed on another attempt. */
class TransientError extends Error {}

/** The body arrived but could not be decoded (e.g. truncated by the server). */
class DecodeError extends TransientError {}

export const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError'

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

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason as Error)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })

/** Runs `attempt` again after `TransientError`s, up to `RETRY_DELAYS.length` times. */
async function retry<T>(
  signal: AbortSignal | undefined,
  attempt: (index: number) => Promise<T>
): Promise<T> {
  for (let index = 0; ; index++) {
    try {
      return await attempt(index)
    } catch (error) {
      if (!(error instanceof TransientError)) throw error
      if (index >= RETRY_DELAYS.length) throw error
      await delay(RETRY_DELAYS[index], signal)
    }
  }
}

async function fetchBlob(
  url: string,
  signal: AbortSignal | undefined,
  // a retry must not get the same broken response from the HTTP cache
  cache: RequestCache
): Promise<Blob> {
  try {
    const response = await fetch(url, {
      signal,
      mode: 'cors',
      credentials: 'omit',
      cache
    })
    if (!response.ok) {
      const message = `Failed to load ${url}: ${response.status} ${response.statusText}`
      throw RETRYABLE_STATUS.has(response.status)
        ? new TransientError(message)
        : new Error(message)
    }
    return await response.blob()
  } catch (error) {
    // fetch() and body reads reject with TypeError on network failures
    if (!(error instanceof TypeError)) throw error
    throw new TransientError(`Failed to load ${url}`, { cause: error })
  }
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

export function releaseImage(image: DecodedImage) {
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

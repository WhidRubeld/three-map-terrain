// Browser-native image helpers (replace get-pixels + Node polyfills).

export type Canvas2D = CanvasDrawImage & CanvasImageData

export type DecodedImage = ImageBitmap | HTMLImageElement

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

async function fetchBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, {
    signal,
    mode: 'cors',
    credentials: 'omit'
  })
  if (!response.ok) {
    throw new Error(
      `Failed to load ${url}: ${response.status} ${response.statusText}`
    )
  }
  return response.blob()
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
 * Loads an image for display. `createImageBitmap` rejects truncated files
 * (tile servers occasionally send them), while `<img>` renders whatever was
 * received — so fall back to it, like `THREE.TextureLoader` would.
 */
export async function loadImage(
  url: string,
  signal?: AbortSignal
): Promise<DecodedImage> {
  const blob = await fetchBlob(url, signal)
  try {
    return await createImageBitmap(blob)
  } catch (cause) {
    if (typeof Image === 'undefined') {
      throw new Error(`Failed to decode ${url}`, { cause })
    }
    return decodeWithImageElement(blob).catch(() => {
      throw new Error(`Failed to decode ${url}`, { cause })
    })
  }
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
  const blob = await fetchBlob(url, signal)
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none'
  }).catch((cause: unknown) => {
    throw new Error(`Failed to decode ${url}`, { cause })
  })
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

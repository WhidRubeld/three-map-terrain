// Fakes for the browser image APIs used by src/image.ts (Node has none).
import { vi } from 'vitest'

export interface FakeBitmap {
  url: string
  width: number
  height: number
  close: () => void
}

/** Minimal OffscreenCanvas that records draw calls. */
export class FakeOffscreenCanvas {
  static instances: FakeOffscreenCanvas[] = []
  draws: {
    url: string
    x: number
    y: number
    w: number
    h: number
    /** source rectangle `[sx, sy, sw, sh]` of a 9-argument draw */
    crop?: number[]
    /** the context's `filter`, if not `'none'` */
    filter?: string
  }[] = []
  /** `getImageData` rectangles `[x, y, w, h]` */
  reads: number[][] = []
  /** `putImageData` calls */
  puts: { data: Uint8ClampedArray; x: number; y: number }[] = []
  contextSettings: unknown

  constructor(
    public width: number,
    public height: number
  ) {
    FakeOffscreenCanvas.instances.push(this)
  }

  getContext(_type: '2d', settings?: unknown) {
    this.contextSettings = settings
    const { draws, reads, puts } = this
    return {
      filter: 'none',
      drawImage(image: FakeBitmap, ...args: number[]) {
        const filter = this.filter === 'none' ? {} : { filter: this.filter }
        if (args.length === 8) {
          const [sx, sy, sw, sh, x, y, w, h] = args
          return draws.push({
            url: image.url,
            x,
            y,
            w,
            h,
            crop: [sx, sy, sw, sh],
            ...filter
          })
        }
        const [x, y, w = image.width, h = image.height] = args
        return draws.push({ url: image.url, x, y, w, h, ...filter })
      },
      getImageData: (x: number, y: number, width: number, height: number) => {
        reads.push([x, y, width, height])
        return {
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4)
        }
      },
      putImageData: (
        image: { data: Uint8ClampedArray },
        x: number,
        y: number
      ) => puts.push({ data: image.data, x, y })
    }
  }
}

/** `<img>` stand-in: decodes anything except bodies containing "corrupt". */
class FakeImage {
  url = ''
  width = 256
  height = 256
  private blobUrl = ''

  set src(value: string) {
    this.blobUrl = value
  }

  async decode() {
    const blob = await (await realFetch(this.blobUrl)).blob()
    this.url = `img:${await blob.text()}`
    if (this.url.includes('corrupt')) {
      throw new DOMException('bad', 'EncodingError')
    }
  }
}

/** Decoded bitmaps, in creation order. */
export const bitmaps: FakeBitmap[] = []

/** Rejects bodies containing "truncated" or "corrupt", like Chrome does. */
export const createImageBitmap = vi.fn(
  async (blob: Blob, _options?: unknown) => {
    const url = await blob.text()
    if (url.includes('truncated') || url.includes('corrupt')) {
      throw new DOMException('could not be decoded', 'InvalidStateError')
    }
    const bitmap: FakeBitmap = { url, width: 256, height: 256, close: vi.fn() }
    bitmaps.push(bitmap)
    return bitmap
  }
)

export type Reply = 'network-error' | 'truncated' | number

/**
 * Scripted replies per URL, consumed one per request. Without a script the
 * body is the URL itself, and URLs containing "missing" answer 404.
 */
export const replies = new Map<string, Reply[]>()

export const fetch = vi.fn((url: string, _init?: RequestInit) => {
  const reply = replies.get(url)?.shift()
  if (reply === 'network-error') {
    return Promise.reject(new TypeError('Failed to fetch'))
  }
  const status = typeof reply === 'number' ? reply : undefined
  if (status !== undefined || url.includes('missing')) {
    return Promise.resolve(
      new Response(null, { status: status ?? 404, statusText: 'Nope' })
    )
  }
  const body = reply === 'truncated' ? `${url}#truncated` : url
  return Promise.resolve(new Response(new Blob([body])))
})

const realFetch = globalThis.fetch

export function installBrowserFakes() {
  FakeOffscreenCanvas.instances = []
  bitmaps.length = 0
  replies.clear()
  fetch.mockClear()
  createImageBitmap.mockClear()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  vi.stubGlobal('createImageBitmap', createImageBitmap)
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    url.startsWith('blob:') ? realFetch(url) : fetch(url, init)
  )
}

/** Advances the fake clock (retry backoff) until `promise` settles. */
export async function settle<T>(promise: Promise<T>): Promise<T> {
  const state = { settled: false }
  const done = () => {
    state.settled = true
  }
  void promise.then(done, done)
  for (let i = 0; i < 100 && !state.settled; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(50)
  }
  return promise
}

/** `FileReader` for GLTFExporter (Node has none). */
export class FakeFileReader {
  result: ArrayBuffer | string | null = null
  onloadend: (() => void) | null = null

  readAsArrayBuffer(blob: Blob) {
    void blob.arrayBuffer().then((buffer) => {
      this.result = buffer
      this.onloadend?.()
    })
  }

  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((buffer) => {
      const base64 = Buffer.from(buffer).toString('base64')
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${base64}`
      this.onloadend?.()
    })
  }
}

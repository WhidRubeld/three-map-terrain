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
  draws: { url: string; x: number; y: number; w: number; h: number }[] = []
  contextSettings: unknown

  constructor(
    public width: number,
    public height: number
  ) {
    FakeOffscreenCanvas.instances.push(this)
  }

  getContext(_type: '2d', settings?: unknown) {
    this.contextSettings = settings
    return {
      drawImage: (
        image: FakeBitmap,
        x: number,
        y: number,
        w = image.width,
        h = image.height
      ) => this.draws.push({ url: image.url, x, y, w, h }),
      getImageData: (x: number, y: number, width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4)
      })
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

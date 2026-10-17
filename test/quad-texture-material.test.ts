import {
  MeshBasicMaterial,
  MeshLambertMaterial,
  SRGBColorSpace,
  Texture
} from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createQuadTextureMaterial,
  defaultTextureOptions,
  disposeMaterial,
  loadQuadTexture,
  QuadTextureMaterial
} from '../src'
import { loadImageData } from '../src/image'

interface FakeBitmap {
  url: string
  width: number
  height: number
  close: () => void
}

/** Minimal OffscreenCanvas that records draw calls. */
class FakeOffscreenCanvas {
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

/** `<img>` stand-in: decodes anything except blobs containing "corrupt". */
class FakeImage {
  url = ''
  width = 256
  height = 256
  private blobUrl = ''

  set src(value: string) {
    this.blobUrl = value
  }

  async decode() {
    const blob = await (await globalThis.fetch(this.blobUrl)).blob()
    this.url = `img:${await blob.text()}`
    if (this.url.includes('corrupt'))
      throw new DOMException('bad', 'EncodingError')
  }
}

const bitmaps: FakeBitmap[] = []
const createImageBitmap = vi.fn(async (blob: Blob, _options?: unknown) => {
  const url = await blob.text()
  if (url.includes('truncated') || url.includes('corrupt')) {
    throw new DOMException('could not be decoded', 'InvalidStateError')
  }
  const bitmap: FakeBitmap = { url, width: 256, height: 256, close: vi.fn() }
  bitmaps.push(bitmap)
  return bitmap
})
const fetch = vi.fn((url: string, _init?: RequestInit) =>
  Promise.resolve(
    url.includes('missing')
      ? new Response(null, { status: 404, statusText: 'Not Found' })
      : new Response(new Blob([url]))
  )
)

const realFetch = globalThis.fetch

beforeEach(() => {
  FakeOffscreenCanvas.instances = []
  bitmaps.length = 0
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas)
  vi.stubGlobal('createImageBitmap', createImageBitmap)
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
    url.startsWith('blob:') ? realFetch(url) : fetch(url, init)
  )
})

describe('loadQuadTexture', () => {
  it('stitches NW/SW/NE/SE children into one 2×2 sRGB texture', async () => {
    const texture = await loadQuadTexture(['nw', 'sw', 'ne', 'se'])
    const [canvas] = FakeOffscreenCanvas.instances

    expect(texture.image).toBe(canvas)
    expect(texture.colorSpace).toBe(SRGBColorSpace)
    expect(texture.flipY).toBe(true) // canvas top row → v = 1 → north
    expect([canvas.width, canvas.height]).toEqual([512, 512])
    expect(canvas.draws).toEqual([
      { url: 'nw', x: 0, y: 0, w: 256, h: 256 },
      { url: 'ne', x: 256, y: 0, w: 256, h: 256 },
      { url: 'sw', x: 0, y: 256, w: 256, h: 256 },
      { url: 'se', x: 256, y: 256, w: 256, h: 256 }
    ])
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalled()
  })

  it('fetches with CORS and forwards the abort signal', async () => {
    const controller = new AbortController()
    await loadQuadTexture(['a', 'b', 'c', 'd'], controller.signal)

    expect(fetch).toHaveBeenCalledWith('a', {
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit'
    })
  })

  it('falls back to <img> for textures createImageBitmap cannot decode', async () => {
    await loadQuadTexture(['nw', 'sw', 'ne-truncated', 'se'])
    const [canvas] = FakeOffscreenCanvas.instances

    expect(canvas.draws.map(({ url }) => url)).toEqual([
      'nw',
      'img:ne-truncated',
      'sw',
      'se'
    ])
  })

  it('rejects when no decoder can read a texture', async () => {
    await expect(
      loadQuadTexture(['nw', 'sw', 'ne-corrupt', 'se'])
    ).rejects.toThrow('Failed to decode ne-corrupt')
  })

  it('rejects on HTTP errors and releases the bitmaps already decoded', async () => {
    await expect(
      loadQuadTexture(['nw', 'sw', 'missing', 'se'])
    ).rejects.toThrow('Failed to load missing: 404 Not Found')

    expect(bitmaps).toHaveLength(3)
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalled()
  })
})

describe('loadImageData', () => {
  it('reads raw pixels without color-space conversion', async () => {
    const pixels = await loadImageData('elevation.png')

    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none'
    })
    expect(FakeOffscreenCanvas.instances[0].contextSettings).toEqual({
      willReadFrequently: true
    })
    expect([pixels.width, pixels.height]).toEqual([256, 256])
    expect(bitmaps[0].close).toHaveBeenCalled()
  })

  it('does not fall back to lenient decoding for elevation data', async () => {
    await expect(loadImageData('elevation-truncated.png')).rejects.toThrow(
      'Failed to decode elevation-truncated.png'
    )
  })
})

describe('createQuadTextureMaterial', () => {
  it('creates a lit Lambert material by default', () => {
    const map = new Texture()
    const material = createQuadTextureMaterial(map)

    expect(material).toBeInstanceOf(MeshLambertMaterial)
    expect(material.map).toBe(map)
    expect(material.fog).toBe(true)
    expect(material.wireframe).toBe(false)
  })

  it('creates an unlit material when lights are disabled', () => {
    const material = createQuadTextureMaterial(new Texture(), {
      lights: false,
      wireframe: true,
      fog: false
    })

    expect(material).toBeInstanceOf(MeshBasicMaterial)
    expect(material.wireframe).toBe(true)
    expect(material.fog).toBe(false)
  })

  it('never mutates the default options', () => {
    createQuadTextureMaterial(new Texture(), { lights: false })

    expect(defaultTextureOptions).toEqual({
      lights: true,
      wireframe: false,
      fog: true
    })
    expect(Object.isFrozen(defaultTextureOptions)).toBe(true)
  })
})

describe('QuadTextureMaterial', () => {
  it('loads the stitched texture into a material', async () => {
    const material = await QuadTextureMaterial(['a', 'b', 'c', 'd'], {
      lights: false
    })

    expect(material).toBeInstanceOf(MeshBasicMaterial)
    expect(material.map?.image).toBe(FakeOffscreenCanvas.instances[0])
  })
})

describe('disposeMaterial', () => {
  it('disposes the material and its map', () => {
    const map = new Texture()
    const material = new MeshLambertMaterial({ map })
    const disposeMap = vi.spyOn(map, 'dispose')
    const dispose = vi.spyOn(material, 'dispose')

    disposeMaterial(material)

    expect(disposeMap).toHaveBeenCalled()
    expect(dispose).toHaveBeenCalled()
  })
})

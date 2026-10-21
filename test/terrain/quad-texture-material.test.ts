import {
  Color,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SRGBColorSpace,
  Texture
} from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createQuadTextureMaterial,
  defaultTextureOptions,
  disposeMaterial,
  loadQuadTexture,
  QuadTextureMaterial
} from '../../src'
import {
  bitmaps,
  FakeOffscreenCanvas,
  fetch,
  installBrowserFakes,
  settle
} from '../support/browser-fakes'

beforeEach(installBrowserFakes)
afterEach(() => {
  vi.useRealTimers()
})

/** A fake decoded image (browser-fakes records draws by `url`) and its `close`. */
const fakeImage = (url: string) => {
  const close = vi.fn()
  const image = {
    url,
    width: 256,
    height: 256,
    close
  } as unknown as ImageBitmap
  return { image, close }
}

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

  it('applies the filter to the stitched pixels, not as a canvas filter', async () => {
    // the fake canvas reads transparent black: inverted, it turns white
    await loadQuadTexture(['nw', 'sw', 'ne', 'se'], undefined, 'invert(1)')
    const [canvas] = FakeOffscreenCanvas.instances

    // Safari has no canvas filter: the context's is never used
    for (const draw of canvas.draws) expect(draw.filter).toBeUndefined()
    expect(canvas.contextSettings).toEqual({ willReadFrequently: true })
    expect(canvas.reads).toEqual([[0, 0, 512, 512]])
    expect(canvas.puts).toHaveLength(1)
    const [{ data, x, y }] = canvas.puts
    expect([x, y, data.length]).toEqual([0, 0, 512 * 512 * 4])
    expect([...data.subarray(0, 8)]).toEqual([
      255, 255, 255, 0, 255, 255, 255, 0
    ])
  })

  it('reads no pixels without a filter, or with one that changes nothing', async () => {
    await loadQuadTexture(['nw', 'sw', 'ne', 'se'])
    await loadQuadTexture(['nw', 'sw', 'ne', 'se'], undefined, 'grayscale(0)')

    for (const canvas of FakeOffscreenCanvas.instances) {
      expect(canvas.contextSettings).toBeUndefined()
      expect([canvas.reads, canvas.puts]).toEqual([[], []])
    }
  })

  it('ignores an invalid filter with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await loadQuadTexture(['nw', 'sw', 'ne', 'se'], undefined, 'blur(2px)')
    const [canvas] = FakeOffscreenCanvas.instances

    expect(canvas.draws).toHaveLength(4)
    expect(canvas.puts).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('blur(2px)'))
  })

  it('forwards the abort signal to every request', async () => {
    const controller = new AbortController()
    await loadQuadTexture(['a', 'b', 'c', 'd'], controller.signal)

    for (const [, init] of fetch.mock.calls) {
      expect(init?.signal).toBe(controller.signal)
    }
  })

  it('falls back to <img> for textures createImageBitmap cannot decode', async () => {
    await settle(loadQuadTexture(['nw', 'sw', 'ne-truncated', 'se']))
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
      settle(loadQuadTexture(['nw', 'sw', 'ne-corrupt', 'se']))
    ).rejects.toThrow('Failed to decode ne-corrupt')
  })

  it('takes loaders, cutting children out of an ancestor', async () => {
    const parent = fakeImage('parent')
    const child = (left: number, top: number) => () =>
      Promise.resolve({
        image: parent.image,
        region: { left, top, size: 0.25 }
      })
    const own = fakeImage('own')

    await loadQuadTexture([
      child(0.5, 0.25),
      child(0.5, 0.5),
      () => Promise.resolve({ image: own.image }),
      'se'
    ])
    const [canvas] = FakeOffscreenCanvas.instances

    // cells take the largest child: 256 px
    expect([canvas.width, canvas.height]).toEqual([512, 512])
    expect(canvas.draws).toEqual([
      { url: 'parent', x: 0, y: 0, w: 256, h: 256, crop: [128, 64, 64, 64] },
      { url: 'own', x: 256, y: 0, w: 256, h: 256 },
      { url: 'parent', x: 0, y: 256, w: 256, h: 256, crop: [128, 128, 64, 64] },
      { url: 'se', x: 256, y: 256, w: 256, h: 256 }
    ])
    // the shared ancestor is closed once
    expect(parent.close).toHaveBeenCalledOnce()
    expect(own.close).toHaveBeenCalledOnce()
  })

  it('keeps the resolution of children cut out of an ancestor', async () => {
    const { image } = fakeImage('parent')
    const quarter = () =>
      Promise.resolve({ image, region: { left: 0, top: 0, size: 0.5 } })

    await loadQuadTexture([quarter, quarter, quarter, quarter])

    const [canvas] = FakeOffscreenCanvas.instances
    expect([canvas.width, canvas.height]).toEqual([256, 256])
  })

  it('rejects when a loader fails and releases the other images', async () => {
    const { image, close } = fakeImage('a')
    const ok = () => Promise.resolve({ image })

    await expect(
      loadQuadTexture([ok, ok, () => Promise.reject(new Error('no tile')), ok])
    ).rejects.toThrow('no tile')
    expect(close).toHaveBeenCalledOnce()
  })

  it('rejects on HTTP errors and releases the bitmaps already decoded', async () => {
    await expect(
      loadQuadTexture(['nw', 'sw', 'missing', 'se'])
    ).rejects.toThrow('Failed to load missing: 404 Nope')

    expect(bitmaps).toHaveLength(3)
    for (const bitmap of bitmaps) expect(bitmap.close).toHaveBeenCalled()
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

  it('creates a plain material in a color, without imagery', () => {
    const material = createQuadTextureMaterial(null, { color: '#e8e2d6' })

    expect(material.map).toBeNull()
    expect(material.color.equals(new Color('#e8e2d6'))).toBe(true)
  })

  it('tints the imagery with the color', () => {
    const map = new Texture()
    const material = createQuadTextureMaterial(map, { color: 0x808080 })

    expect(material.map).toBe(map)
    expect(material.color.equals(new Color(0x808080))).toBe(true)
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
      fog: true,
      color: 0xffffff,
      filter: 'none'
    })
    expect(Object.isFrozen(defaultTextureOptions)).toBe(true)
  })
})

describe('QuadTextureMaterial', () => {
  it('loads the stitched texture into a material', async () => {
    const material = await QuadTextureMaterial(['a', 'b', 'c', 'd'], {
      lights: false,
      filter: 'sepia(1)'
    })

    expect(material).toBeInstanceOf(MeshBasicMaterial)
    const [canvas] = FakeOffscreenCanvas.instances
    expect(material.map?.image).toBe(canvas)
    expect(canvas.puts).toHaveLength(1) // filtered
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

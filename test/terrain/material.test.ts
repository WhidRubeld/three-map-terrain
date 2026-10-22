import {
  Color,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SRGBColorSpace,
  Texture
} from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createTerrainMaterial,
  defaultMaterialOptions,
  loadQuadTexture
} from '../../src'
import { loadTextureGrid } from '../../src/terrain/texture'
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

  it('lets process draw on the stitched canvas before it becomes a texture', async () => {
    const order: string[] = []
    const process = vi.fn((context: unknown, width: number, height: number) => {
      const [canvas] = FakeOffscreenCanvas.instances
      order.push(`process after ${canvas.draws.length} draws`)
      expect([width, height]).toEqual([512, 512])
      expect(context).toBeDefined()
    })

    const texture = await loadQuadTexture(
      ['nw', 'sw', 'ne', 'se'],
      undefined,
      process
    )

    expect(order).toEqual(['process after 4 draws'])
    expect(texture.image).toBe(FakeOffscreenCanvas.instances[0])
    // processors mostly read the pixels
    expect(FakeOffscreenCanvas.instances[0].contextSettings).toEqual({
      willReadFrequently: true
    })
  })

  it('waits for an async process, and drops the result once aborted', async () => {
    const controller = new AbortController()
    const process = vi.fn(async () => {
      await Promise.resolve()
      controller.abort()
    })

    await expect(
      loadQuadTexture(['nw', 'sw', 'ne', 'se'], controller.signal, process)
    ).rejects.toThrow()
    expect(process).toHaveBeenCalledOnce()
  })

  it('asks for no pixel reads without a process', async () => {
    await loadQuadTexture(['nw', 'sw', 'ne', 'se'])
    const [canvas] = FakeOffscreenCanvas.instances

    expect(canvas.contextSettings).toBeUndefined()
    expect([canvas.reads, canvas.puts]).toEqual([[], []])
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

describe('loadTextureGrid', () => {
  it('stitches k × k tiles column by column, each from the north', async () => {
    const urls = Array.from(
      { length: 16 },
      (_, i) => `${String(Math.floor(i / 4))}${String(i % 4)}`
    )
    await loadTextureGrid(urls)
    const [canvas] = FakeOffscreenCanvas.instances

    expect([canvas.width, canvas.height]).toEqual([1024, 1024])
    expect(canvas.draws).toHaveLength(16)
    // url `${column}${row}` lands in its cell
    for (const { url, x, y } of canvas.draws as {
      url: string
      x: number
      y: number
    }[]) {
      expect([x / 256, y / 256]).toEqual([Number(url[0]), Number(url[1])])
    }
  })

  it('makes a texture of one tile', async () => {
    const texture = await loadTextureGrid(['own'])

    expect(texture.image).toBe(FakeOffscreenCanvas.instances[0])
    expect([texture.image.width, texture.image.height]).toEqual([256, 256])
  })

  it('rejects a grid that is no square', async () => {
    await expect(loadTextureGrid(['a', 'b'])).rejects.toThrow('no square')
  })
})

describe('createTerrainMaterial', () => {
  it('creates a lit Lambert material by default', () => {
    const texture = new Texture()
    const material = createTerrainMaterial({ texture, options: {} })

    expect(material).toBeInstanceOf(MeshLambertMaterial)
    expect(material.map).toBe(texture)
    expect(material.fog).toBe(true)
    expect(material.wireframe).toBe(false)
  })

  it('creates a plain material in a color, without imagery', () => {
    const material = createTerrainMaterial({
      texture: null,
      options: { color: '#e8e2d6' }
    })

    expect(material.map).toBeNull()
    expect(material.color.equals(new Color('#e8e2d6'))).toBe(true)
  })

  it('tints the imagery with the color', () => {
    const texture = new Texture()
    const material = createTerrainMaterial({
      texture,
      options: { color: 0x808080 }
    })

    expect(material.map).toBe(texture)
    expect(material.color.equals(new Color(0x808080))).toBe(true)
  })

  it('creates an unlit material when lights are disabled', () => {
    const material = createTerrainMaterial({
      texture: new Texture(),
      options: { lights: false, wireframe: true, fog: false }
    })

    expect(material).toBeInstanceOf(MeshBasicMaterial)
    expect(material.wireframe).toBe(true)
    expect(material.fog).toBe(false)
  })

  it('never mutates the default options', () => {
    createTerrainMaterial({
      texture: new Texture(),
      options: { lights: false }
    })

    expect(defaultMaterialOptions).toEqual({
      lights: true,
      wireframe: false,
      fog: true,
      color: 0xffffff
    })
    expect(Object.isFrozen(defaultMaterialOptions)).toBe(true)
  })
})

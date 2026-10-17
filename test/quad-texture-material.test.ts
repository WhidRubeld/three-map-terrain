import {
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
} from '../src'
import {
  bitmaps,
  FakeOffscreenCanvas,
  fetch,
  installBrowserFakes,
  settle
} from './browser-fakes'

beforeEach(installBrowserFakes)
afterEach(() => {
  vi.useRealTimers()
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

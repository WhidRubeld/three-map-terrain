import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  decodeMapbox,
  decodeTerrarium,
  ElevationSource,
  type ElevationSourceProps
} from '../../src'
import { HttpError } from '../../src/io/fetch'
import { encodeTerrarium } from '../support/helpers'

const { loadImageData } = vi.hoisted(() => ({ loadImageData: vi.fn() }))

vi.mock('../../src/io/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/io/image')>()),
  loadImageData
}))

const signal = new AbortController().signal
const pixels = { width: 1, height: 1, data: [0, 0, 0, 255] }

beforeEach(() => {
  loadImageData.mockResolvedValue(pixels)
})

describe('ElevationSource', () => {
  it.each([
    [
      { api: 'aws' },
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/12/2138/1447.png',
      15
    ],
    [
      { api: 'mapterhorn' },
      'https://tiles.mapterhorn.com/12/2138/1447.webp',
      Infinity
    ],
    [
      { api: 'mapbox', token: 'pk' },
      'https://api.mapbox.com/v4/mapbox.terrain-rgb/12/2138/1447.pngraw?access_token=pk',
      15
    ],
    [
      { api: 'maptiler', token: 'key' },
      'https://api.maptiler.com/tiles/terrain-rgb-v2/12/2138/1447.webp?key=key',
      14
    ]
  ] satisfies [ElevationSourceProps, string, number][])(
    'builds %o tile urls',
    (props, url, maxZoom) => {
      const source = new ElevationSource(props)
      expect(source.tileUrl(12, 2138, 1447)).toBe(url)
      expect(source.maxZoom).toBe(maxZoom)
      expect(source.attribution).not.toBe('')
    }
  )

  it('defaults to AWS terrarium tiles', () => {
    const source = new ElevationSource()
    expect(source.api).toBe('aws')
    expect(source.decode).toBe(decodeTerrarium)
  })

  it('uses the Mapbox encoding for Mapbox and MapTiler', () => {
    expect(new ElevationSource({ api: 'mapbox', token: 't' }).decode).toBe(
      decodeMapbox
    )
    expect(new ElevationSource({ api: 'maptiler', token: 't' }).decode).toBe(
      decodeMapbox
    )
  })

  it('takes custom urls, encodings and options', () => {
    const decode = (r: number) => r * 10
    const source = new ElevationSource({
      url: 'https://{s}.dem/{z}/{x}/{-y}.png',
      subdomains: ['x'],
      encoding: decode,
      maxZoom: 13,
      attribution: '© Me'
    })

    expect(source.api).toBe('custom')
    expect(source.tileUrl(2, 1, 0)).toBe('https://x.dem/2/1/3.png')
    expect(source.decode).toBe(decode)
    expect([source.maxZoom, source.attribution]).toEqual([13, '© Me'])
    expect(new ElevationSource({ url: 'u', encoding: 'mapbox' }).decode).toBe(
      decodeMapbox
    )
  })

  it('overrides preset options', () => {
    const source = new ElevationSource({
      api: 'mapterhorn',
      maxZoom: 12,
      attribution: 'x'
    })
    expect([source.maxZoom, source.attribution]).toEqual([12, 'x'])
  })

  it('rejects unknown apis and empty props', () => {
    expect(
      () =>
        new ElevationSource({ api: 'srtm' } as unknown as ElevationSourceProps)
    ).toThrow('Unknown elevation api: srtm')
    expect(() => new ElevationSource({})).toThrow(
      'needs an api, a url or a load'
    )
  })

  it('loads pixels without color management, null for missing tiles', async () => {
    const source = new ElevationSource()

    expect(await source.load({ z: 1, x: 0, y: 1, signal })).toBe(pixels)
    expect(loadImageData).toHaveBeenCalledWith(
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/1/0/1.png',
      signal
    )

    loadImageData.mockRejectedValueOnce(new HttpError('404', 404))
    expect(await source.load({ z: 16, x: 0, y: 1, signal })).toBeNull()

    loadImageData.mockRejectedValueOnce(new HttpError('403', 403))
    await expect(source.load({ z: 1, x: 0, y: 1, signal })).rejects.toThrow(
      '403'
    )
  })

  it('uses a custom loader', async () => {
    const load = vi.fn(() => Promise.resolve(pixels))
    const source = new ElevationSource({ load })

    expect(await source.load({ z: 1, x: 0, y: 1, signal })).toBe(pixels)
    expect(load).toHaveBeenCalledWith({ z: 1, x: 0, y: 1, signal })
    expect(source.tileUrl(1, 0, 1)).toBe('')
    expect(loadImageData).not.toHaveBeenCalled()
  })
})

describe('elevation decoders', () => {
  it('decode terrarium', () => {
    expect(decodeTerrarium(...encodeTerrarium(1234.5))).toBeCloseTo(1234.5, 2)
    expect(decodeTerrarium(128, 0, 0)).toBe(0)
  })

  it('decode the Mapbox encoding', () => {
    expect(decodeMapbox(1, 134, 160)).toBe(0)
    // 1000 m: (1000 + 10000) * 10 = 110000 = 1·65536 + 173·256 + 176
    expect(decodeMapbox(1, 173, 176)).toBeCloseTo(1000, 6)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Source, type SourceProps } from '../../src'
import { HttpError } from '../../src/io/fetch'

const { loadImage } = vi.hoisted(() => ({ loadImage: vi.fn() }))

vi.mock('../../src/io/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/io/image')>()),
  loadImage
}))

const signal = new AbortController().signal
const image = { width: 256, height: 256, close: vi.fn() }

beforeEach(() => {
  loadImage.mockResolvedValue(image)
})

describe('Source', () => {
  it.each([
    [{ api: 'osm' }, 'https://tile.openstreetmap.org/11/1069/724.png'],
    [
      { api: 'eox' },
      'https://tiles.maps.eox.at/wmts?layer=s2cloudless_3857&style=default&tilematrixset=g&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image%2Fjpeg&TileMatrix=11&TileCol=1069&TileRow=724'
    ],
    [
      { api: 'mapbox', token: 'pk.test' },
      'https://api.mapbox.com/v4/mapbox.satellite/11/1069/724@2x.jpg80?access_token=pk.test'
    ],
    [
      { api: 'maptiler', token: 'key' },
      'https://api.maptiler.com/tiles/satellite/11/1069/724.jpg?key=key'
    ]
  ] satisfies [SourceProps, string][])('builds %o tile urls', (props, url) => {
    const source = new Source(props)
    expect(source.tileUrl(11, 1069, 724)).toBe(url)
    expect(source.maxZoom).toBe(Infinity)
    expect(source.attribution).not.toBe('')
  })

  it('rejects unknown apis and empty props', () => {
    expect(
      () => new Source({ api: 'google' } as unknown as SourceProps)
    ).toThrow('Unknown source api: google')
    expect(
      () => new Source({ api: 'toString' } as unknown as SourceProps)
    ).toThrow('Unknown source api')
    expect(() => new Source({})).toThrow('Source needs an api, a url or a load')
  })

  it('builds urls from a template or a function', () => {
    const swisstopo = new Source({
      url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
      maxZoom: 20,
      attribution: '© swisstopo'
    })
    expect(swisstopo.api).toBe('custom')
    expect(swisstopo.tileUrl(15, 17061, 11532)).toBe(
      'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/15/17061/11532.jpeg'
    )
    expect([swisstopo.maxZoom, swisstopo.attribution]).toEqual([
      20,
      '© swisstopo'
    ])

    const esri = new Source({ url: (z, x, y) => `https://esri/${z}/${y}/${x}` })
    expect(esri.tileUrl(3, 1, 2)).toBe('https://esri/3/2/1')
    expect(
      new Source({ url: 'https://{s}.t/{z}', subdomains: 'q' }).tileUrl(1, 0, 0)
    ).toBe('https://q.t/1')
  })

  it('overrides preset options', () => {
    const source = new Source({ api: 'osm', maxZoom: 19, attribution: 'OSM' })
    expect([source.maxZoom, source.attribution]).toEqual([19, 'OSM'])
  })

  it('loads tiles by url, null when missing', async () => {
    const source = new Source({ api: 'osm' })

    expect(await source.load({ z: 2, x: 1, y: 3, signal })).toBe(image)
    expect(loadImage).toHaveBeenCalledWith(
      'https://tile.openstreetmap.org/2/1/3.png',
      signal
    )

    loadImage.mockRejectedValueOnce(new HttpError('404', 404))
    expect(await source.load({ z: 20, x: 1, y: 3, signal })).toBeNull()

    loadImage.mockRejectedValueOnce(new Error('broken'))
    await expect(source.load({ z: 2, x: 1, y: 3, signal })).rejects.toThrow(
      'broken'
    )
  })

  it('has no imagery with api none', async () => {
    const source = new Source({ api: 'none' })

    expect([source.api, source.attribution, source.tileUrl(1, 0, 0)]).toEqual([
      'none',
      '',
      ''
    ])
    expect(await source.load({ z: 1, x: 0, y: 0, signal })).toBeNull()
    expect(loadImage).not.toHaveBeenCalled()
  })

  it('uses a custom loader', async () => {
    const canvas = { width: 64, height: 64 } as HTMLCanvasElement
    const load = vi.fn(() => Promise.resolve(canvas))
    const source = new Source({ load })

    expect(await source.load({ z: 2, x: 1, y: 3, signal })).toBe(canvas)
    expect(load).toHaveBeenCalledWith({ z: 2, x: 1, y: 3, signal })
    expect(source.tileUrl(2, 1, 3)).toBe('')
    expect(loadImage).not.toHaveBeenCalled()
  })
})

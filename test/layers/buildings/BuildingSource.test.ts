import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type BuildingFeature,
  BuildingSource,
  type BuildingSourceProps,
  OVERPASS_ENDPOINT
} from '../../../src'
import { HttpError } from '../../../src/io/fetch'
import { encodeVectorTile } from '../../support/mvt-encoder'

const { loadArrayBuffer, loadJson } = vi.hoisted(() => ({
  loadArrayBuffer:
    vi.fn<
      (url: string, signal?: AbortSignal) => Promise<Uint8Array | undefined>
    >(),
  loadJson:
    vi.fn<
      (
        url: string,
        signal?: AbortSignal,
        options?: RequestInit
      ) => Promise<unknown>
    >()
}))

vi.mock('../../../src/io/fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/io/fetch')>()),
  loadArrayBuffer,
  loadJson
}))

const signal = new AbortController().signal
const tile = { z: 14, x: 8530, y: 5766, signal }

const vectorTile = (layer: string, properties = {}) =>
  encodeVectorTile([
    {
      name: layer,
      features: [
        {
          type: 3,
          properties,
          geometry: [[10, 10, 100, 10, 100, 100, 10, 100]]
        }
      ]
    }
  ])

beforeEach(() => {
  loadArrayBuffer.mockResolvedValue(
    vectorTile('building', { render_height: 12 })
  )
})

describe('BuildingSource', () => {
  it.each([
    [
      { api: 'versatiles' },
      'https://tiles.versatiles.org/tiles/osm/14/8530/5766',
      'buildings',
      [14, 14]
    ],
    [
      { api: 'maptiler', token: 'key' },
      'https://api.maptiler.com/tiles/v3/14/8530/5766.pbf?key=key',
      'building',
      [13, 14]
    ],
    [
      { api: 'mapbox', token: 'pk' },
      'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/14/8530/5766.vector.pbf?access_token=pk',
      'building',
      [15, 16]
    ],
    [
      { api: 'protomaps', token: 'key' },
      'https://api.protomaps.com/tiles/v4/14/8530/5766.mvt?key=key',
      'buildings',
      [14, 15]
    ]
  ] satisfies [BuildingSourceProps, string, string, number[]][])(
    'loads %o vector tiles',
    async (props, url, layer, zooms) => {
      loadArrayBuffer.mockResolvedValue(vectorTile(layer, { height: 7 }))
      const source = new BuildingSource(props)

      const buildings = await source.load(tile)

      // one shared request per tile: the source's own signal
      expect(loadArrayBuffer).toHaveBeenCalledWith(url, expect.any(AbortSignal))
      expect(buildings).toHaveLength(1)
      expect([source.minZoom, source.maxZoom]).toEqual(zooms)
      expect(source.attribution).toContain('OpenStreetMap')
    }
  )

  it('resolves the OpenFreeMap tiles from its TileJSON, once', async () => {
    loadJson.mockResolvedValue({
      tiles: ['https://tiles.openfreemap.org/planet/20261018/{z}/{x}/{y}.pbf']
    })
    const source = new BuildingSource({ api: 'openfreemap' })

    const [first] = await source.load(tile)
    await source.load({ ...tile, x: 8531 })

    expect(loadJson).toHaveBeenCalledExactlyOnceWith(
      'https://tiles.openfreemap.org/planet'
    )
    expect(loadArrayBuffer.mock.calls.map(([url]) => url)).toEqual([
      'https://tiles.openfreemap.org/planet/20261018/14/8530/5766.pbf',
      'https://tiles.openfreemap.org/planet/20261018/14/8531/5766.pbf'
    ])
    expect(first.height).toBe(12) // render_height
  })

  it('retries a failed TileJSON with the next tile', async () => {
    loadJson.mockRejectedValueOnce(new Error('offline'))
    loadJson.mockResolvedValueOnce({ tiles: ['tiles/{z}/{x}/{y}.pbf'] })
    const source = new BuildingSource({
      tilejson: 'https://host/data/tiles.json'
    })

    await expect(source.load(tile)).rejects.toThrow('offline')
    await source.load(tile)

    // relative tile URLs are resolved against the TileJSON
    expect(loadArrayBuffer).toHaveBeenCalledWith(
      'https://host/data/tiles/14/8530/5766.pbf',
      expect.any(AbortSignal)
    )
  })

  it('rejects a TileJSON without tiles', async () => {
    loadJson.mockResolvedValue({ name: 'nothing' })
    const source = new BuildingSource({ tilejson: 'https://host/tiles.json' })

    await expect(source.load(tile)).rejects.toThrow(
      'No tile URL in the TileJSON'
    )
  })

  it('reads any vector tile server with its own layer and fields', async () => {
    loadArrayBuffer.mockResolvedValue(vectorTile('bldg', { h: 33 }))
    const source = new BuildingSource({
      url: 'https://{s}.my/{z}/{x}/{y}.mvt',
      subdomains: 'a',
      layers: 'bldg',
      properties: (p) => ({ height: Number(p.h) }),
      minZoom: 15,
      maxZoom: 16,
      attribution: '© Me'
    })

    const [building] = await source.load(tile)

    expect(loadArrayBuffer).toHaveBeenCalledWith(
      'https://a.my/14/8530/5766.mvt',
      expect.any(AbortSignal)
    )
    expect(building.height).toBe(33)
    expect([
      source.api,
      source.minZoom,
      source.maxZoom,
      source.attribution
    ]).toEqual(['custom', 15, 16, '© Me'])
  })

  it('has no buildings for missing or empty tiles', async () => {
    const source = new BuildingSource({ api: 'versatiles' })

    loadArrayBuffer.mockRejectedValueOnce(new HttpError('404', 404))
    expect(await source.load(tile)).toEqual([])
    loadArrayBuffer.mockResolvedValueOnce(undefined) // 204
    expect(await source.load(tile)).toEqual([])
    loadArrayBuffer.mockRejectedValueOnce(new HttpError('500', 500))
    await expect(source.load(tile)).rejects.toThrow('500')
  })

  it('queries Overpass with a POST, one request at a time', async () => {
    const replies: ((value: unknown) => void)[] = []
    loadJson.mockImplementation(
      () => new Promise((resolve) => replies.push(resolve))
    )
    const source = new BuildingSource({ api: 'overpass' })

    const first = source.load(tile)
    const second = source.load({ ...tile, x: 8531 })
    await vi.waitFor(() => {
      expect(loadJson).toHaveBeenCalledOnce()
    })

    const [url, requestSignal, options] = loadJson.mock.calls[0] as [
      string,
      AbortSignal,
      { method: string; body: URLSearchParams }
    ]
    expect([url, requestSignal, options.method]).toEqual([
      OVERPASS_ENDPOINT,
      signal,
      'POST'
    ])
    expect(options.body.get('data')).toContain('way["building"](46.9')

    replies[0]({
      elements: [
        {
          type: 'way',
          id: 1,
          tags: { building: 'yes', 'building:levels': '2' },
          geometry: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
            { lat: 1, lon: 1 },
            { lat: 0, lon: 0 }
          ]
        }
      ]
    })
    expect(await first).toMatchObject([{ id: 'way/1', height: 6 }])
    await vi.waitFor(() => {
      expect(loadJson).toHaveBeenCalledTimes(2)
    })
    replies[1]({ elements: [] })
    expect(await second).toEqual([])
    expect(source.attribution).toBe('© OpenStreetMap contributors')
  })

  it('skips queued Overpass requests that were aborted', async () => {
    loadJson.mockResolvedValue({ elements: [] })
    const controller = new AbortController()
    controller.abort()
    const source = new BuildingSource({
      api: 'overpass',
      endpoint: 'https://my/overpass'
    })

    await expect(
      source.load({ ...tile, signal: controller.signal })
    ).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(loadJson).not.toHaveBeenCalled()
  })

  it('uses a custom loader', async () => {
    const buildings: BuildingFeature[] = [
      { geometry: { type: 'Polygon', coordinates: [] }, properties: {} }
    ]
    const load = vi.fn(() => Promise.resolve(buildings))
    const source = new BuildingSource({ load, maxZoom: 15 })

    expect(await source.load(tile)).toBe(buildings)
    expect(load).toHaveBeenCalledWith(tile)
    expect([source.minZoom, source.maxZoom]).toEqual([14, 15])
  })

  it('rejects unknown apis and empty props', () => {
    expect(
      () =>
        new BuildingSource({
          api: 'osmbuildings'
        } as unknown as BuildingSourceProps)
    ).toThrow('Unknown BuildingSource api: osmbuildings')
    expect(() => new BuildingSource({})).toThrow(
      'BuildingSource needs an api, tiles, a url, a tilejson or a load function'
    )
  })
})

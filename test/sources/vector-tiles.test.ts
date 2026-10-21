import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BuildingSource,
  RoadSource,
  VectorTiles,
  type RoadSourceProps
} from '../../src'
import { HttpError } from '../../src/io/fetch'
import { encodeVectorTile } from '../support/mvt-encoder'

const { loadArrayBuffer, loadJson } = vi.hoisted(() => ({
  loadArrayBuffer:
    vi.fn<
      (url: string, signal?: AbortSignal) => Promise<Uint8Array | undefined>
    >(),
  loadJson: vi.fn<(url: string) => Promise<unknown>>()
}))

vi.mock('../../src/io/fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/io/fetch')>()),
  loadArrayBuffer,
  loadJson
}))

const tile = { z: 14, x: 8530, y: 5766 }

/** A basemap tile with a building and a road. */
const basemap = () =>
  encodeVectorTile([
    {
      name: 'building',
      features: [
        {
          type: 3,
          properties: { render_height: 12 },
          geometry: [[10, 10, 100, 10, 100, 100, 10, 100]]
        }
      ]
    },
    {
      name: 'transportation',
      features: [
        {
          id: 42,
          type: 2,
          properties: { class: 'primary', brunnel: 'bridge', layer: 1 },
          geometry: [[0, 2048, 4096, 2048]]
        },
        {
          type: 2,
          properties: { class: 'ferry' },
          geometry: [[0, 100, 4096, 100]]
        }
      ]
    }
  ])

beforeEach(() => {
  loadArrayBuffer.mockResolvedValue(basemap())
})

describe('VectorTiles', () => {
  it('loads a tile once for every layer asking for it at the same time', async () => {
    const tiles = new VectorTiles({ url: 'https://my/{z}/{x}/{y}.pbf' })
    const buildings = new BuildingSource({ tiles })
    const roads = new RoadSource({ tiles })
    const signal = new AbortController().signal

    const [houses, streets] = await Promise.all([
      buildings.load({ ...tile, signal }),
      roads.load({ ...tile, signal })
    ])

    expect(loadArrayBuffer).toHaveBeenCalledOnce()
    expect(houses).toMatchObject([{ height: 12 }])
    expect(streets).toMatchObject([
      { id: 42, kind: 'primary', bridge: true, layer: 1 }
    ])
  })

  it('shares the tiles of a preset between the layers using it', async () => {
    loadJson.mockResolvedValue({ tiles: ['https://ofm/{z}/{x}/{y}.pbf'] })
    const signal = new AbortController().signal

    await Promise.all([
      new BuildingSource({ api: 'openfreemap' }).load({ ...tile, signal }),
      new RoadSource({ api: 'openfreemap' }).load({ ...tile, signal })
    ])

    expect(loadArrayBuffer).toHaveBeenCalledOnce()
    expect(VectorTiles.preset('openfreemap')).toBe(
      VectorTiles.preset('openfreemap')
    )
  })

  it('cancels a tile only when no layer wants it any more', async () => {
    let request: AbortSignal | undefined
    loadArrayBuffer.mockImplementation((_url, signal) => {
      request = signal
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
        setTimeout(() => {
          resolve(basemap())
        }, 10)
      })
    })
    const tiles = new VectorTiles({ url: 'https://my/{z}/{x}/{y}.pbf' })
    const [first, second] = [new AbortController(), new AbortController()]

    const a = tiles.load({ ...tile, signal: first.signal })
    const b = tiles.load({ ...tile, signal: second.signal })
    first.abort()

    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    expect(request?.aborted).toBe(false)
    expect((await b)?.layer('building')?.features).toHaveLength(1)

    const c = tiles.load({ ...tile, x: 1, signal: second.signal })
    second.abort()
    await expect(c).rejects.toMatchObject({ name: 'AbortError' })
    expect(request?.aborted).toBe(true)
  })

  it('has no tile where the server has none', async () => {
    loadArrayBuffer.mockRejectedValueOnce(new HttpError('404', 404))
    const tiles = new VectorTiles({ api: 'versatiles' })

    expect(
      await tiles.load({ ...tile, signal: new AbortController().signal })
    ).toBeUndefined()
  })

  it('knows the schema of its preset', () => {
    expect(new VectorTiles({ api: 'versatiles' }).schema).toBe('shortbread')
    expect(new VectorTiles({ api: 'mapbox', token: 't' }).schema).toBe('mapbox')
    expect(new VectorTiles({ url: 'https://my/{z}/{x}/{y}' }).schema).toBe(
      'openmaptiles'
    )
  })
})

describe('RoadSource', () => {
  it.each([
    [
      { api: 'versatiles' },
      'https://tiles.versatiles.org/tiles/osm/14/8530/5766',
      'streets',
      { kind: 'primary', bridge: true },
      [12, 14]
    ],
    [
      { api: 'mapbox', token: 'pk' },
      'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/14/8530/5766.vector.pbf?access_token=pk',
      'road',
      { class: 'primary', structure: 'bridge' },
      [12, 16]
    ],
    [
      { api: 'protomaps', token: 'key' },
      'https://api.protomaps.com/tiles/v4/14/8530/5766.mvt?key=key',
      'roads',
      { kind: 'major_road', kind_detail: 'primary', is_bridge: true },
      [12, 15]
    ]
  ] satisfies [RoadSourceProps, string, string, object, number[]][])(
    'loads %o vector tiles',
    async (props, url, layer, properties, zooms) => {
      loadArrayBuffer.mockResolvedValue(
        encodeVectorTile([
          {
            name: layer,
            features: [
              {
                type: 2,
                properties,
                geometry: [[0, 10, 4096, 10]]
              }
            ]
          }
        ])
      )
      const source = new RoadSource(props)

      const roads = await source.load({
        ...tile,
        signal: new AbortController().signal
      })

      expect(loadArrayBuffer).toHaveBeenCalledWith(url, expect.any(AbortSignal))
      expect(roads).toMatchObject([{ kind: 'primary', bridge: true }])
      expect([source.minZoom, source.maxZoom]).toEqual(zooms)
    }
  )

  it('reads any vector tiles with its own layers and fields', async () => {
    loadArrayBuffer.mockResolvedValue(
      encodeVectorTile([
        {
          name: 'ways',
          features: [
            { type: 2, properties: { t: 'rail' }, geometry: [[0, 0, 10, 10]] }
          ]
        }
      ])
    )
    const source = new RoadSource({
      url: 'https://my/{z}/{x}/{y}.mvt',
      layers: 'ways',
      properties: (p) => ({ kind: p.t === 'rail' ? 'rail' : undefined })
    })

    expect(
      await source.load({ ...tile, signal: new AbortController().signal })
    ).toMatchObject([{ kind: 'rail' }])
  })
})

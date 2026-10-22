import { describe, expect, it, vi } from 'vitest'

import {
  mapboxStreetsVegetationProperties,
  openMapTilesVegetationProperties,
  overpassVegetationQuery,
  protomapsVegetationProperties,
  shortbreadVegetationProperties,
  VegetationSource
} from '../../../src'
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
const square = [[10, 10, 100, 10, 100, 100, 10, 100]]

describe('VegetationSource', () => {
  it('reads woods and scrub from a preset, more with properties of yours', async () => {
    loadArrayBuffer.mockResolvedValue(
      encodeVectorTile([
        {
          name: 'land',
          features: [
            { type: 3, properties: { kind: 'forest' }, geometry: square },
            { type: 3, properties: { kind: 'scrub' }, geometry: square },
            { type: 3, properties: { kind: 'heath' }, geometry: square },
            { type: 3, properties: { kind: 'grass' }, geometry: square }
          ]
        }
      ])
    )
    const plain = new VegetationSource({ api: 'versatiles' })
    const more = new VegetationSource({
      api: 'versatiles',
      properties: (p, layer) =>
        p.kind === 'heath'
          ? { kind: 'heath' }
          : shortbreadVegetationProperties(p, layer)
    })

    expect((await plain.load(tile)).map((plant) => plant.kind)).toEqual([
      'forest',
      'scrub'
    ])
    expect((await more.load(tile)).map((plant) => plant.kind)).toEqual([
      'forest',
      'scrub',
      'heath'
    ])
    expect(more.tiles).toBe(plain.tiles)
  })

  it('reads the scrub of every basemap schema', () => {
    expect(
      openMapTilesVegetationProperties(
        { class: 'grass', subclass: 'shrubbery' },
        'landcover'
      )
    ).toEqual({ kind: 'shrubbery', hidden: false })
    expect(
      openMapTilesVegetationProperties(
        { class: 'grass', subclass: 'meadow' },
        'landcover'
      ).hidden
    ).toBe(true)
    // Mapbox's scrub takes in heaths: scrub all the same
    expect(
      mapboxStreetsVegetationProperties(
        { class: 'scrub', type: 'heath' },
        'landuse'
      )
    ).toEqual({ kind: 'scrub', hidden: false })
    expect(
      mapboxStreetsVegetationProperties(
        { class: 'wood', type: 'forest' },
        'landuse'
      )
    ).toEqual({ kind: 'forest', hidden: false })
    expect(
      protomapsVegetationProperties({ kind: 'scrub' }, 'landuse').hidden
    ).toBe(false)
    expect(
      protomapsVegetationProperties({ kind: 'grass' }, 'landuse').hidden
    ).toBe(true)
  })

  it('asks Overpass for scrub and shrubs, more with a query of yours', async () => {
    loadJson.mockResolvedValue({
      elements: [
        {
          type: 'way',
          id: 7,
          tags: { natural: 'scrub' },
          geometry: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
            { lat: 1, lon: 1 },
            { lat: 0, lon: 0 }
          ]
        },
        { type: 'node', id: 8, lat: 0.5, lon: 0.5, tags: { natural: 'shrub' } },
        { type: 'node', id: 9, lat: 0.5, lon: 0.6, tags: { natural: 'tree' } }
      ]
    })
    const source = new VegetationSource({
      api: 'overpass',
      endpoint: 'https://plants.test/overpass',
      query: (bbox) =>
        overpassVegetationQuery(bbox, ['way["landuse"="orchard"]'])
    })

    const plants = await source.load(tile)

    const [, , options] = loadJson.mock.calls[0] as [
      string,
      AbortSignal,
      { body: URLSearchParams }
    ]
    const query = options.body.get('data') ?? ''
    expect(query).toMatch(/^\[out:json\]/)
    expect(query).toContain('node["natural"="tree"](46.9')
    expect(query).toContain('node["natural"="shrub"](46.9')
    expect(query).toContain('way["natural"="scrub"](46.9')
    expect(query).toContain('way["landuse"="orchard"](46.9')
    expect(query).toMatch(/out body geom qt;$/)
    // their kind: the natural tag
    expect(plants).toMatchObject([
      { id: 'way/7', kind: 'scrub', geometry: { type: 'Polygon' } },
      { id: 'node/8', kind: 'shrub', geometry: { type: 'Point' } },
      { id: 'node/9', kind: 'tree', geometry: { type: 'Point' } }
    ])
  })
})

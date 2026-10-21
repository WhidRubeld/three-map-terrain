import { describe, expect, it, vi } from 'vitest'

import {
  overpassTreesQuery,
  shortbreadTreeProperties,
  TreeSource
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

describe('TreeSource', () => {
  it('reads more than woods from a preset, with properties of yours', async () => {
    loadArrayBuffer.mockResolvedValue(
      encodeVectorTile([
        {
          name: 'land',
          features: [
            { type: 3, properties: { kind: 'forest' }, geometry: square },
            { type: 3, properties: { kind: 'scrub' }, geometry: square },
            { type: 3, properties: { kind: 'grass' }, geometry: square }
          ]
        }
      ])
    )
    const woods = new TreeSource({ api: 'versatiles' })
    const more = new TreeSource({
      api: 'versatiles',
      properties: (p, layer) =>
        p.kind === 'scrub'
          ? { kind: 'scrub' }
          : shortbreadTreeProperties(p, layer)
    })

    expect((await woods.load(tile)).map((tree) => tree.kind)).toEqual([
      'forest'
    ])
    expect((await more.load(tile)).map((tree) => tree.kind)).toEqual([
      'forest',
      'scrub'
    ])
    expect(more.tiles).toBe(woods.tiles)
  })

  it('asks Overpass for more with a query of yours', async () => {
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
    const source = new TreeSource({
      api: 'overpass',
      endpoint: 'https://trees.test/overpass',
      query: (bbox) =>
        overpassTreesQuery(bbox, [
          'way["natural"="scrub"]',
          'node["natural"="shrub"]'
        ])
    })

    const trees = await source.load(tile)

    const [, , options] = loadJson.mock.calls[0] as [
      string,
      AbortSignal,
      { body: URLSearchParams }
    ]
    const query = options.body.get('data') ?? ''
    expect(query).toMatch(/^\[out:json\]/)
    expect(query).toContain('node["natural"="tree"](46.9')
    expect(query).toContain('way["natural"="scrub"](46.9')
    expect(query).toContain('node["natural"="shrub"](46.9')
    expect(query).toMatch(/out body geom qt;$/)
    // their kind: the natural tag
    expect(trees).toMatchObject([
      { id: 'way/7', kind: 'scrub', geometry: { type: 'Polygon' } },
      { id: 'node/8', kind: 'shrub', geometry: { type: 'Point' } },
      { id: 'node/9', kind: 'tree', geometry: { type: 'Point' } }
    ])
  })
})

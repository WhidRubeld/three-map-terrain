import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { decodeVectorTile, gunzip } from '../../src'
import { decodeGeometry } from '../../src/io/mvt'
import { encodeVectorTile } from '../support/mvt-encoder'

const square = [10, 10, 100, 10, 100, 100, 10, 100]

describe('decodeVectorTile', () => {
  it('decodes layers, features, ids and every value type', () => {
    const tile = encodeVectorTile([
      {
        name: 'building',
        extent: 512,
        features: [
          {
            id: 42,
            type: 3,
            properties: {
              name: 'Zytglogge',
              levels: 5,
              offset: -3,
              ratio: 0.25,
              coarse: { float: 1.5 },
              below: { int: -7 },
              hide_3d: false
            },
            geometry: [square]
          }
        ]
      },
      { name: 'water', features: [{ type: 1, geometry: [[5, 6]] }] }
    ])

    const layers = decodeVectorTile(tile)

    expect(Object.keys(layers)).toEqual(['building', 'water'])
    expect(layers.building.extent).toBe(512)
    expect(layers.water.extent).toBe(4096) // the default
    expect(layers.building.features).toEqual([
      {
        id: 42,
        type: 3,
        properties: {
          name: 'Zytglogge',
          levels: 5,
          offset: -3,
          ratio: 0.25,
          coarse: 1.5,
          below: -7,
          hide_3d: false
        },
        geometry: [square]
      }
    ])
    expect(layers.water.features[0]).toMatchObject({ id: undefined, type: 1 })
  })

  it('decodes only the layers asked for', () => {
    const tile = encodeVectorTile([
      { name: 'water', features: [{ type: 1, geometry: [[5, 6]] }] },
      { name: 'building', features: [{ type: 3, geometry: [square] }] }
    ])

    expect(Object.keys(decodeVectorTile(tile, ['building']))).toEqual([
      'building'
    ])
  })

  it('decodes multi-part geometries with negative deltas', () => {
    const outer = [0, 0, 300, 0, 300, 300, 0, 300]
    const hole = [200, 200, 100, 200, 100, 100, 200, 100]
    const tile = encodeVectorTile([
      {
        name: 'layer',
        features: [
          { type: 3, geometry: [outer, hole] },
          { type: 2, geometry: [[50, 60, 10, 5, -20, 400]] },
          { type: 1, geometry: [[1, 2, 3, 4]] }
        ]
      }
    ])

    const [polygon, line, points] = decodeVectorTile(tile).layer.features
    expect(polygon.geometry).toEqual([outer, hole])
    expect(line.geometry).toEqual([[50, 60, 10, 5, -20, 400]])
    expect(points.geometry).toEqual([
      [1, 2],
      [3, 4]
    ])
  })

  it('accepts an ArrayBuffer and skips unknown fields', () => {
    const tile = encodeVectorTile([
      { name: 'building', features: [{ type: 3, geometry: [square] }] }
    ])
    // field 7 (varint 1) before the layer: unknown to the spec
    const bytes = new Uint8Array([7 * 8, 1, ...tile])

    const layers = decodeVectorTile(bytes.buffer)
    expect(layers.building.features).toHaveLength(1)
  })

  it('rejects truncated tiles', () => {
    const tile = encodeVectorTile([
      { name: 'building', features: [{ type: 3, geometry: [square] }] }
    ])

    expect(() => decodeVectorTile(tile.subarray(0, tile.length - 5))).toThrow()
  })
})

describe('decodeGeometry', () => {
  it('rejects unknown commands', () => {
    expect(() => decodeGeometry([3 + 8, 0, 0])).toThrow(
      'Unknown vector tile geometry command 3'
    )
  })
})

describe('gunzip', () => {
  it('inflates gzip-compressed tiles and passes others through', async () => {
    const tile = encodeVectorTile([
      { name: 'building', features: [{ type: 3, geometry: [square] }] }
    ])

    expect(await gunzip(gzipSync(tile))).toEqual(tile)
    expect(await gunzip(tile)).toBe(tile)
    expect(await gunzip(tile.buffer as ArrayBuffer)).toEqual(tile)
  })
})

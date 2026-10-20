import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  buildingsFromVectorTile,
  mapboxStreetsProperties,
  openMapTilesProperties,
  overtureProperties,
  protomapsProperties,
  Utils
} from '../../src'
import {
  classifyRings,
  clipRing,
  ringAnchor
} from '../../src/buildings/features'
import { encodeVectorTile } from '../support/mvt-encoder'

const tile = { z: 14, x: 8530, y: 5766 }
const [west, south, east, north] = Utils.tile2bbox([tile.x, tile.y, tile.z])

const square = (x0: number, y0: number, x1: number, y1: number) => [
  x0,
  y0,
  x1,
  y0,
  x1,
  y1,
  x0,
  y1
]

describe('clipRing', () => {
  it('cuts a ring at the tile edges', () => {
    const ring = clipRing(square(-100, 1000, 500, 2000), 4096)
    const xs = ring.filter((_, i) => i % 2 === 0)
    expect(Math.min(...xs)).toBe(0)
    expect(Math.max(...xs)).toBe(500)
  })

  it('keeps rings inside and drops rings outside', () => {
    const inside = square(10, 10, 20, 20)
    expect(clipRing(inside, 4096)).toEqual(inside)
    expect(clipRing(square(-80, -80, -10, -10), 4096)).toEqual([])
  })
})

describe('classifyRings', () => {
  it('groups outer rings with their holes by winding', () => {
    // tile coordinates (y down): outer rings have the sign of the first ring
    const outer = square(0, 0, 100, 100)
    const reversedHole = [20, 20, 20, 40, 40, 40, 40, 20]
    const second = square(200, 0, 300, 100)

    expect(classifyRings([outer, reversedHole, second])).toEqual([
      [outer, reversedHole],
      [second]
    ])
    expect(classifyRings([[0, 0, 10, 0, 20, 0]])).toEqual([]) // no area
  })
})

describe('ringAnchor', () => {
  it('is the center of the bounding box', () => {
    expect(
      ringAnchor([
        [0, 0],
        [4, 0],
        [4, 2],
        [0, 2]
      ])
    ).toEqual([2, 1])
  })
})

describe('buildingsFromVectorTile', () => {
  const encode = (geometry: number[][], properties = {}, extra = {}) =>
    encodeVectorTile([
      {
        name: 'building',
        features: [{ id: 7, type: 3, properties, geometry, ...extra }]
      }
    ])

  it('converts tile coordinates to [lon, lat] with the attributes', async () => {
    const [building] = await buildingsFromVectorTile(
      encode([square(0, 0, 4096, 4096)], {
        render_height: 24,
        render_min_height: 3,
        colour: '#aa8866'
      }),
      tile
    )

    expect(building).toMatchObject({
      id: 7,
      height: 24,
      minHeight: 3,
      color: '#aa8866',
      properties: { render_height: 24 }
    })
    if (building.geometry.type !== 'Polygon') throw new Error('not a polygon')
    const [[nw, ne, se]] = building.geometry.coordinates
    expect(nw[0]).toBeCloseTo(west, 12)
    expect(nw[1]).toBeCloseTo(north, 12)
    expect(ne[0]).toBeCloseTo(east, 12)
    expect(se[1]).toBeCloseTo(south, 12)
  })

  it('splits merged multi-polygons into buildings without the shared id', async () => {
    const buildings = await buildingsFromVectorTile(
      encode([square(0, 0, 100, 100), square(200, 0, 300, 100)], {
        render_height: 5
      }),
      tile
    )

    expect(buildings).toHaveLength(2)
    for (const building of buildings) {
      expect(building.id).toBeUndefined()
      expect(building.height).toBe(5)
      expect(building.geometry.type).toBe('Polygon')
    }
  })

  it('keeps holes, clipped like their outer ring', async () => {
    const [building] = await buildingsFromVectorTile(
      encode([
        square(-50, 0, 400, 400),
        [100, 100, 100, 200, 200, 200, 200, 100]
      ]),
      tile
    )

    if (building.geometry.type !== 'Polygon') throw new Error('not a polygon')
    expect(building.geometry.coordinates).toHaveLength(2)
    const lons = building.geometry.coordinates[0].map(([lon]) => lon)
    expect(Math.min(...lons)).toBeCloseTo(west, 12) // clipped to the tile
  })

  it('drops polygons in the buffer, hidden ones and non-polygons', async () => {
    const data = encodeVectorTile([
      {
        name: 'building',
        features: [
          { type: 3, geometry: [square(-200, 0, -10, 100)] },
          {
            type: 3,
            properties: { hide_3d: true },
            geometry: [square(0, 0, 9, 9)]
          },
          { type: 2, geometry: [[0, 0, 100, 100]] }
        ]
      }
    ])

    expect(await buildingsFromVectorTile(data, tile)).toEqual([])
  })

  it('reads several layers with custom properties, gzip-compressed', async () => {
    const data = encodeVectorTile([
      {
        name: 'building',
        features: [
          { type: 3, properties: { height: 9 }, geometry: [square(0, 0, 9, 9)] }
        ]
      },
      {
        name: 'building_part',
        features: [
          {
            type: 3,
            properties: { height: 30, uid: 'p1' },
            geometry: [square(0, 0, 9, 9)]
          }
        ]
      }
    ])

    const buildings = await buildingsFromVectorTile(gzipSync(data), tile, {
      layers: ['building', 'building_part'],
      properties: (p, layer) => ({
        id: typeof p.uid === 'string' ? p.uid : undefined,
        height: typeof p.height === 'number' ? p.height : undefined,
        hidden: layer === 'building'
      })
    })

    expect(buildings).toHaveLength(1)
    expect(buildings[0]).toMatchObject({ id: 'p1', height: 30 })
  })
})

describe('vector tile schemas', () => {
  it('read OpenMapTiles fields', () => {
    expect(
      openMapTilesProperties(
        {
          render_height: 12,
          render_min_height: 2,
          colour: 'rebeccapurple',
          hide_3d: false
        },
        'building'
      )
    ).toEqual({
      height: 12,
      minHeight: 2,
      color: 'rebeccapurple',
      hidden: false
    })
    expect(
      openMapTilesProperties({ colour: 'not a color' }, 'building').color
    ).toBeUndefined()
  })

  it('read Mapbox Streets fields', () => {
    expect(
      mapboxStreetsProperties(
        { height: 40, min_height: 0, extrude: 'true', underground: 'false' },
        'building'
      )
    ).toEqual({
      height: 40,
      minHeight: 0,
      hidden: false
    })
    expect(
      mapboxStreetsProperties({ extrude: 'false' }, 'building').hidden
    ).toBe(true)
    expect(
      mapboxStreetsProperties({ underground: 'true' }, 'building').hidden
    ).toBe(true)
  })

  it('read Overture fields, floors as heights, parts instead of outlines', () => {
    expect(
      overtureProperties(
        { id: 'abc', num_floors: 4, min_height: 3, facade_color: '#c0c0c0' },
        'building_part'
      )
    ).toEqual({
      id: 'abc',
      height: 12,
      minHeight: 3,
      color: '#c0c0c0',
      hidden: false
    })
    expect(
      overtureProperties({ height: 20, num_floors: 4 }, 'building').height
    ).toBe(20)
    expect(overtureProperties({ has_parts: true }, 'building').hidden).toBe(
      true
    )
    expect(
      overtureProperties({ is_underground: true }, 'building').hidden
    ).toBe(true)
  })

  it('read Protomaps fields', () => {
    expect(
      protomapsProperties({ height: 8, min_height: 1 }, 'buildings')
    ).toEqual({
      height: 8,
      minHeight: 1
    })
  })
})

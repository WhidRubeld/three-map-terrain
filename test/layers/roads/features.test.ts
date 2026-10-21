import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  LANE_WIDTH,
  mapboxStreetsRoadProperties,
  openMapTilesRoadProperties,
  osmRoadAttributes,
  overpassRoadsQuery,
  protomapsRoadProperties,
  roadKind,
  roadsFromOverpass,
  roadsFromVectorTile,
  shortbreadRoadProperties,
  Utils
} from '../../../src'
import { encodeVectorTile } from '../../support/mvt-encoder'

const tile = { z: 14, x: 8530, y: 5766 }

describe('roadKind', () => {
  it('maps the classes of every schema to a kind', () => {
    expect(
      [
        'motorway_link',
        'residential',
        'street_limited',
        'minor',
        'footway',
        'steps',
        'transit',
        'major_rail',
        'tram',
        'parking_aisle'
      ].map(roadKind)
    ).toEqual([
      'motorway',
      'minor',
      'minor',
      'minor',
      'path',
      'path',
      'rail',
      'rail',
      'rail',
      'service'
    ])
  })

  it('has no kind for ferries, aerialways and roads being built', () => {
    expect(
      [
        'ferry',
        'aerialway',
        'construction',
        'primary_construction',
        'platform',
        7
      ].map(roadKind)
    ).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    ])
  })
})

describe('road schemas', () => {
  it('read OpenMapTiles', () => {
    expect(
      openMapTilesRoadProperties(
        { class: 'motorway', ramp: 1, brunnel: 'bridge', layer: 2 },
        'transportation'
      )
    ).toEqual({
      kind: 'motorway',
      link: true,
      bridge: true,
      tunnel: false,
      layer: 2,
      hidden: false
    })
    expect(
      openMapTilesRoadProperties({ class: 'path', indoor: 1 }, '').hidden
    ).toBe(true)
  })

  it('read Mapbox Streets, Protomaps and Shortbread', () => {
    expect(
      mapboxStreetsRoadProperties(
        { class: 'trunk_link', structure: 'tunnel' },
        ''
      )
    ).toMatchObject({ kind: 'trunk', link: true, tunnel: true, bridge: false })
    expect(
      protomapsRoadProperties(
        { kind: 'highway', kind_detail: 'motorway', is_bridge: true },
        ''
      )
    ).toMatchObject({ kind: 'motorway', bridge: true, tunnel: false })
    expect(
      protomapsRoadProperties({ kind: 'rail', kind_detail: 'x' }, '').kind
    ).toBe('rail')
    expect(
      shortbreadRoadProperties({ kind: 'living_street', bridge: true }, '')
    ).toMatchObject({ kind: 'minor', bridge: true })
  })
})

describe('roadsFromVectorTile', () => {
  it('reads line features with their buffer, gzipped or not', async () => {
    const data = encodeVectorTile([
      {
        name: 'transportation',
        features: [
          {
            id: 5,
            type: 2,
            properties: { class: 'secondary' },
            geometry: [
              [-100, 0, 2048, 2048],
              [0, 4096, 4196, 4096]
            ]
          },
          // a pier polygon and a ferry: not roads
          {
            type: 3,
            properties: { class: 'pier' },
            geometry: [[0, 0, 10, 0, 10, 10]]
          },
          {
            type: 2,
            properties: { class: 'ferry' },
            geometry: [[0, 0, 10, 10]]
          }
        ]
      }
    ])

    for (const bytes of [data, gzipSync(data)]) {
      const [road, ...rest] = await roadsFromVectorTile(bytes, tile)
      expect(rest).toEqual([])
      expect(road).toMatchObject({ id: 5, kind: 'secondary' })
      if (road.geometry.type !== 'MultiLineString') throw new Error('not multi')
      const [[first, middle]] = road.geometry.coordinates
      const [west, , , north] = Utils.tile2bbox([tile.x, tile.y, tile.z])
      // in the buffer, west of the tile
      expect(first[0]).toBeLessThan(west)
      expect(first[1]).toBeCloseTo(north, 9)
      expect(middle[0]).toBeCloseTo(Utils.tile2lon(tile.x + 0.5, tile.z), 9)
    }
  })
})

describe('OpenStreetMap roads', () => {
  it('reads kind, width, bridges and tunnels from tags', () => {
    expect(
      osmRoadAttributes({
        highway: 'primary_link',
        bridge: 'viaduct',
        layer: '2'
      })
    ).toMatchObject({ kind: 'primary', link: true, bridge: true, layer: 2 })
    expect(
      osmRoadAttributes({ highway: 'service', width: '4.5 m' }).width
    ).toBe(4.5)
    expect(osmRoadAttributes({ highway: 'trunk', lanes: '3' }).width).toBe(
      3 * LANE_WIDTH
    )
    expect(
      osmRoadAttributes({ railway: 'light_rail', tunnel: 'yes' })
    ).toMatchObject({ kind: 'rail', tunnel: true })
    // a passage through a building is a street on the ground
    expect(
      osmRoadAttributes({ highway: 'footway', tunnel: 'building_passage' })
        .tunnel
    ).toBe(false)
    expect(
      osmRoadAttributes({ highway: 'pedestrian', area: 'yes' }).hidden
    ).toBe(true)
    expect(osmRoadAttributes({ railway: 'abandoned' }).kind).toBeUndefined()
  })

  it('reads an Overpass answer', () => {
    const roads = roadsFromOverpass({
      elements: [
        {
          type: 'way',
          id: 9,
          tags: { highway: 'residential', bridge: 'yes' },
          geometry: [{ lat: 46.5, lon: 6.6 }, null, { lat: 46.6, lon: 6.7 }]
        },
        { type: 'way', id: 10, tags: { highway: 'proposed' }, geometry: [] },
        { type: 'node', id: 11 }
      ]
    })

    expect(roads).toEqual([
      expect.objectContaining({
        id: 'way/9',
        kind: 'minor',
        bridge: true,
        geometry: {
          type: 'LineString',
          coordinates: [
            [6.6, 46.5],
            [6.7, 46.6]
          ]
        }
      })
    ])
  })

  it('queries roads and railways in a bounding box', () => {
    const query = overpassRoadsQuery([6.6, 46.5, 6.7, 46.6])
    expect(query).toContain('way["highway"](46.5,6.6,46.6,6.7)')
    expect(query).toContain('way["railway"~"^(rail|light_rail')
  })
})

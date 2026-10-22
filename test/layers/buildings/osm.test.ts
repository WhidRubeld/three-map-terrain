import { describe, expect, it } from 'vitest'

import {
  buildingsFromOverpass,
  osmBuildingAttributes,
  overpassQuery,
  parseLength
} from '../../../src'
import { joinRings, pointInRing } from '../../../src/layers/buildings/osm'

const point = (lon: number, lat: number) => ({ lat, lon })
const squareWay = (x0: number, y0: number, x1: number, y1: number) => [
  point(x0, y0),
  point(x1, y0),
  point(x1, y1),
  point(x0, y1),
  point(x0, y0)
]

describe('parseLength', () => {
  it.each([
    ['12', 12],
    ['12.5 m', 12.5],
    ['12m', 12],
    ['12,5', 12.5],
    ['40 ft', 40 * 0.3048],
    ["40'", 40 * 0.3048],
    [`40'6"`, 40 * 0.3048 + 6 * 0.0254],
    ['15;20', 15],
    [7, 7]
  ] as const)('reads %s', (text, meters) => {
    expect(parseLength(text)).toBeCloseTo(meters, 9)
  })

  it.each(['tall', '', 'approx 10', undefined, Number.NaN])(
    'rejects %s',
    (text) => {
      expect(parseLength(text)).toBeUndefined()
    }
  )
})

describe('osmBuildingAttributes', () => {
  it('prefers height, then building:levels (with roof levels)', () => {
    expect(
      osmBuildingAttributes({ height: '20', 'building:levels': '3' }).height
    ).toBe(20)
    expect(
      osmBuildingAttributes({ 'building:levels': '4', 'roof:levels': '1' })
        .height
    ).toBe(15)
    expect(osmBuildingAttributes({ building: 'yes' }).height).toBeUndefined()
  })

  it('reads the levels of several sections: the highest, the lowest min level', () => {
    // Cheboksary, Maxim Gorky Avenue 30/1: sections of 9 and 10 levels
    expect(osmBuildingAttributes({ 'building:levels': '9,10' }).height).toBe(30)
    expect(osmBuildingAttributes({ 'building:levels': '5; 7' }).height).toBe(21)
    expect(
      osmBuildingAttributes({ 'building:min_level': '2;1' }).minHeight
    ).toBe(3)
    // nothing to read: no levels, not none
    expect(
      osmBuildingAttributes({ 'building:levels': 'many' }).height
    ).toBeUndefined()
    expect(osmBuildingAttributes({ 'building:levels': '' }).height).toBe(
      undefined
    )
  })

  it('reads min_height or building:min_level', () => {
    expect(osmBuildingAttributes({ min_height: '6 m' }).minHeight).toBe(6)
    expect(osmBuildingAttributes({ 'building:min_level': '2' }).minHeight).toBe(
      6
    )
  })

  it('keeps valid colors only', () => {
    expect(osmBuildingAttributes({ 'building:colour': '#a0522d' }).color).toBe(
      '#a0522d'
    )
    expect(osmBuildingAttributes({ 'building:colour': 'Beige' }).color).toBe(
      'Beige'
    )
    expect(
      osmBuildingAttributes({ 'building:colour': 'brick' }).color
    ).toBeUndefined()
  })

  it('hides underground buildings', () => {
    expect(
      osmBuildingAttributes({ building: 'yes', location: 'underground' }).hidden
    ).toBe(true)
    expect(osmBuildingAttributes({ building: 'yes' }).hidden).toBe(false)
  })
})

describe('joinRings', () => {
  it('joins ways end to end, reversing where needed', () => {
    const rings = joinRings([
      [
        [0, 0],
        [1, 0]
      ],
      [
        [1, 1],
        [1, 0]
      ], // reversed
      [
        [1, 1],
        [0, 1],
        [0, 0]
      ]
    ])
    expect(rings).toHaveLength(1)
    expect(rings[0]).toHaveLength(5)
    expect(rings[0][0]).toEqual(rings[0][4])
  })

  it('drops rings that do not close', () => {
    expect(
      joinRings([
        [
          [0, 0],
          [1, 0],
          [1, 1]
        ]
      ])
    ).toEqual([])
  })
})

describe('pointInRing', () => {
  it('tells inside from outside', () => {
    const ring = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0]
    ]
    expect(pointInRing([1, 1], ring)).toBe(true)
    expect(pointInRing([3, 1], ring)).toBe(false)
  })
})

describe('buildingsFromOverpass', () => {
  it('turns ways into polygons with their tags', () => {
    const [building] = buildingsFromOverpass({
      elements: [
        {
          type: 'way',
          id: 5,
          tags: { building: 'yes', height: '9' },
          geometry: squareWay(0, 0, 1, 1)
        }
      ]
    })

    expect(building).toMatchObject({
      id: 'way/5',
      height: 9,
      properties: { building: 'yes', height: '9' },
      geometry: { type: 'Polygon' }
    })
  })

  it('assembles multipolygons with holes from split member ways', () => {
    const [building] = buildingsFromOverpass({
      elements: [
        {
          type: 'relation',
          id: 9,
          tags: { type: 'multipolygon', building: 'yes' },
          members: [
            {
              type: 'way',
              role: 'outer',
              geometry: [point(0, 0), point(10, 0), point(10, 10)]
            },
            {
              type: 'way',
              role: 'outer',
              geometry: [point(10, 10), point(0, 10), point(0, 0)]
            },
            { type: 'way', role: 'inner', geometry: squareWay(4, 4, 6, 6) },
            { type: 'way', role: 'outer', geometry: squareWay(20, 0, 30, 10) }
          ]
        }
      ]
    })

    expect(building.id).toBe('relation/9')
    if (building.geometry.type !== 'MultiPolygon')
      throw new Error('expected a multipolygon')
    const [withHole, plain] = building.geometry.coordinates
    expect(withHole).toHaveLength(2)
    expect(plain).toHaveLength(1)
  })

  it('leaves out outlines that have building parts, and hidden or broken shapes', () => {
    const buildings = buildingsFromOverpass({
      elements: [
        {
          type: 'way',
          id: 1,
          tags: { building: 'church' },
          geometry: squareWay(0, 0, 10, 10)
        },
        {
          type: 'way',
          id: 2,
          tags: { 'building:part': 'yes', height: '40' },
          geometry: squareWay(1, 1, 3, 3)
        },
        {
          type: 'way',
          id: 3,
          tags: { building: 'yes' },
          geometry: squareWay(20, 0, 30, 10)
        },
        {
          type: 'way',
          id: 4,
          tags: { building: 'yes', location: 'underground' },
          geometry: squareWay(40, 0, 50, 10)
        },
        {
          type: 'way',
          id: 5,
          tags: { building: 'yes' },
          geometry: [point(0, 0), point(1, 0)]
        }
      ]
    })

    expect(buildings.map(({ id }) => id)).toEqual(['way/2', 'way/3'])
  })

  it('accepts empty or unexpected responses', () => {
    expect(buildingsFromOverpass({ elements: [] })).toEqual([])
    expect(buildingsFromOverpass(null)).toEqual([])
  })
})

describe('overpassQuery', () => {
  it('asks for buildings and parts in the bounding box', () => {
    const query = overpassQuery([7.42, 46.94, 7.45, 46.96])
    expect(query).toContain('way["building"](46.94,7.42,46.96,7.45)')
    expect(query).toContain(
      'relation["building:part"]["type"="multipolygon"](46.94,7.42,46.96,7.45)'
    )
    expect(query).toMatch(/^\[out:json\]/)
    expect(query).toMatch(/out body geom qt;$/)
  })
})

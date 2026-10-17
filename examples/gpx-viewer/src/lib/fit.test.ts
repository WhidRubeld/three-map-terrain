import { Utils } from 'three-map-terrain'
import { describe, expect, it } from 'vitest'

import { fitTerrain, MAX_ZOOM } from './fit'

describe('fitTerrain', () => {
  const eiger = { south: 46.5754, west: 7.9736, north: 46.6005, east: 8.0122 }

  it('picks the deepest zoom whose grid contains the bounds', () => {
    for (const nTiles of [3, 5]) {
      const fit = fitTerrain(eiger, nTiles)
      const { extent } = fit
      expect(extent.west).toBeLessThan(eiger.west)
      expect(extent.east).toBeGreaterThan(eiger.east)
      expect(extent.south).toBeLessThan(eiger.south)
      expect(extent.north).toBeGreaterThan(eiger.north)
      // one zoom deeper does not fit
      if (fit.zoom < MAX_ZOOM) {
        const deeper = fit.zoom + 1
        const nw = Utils.position2tileFraction(eiger.north, eiger.west, deeper)
        const se = Utils.position2tileFraction(eiger.south, eiger.east, deeper)
        const span = Math.max(se.x - nw.x, se.y - nw.y)
        expect(Math.floor(span + 0.24)).toBeGreaterThanOrEqual(nTiles - 1)
      }
    }
    expect(fitTerrain(eiger, 5).zoom).toBeGreaterThanOrEqual(
      fitTerrain(eiger, 3).zoom
    )
  })

  it('centers the map on a location inside the center tile', () => {
    const fit = fitTerrain(eiger, 3)
    expect(
      Utils.position2tile(fit.location.lat, fit.location.lon, fit.zoom)
    ).toMatchObject(fit.tile)
  })

  it('uses a true-scale zScale (scene units per meter)', () => {
    const fit = fitTerrain(eiger, 3)
    // the library default 0.045 is true scale at zoom 11 around 46°N
    expect(fit.zScale * 2 ** (11 - fit.zoom)).toBeCloseTo(0.0446, 3)
  })

  it('caps the zoom for tiny tracks and zooms out for long ones', () => {
    const point = { south: 46.6, west: 8, north: 46.6001, east: 8.0001 }
    expect(fitTerrain(point, 3).zoom).toBe(MAX_ZOOM)
    const alps = { south: 45.8, west: 6.8, north: 47.0, east: 10.5 }
    expect(fitTerrain(alps, 3).zoom).toBeLessThan(9)
  })
})

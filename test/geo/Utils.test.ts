import { describe, expect, it } from 'vitest'

import { Utils } from '../../src'

const jungfrau = { lat: 46.57634, lon: 7.9904 }

describe('Utils', () => {
  it('converts coordinates to the containing tile', () => {
    expect(Utils.position2tile(0, 0, 1)).toEqual({ x: 1, y: 1, z: 1 })
    expect(Utils.position2tile(jungfrau.lat, jungfrau.lon, 11)).toEqual({
      x: 1069,
      y: 723,
      z: 11
    })
  })

  it('wraps tile x around the antimeridian', () => {
    expect(Utils.position2tile(0, 180, 2).x).toBe(0)
    expect(Utils.position2tile(0, -180, 2).x).toBe(0)
    expect(Utils.position2tileFraction(0, 190, 2).x).toBeCloseTo(
      Utils.position2tileFraction(0, -170, 2).x
    )
  })

  it('round-trips lon/lat through fractional tile coordinates', () => {
    for (const zoom of [0, 5, 11, 18]) {
      const x = Utils.long2tile(jungfrau.lon, zoom)
      const y = Utils.lat2tile(jungfrau.lat, zoom)
      expect(Utils.tile2lon(x, zoom)).toBeCloseTo(jungfrau.lon, 9)
      expect(Utils.tile2lat(y, zoom)).toBeCloseTo(jungfrau.lat, 9)

      const fraction = Utils.position2tileFraction(
        jungfrau.lat,
        jungfrau.lon,
        zoom
      )
      expect(fraction.x).toBeCloseTo(x, 9)
      expect(fraction.y).toBeCloseTo(y, 9)
    }
  })

  it('returns a bbox that contains the source point', () => {
    const { x, y, z } = Utils.position2tile(jungfrau.lat, jungfrau.lon, 11)
    const [w, s, e, n] = Utils.tile2bbox([x, y, z])

    expect(w).toBeLessThan(jungfrau.lon)
    expect(e).toBeGreaterThan(jungfrau.lon)
    expect(s).toBeLessThan(jungfrau.lat)
    expect(n).toBeGreaterThan(jungfrau.lat)
    expect(e - w).toBeCloseTo(360 / 2 ** 11, 12)
  })

  it('places tiles on a grid around the center tile', () => {
    const center = { x: 1069, y: 723 }

    expect(Utils.tile2position(11, 1069, 723, center, 600)).toEqual({
      x: 0,
      y: 0,
      z: 0
    })
    // east is +x, south is -y
    expect(Utils.tile2position(11, 1070, 724, center, 600)).toEqual({
      x: 600,
      y: -600,
      z: 0
    })
  })

  it('measures tiles in meters', () => {
    // the equator at zoom 0: the whole circumference
    expect(Utils.tileWidth(0, 0)).toBeCloseTo(40075016.686, 3)
    expect(Utils.tileWidth(60, 1)).toBeCloseTo(40075016.686 / 4, 3)
    // the default zScale is true scale at zoom 11 around 46°
    expect(600 / Utils.tileWidth(46.57634, 11)).toBeCloseTo(0.045, 3)
  })

  it('builds z/x/y tile keys', () => {
    expect(Utils.getTileKey(11, 1069, 724)).toBe('11/1069/724')
  })
})

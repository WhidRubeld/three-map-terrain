import { describe, expect, it } from 'vitest'

import { Source, type SourceProps } from '../src'

describe('Source', () => {
  it.each([
    [{ api: 'osm' }, 'https://tile.openstreetmap.org/11/1069/724.png'],
    [
      { api: 'eox' },
      'https://tiles.maps.eox.at/wmts?layer=s2cloudless_3857&style=default&tilematrixset=g&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image%2Fjpeg&TileMatrix=11&TileCol=1069&TileRow=724'
    ],
    [
      { api: 'mapbox', token: 'pk.test' },
      'https://api.mapbox.com/v4/mapbox.satellite/11/1069/724@2x.jpg80?access_token=pk.test'
    ],
    [
      { api: 'maptiler', token: 'key' },
      'https://api.maptiler.com/tiles/satellite/11/1069/724.jpg?key=key'
    ]
  ] satisfies [SourceProps, string][])('builds %o tile urls', (props, url) => {
    expect(new Source(props).mapUrl(11, 1069, 724)).toBe(url)
  })

  it('stores the token only for token-based apis', () => {
    expect(new Source({ api: 'osm' }).token).toBe('')
    expect(new Source({ api: 'mapbox', token: 'abc' }).token).toBe('abc')
  })

  it('rejects unknown apis', () => {
    expect(
      () => new Source({ api: 'google' } as unknown as SourceProps)
    ).toThrow('Unknown source api: google')
    expect(
      () => new Source({ api: 'toString' } as unknown as SourceProps)
    ).toThrow('Unknown source api')
  })
})

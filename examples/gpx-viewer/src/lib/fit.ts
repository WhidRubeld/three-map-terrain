import { Utils } from 'three-map-terrain'

import { type Bounds, EARTH_CIRCUMFERENCE } from './geo'

/** Scene units per tile, as in `defaultMapOptions`. */
export const TILE_SIZE = 600
/** AWS terrarium tiles go to 15; textures are fetched one zoom deeper. */
export const MAX_ZOOM = 14
export const MIN_ZOOM = 3

/** How the `Map` grid is laid out so that a route fits on it. */
export interface TerrainFit {
  zoom: number
  nTiles: number
  /** the center tile: the grid spans `x ± ⌊nTiles / 2⌋`, `y ± ⌊nTiles / 2⌋` */
  tile: { x: number; y: number }
  /** any point inside the center tile; passed to `new Map({ location })` */
  location: { lat: number; lon: number }
  tileSize: number
  /** meters per scene unit at the grid center */
  metersPerUnit: number
  /** true-scale `MapOptions.zScale` (scene units per meter of elevation) */
  zScale: number
  /** geographic extent of the whole grid */
  extent: Bounds
  key: string
}

/**
 * The deepest zoom at which `bounds` (plus a margin of `margin` tiles) fits in
 * an `nTiles × nTiles` grid, and the center tile that frames it.
 */
export function fitTerrain(
  bounds: Bounds,
  nTiles: number,
  margin = 0.12
): TerrainFit {
  const half = Math.floor(nTiles / 2)
  let zoom = MAX_ZOOM
  let tile = { x: 0, y: 0 }
  for (; zoom >= MIN_ZOOM; zoom--) {
    const nw = Utils.position2tileFraction(bounds.north, bounds.west, zoom)
    const se = Utils.position2tileFraction(bounds.south, bounds.east, zoom)
    const x0 = Math.floor(nw.x - margin)
    const x1 = Math.floor(se.x + margin)
    const y0 = Math.floor(nw.y - margin)
    const y1 = Math.floor(se.y + margin)
    // a route across the antimeridian wraps: se.x < nw.x, never fits
    if (x1 < x0 || x1 - x0 >= nTiles || y1 - y0 >= nTiles) continue
    const center = (low: number, high: number) =>
      Math.min(Math.max(Math.round((low + high) / 2), high - half), low + half)
    tile = { x: center(x0, x1), y: center(y0, y1) }
    break
  }
  zoom = Math.max(zoom, MIN_ZOOM)

  const location = {
    lat: Utils.tile2lat(tile.y + 0.5, zoom),
    lon: Utils.tile2lon(tile.x + 0.5, zoom)
  }
  const tileMeters =
    (EARTH_CIRCUMFERENCE * Math.cos((location.lat * Math.PI) / 180)) / 2 ** zoom
  const metersPerUnit = tileMeters / TILE_SIZE

  return {
    zoom,
    nTiles,
    tile,
    location,
    tileSize: TILE_SIZE,
    metersPerUnit,
    zScale: 1 / metersPerUnit,
    extent: {
      west: Utils.tile2lon(tile.x - half, zoom),
      east: Utils.tile2lon(tile.x + half + 1, zoom),
      north: Utils.tile2lat(tile.y - half, zoom),
      south: Utils.tile2lat(tile.y + half + 1, zoom)
    },
    key: `${zoom}/${tile.x}/${tile.y}/${nTiles}`
  }
}

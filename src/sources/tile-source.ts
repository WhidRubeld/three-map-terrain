// What every tile source shares: requests, URL templates, overzoom.

/** A tile to load, in the slippy-map (XYZ) scheme, and the signal that cancels it. */
export interface TileRequest {
  readonly z: number
  readonly x: number
  readonly y: number
  readonly signal: AbortSignal
}

/**
 * A tile URL: a template with `{z}`, `{x}`, `{y}`, `{-y}` (TMS rows), `{s}`
 * (subdomain), `{r}` (removed, for Leaflet-style templates) and `{quadkey}`,
 * or a function building it.
 */
export type TileUrl = string | ((z: number, x: number, y: number) => string)

/** Options every source accepts. */
export interface TileSourceOptions {
  /**
   * Deepest zoom the source has. Deeper tiles are cut out of their ancestor
   * at this zoom. Sources also fall back to the ancestor when a tile is
   * missing (HTTP 404, or a custom `load` resolving to `null`).
   */
  maxZoom?: number
  /** Credit for the data, listed in `map.attributions`. */
  attribution?: string
}

/** Substituted for `{s}`, chosen by tile so that a tile always has one URL. */
export type Subdomains = string | readonly string[]

/** Bing-style quadkey of a tile. */
export function quadkey(z: number, x: number, y: number) {
  let key = ''
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1)
    key += String((x & mask ? 1 : 0) + (y & mask ? 2 : 0))
  }
  return key
}

/** Expands a `TileUrl` for one tile. */
export function expandTileUrl(
  url: TileUrl,
  z: number,
  x: number,
  y: number,
  subdomains: Subdomains = 'abc'
): string {
  if (typeof url === 'function') return url(z, x, y)
  const domains =
    typeof subdomains === 'string' ? subdomains.split('') : subdomains
  return url.replace(/\{(z|x|y|-y|s|r|quadkey)\}/g, (_, key: string) => {
    switch (key) {
      case 'z':
        return String(z)
      case 'x':
        return String(x)
      case 'y':
        return String(y)
      case '-y':
        return String(2 ** z - 1 - y)
      case 's':
        return domains.length ? domains[Math.abs(x + y) % domains.length] : ''
      case 'quadkey':
        return quadkey(z, x, y)
      default:
        return ''
    }
  })
}

/**
 * Where a tile lies in an image covering it, as fractions of that image:
 * `left`/`top` from its north-west corner, `size` of its side.
 */
export interface TileRegion {
  left: number
  top: number
  size: number
}

export const WHOLE_TILE: Readonly<TileRegion> = Object.freeze({
  left: 0,
  top: 0,
  size: 1
})

/** The ancestor of `z/x/y` at zoom `zoom` (≤ `z`) and the tile's region in it. */
export function ancestorTile(z: number, x: number, y: number, zoom: number) {
  const levels = z - zoom
  const scale = 2 ** levels
  const ax = Math.floor(x / scale)
  const ay = Math.floor(y / scale)
  return {
    z: zoom,
    x: ax,
    y: ay,
    region: {
      left: (x - ax * scale) / scale,
      top: (y - ay * scale) / scale,
      size: 1 / scale
    }
  }
}

/** How many levels a missing tile may fall back to its ancestors. */
export const MAX_FALLBACK_LEVELS = 6

/**
 * Loads `z/x/y`, or — beyond `maxZoom`, or when `load` resolves to `null`
 * (tile missing) — its nearest ancestor that exists. Tiles requested in one
 * `memo` are loaded once: the four children of a texture often fall back to
 * the same ancestor. Resolves to `null` if no ancestor exists either.
 */
export async function loadWithFallback<T>(
  request: TileRequest,
  maxZoom: number,
  load: (request: TileRequest) => Promise<T | null>,
  memo = new Map<string, Promise<T | null>>()
): Promise<{ data: T; region: TileRegion; z: number } | null> {
  const { z, x, y, signal } = request
  const deepest = Math.max(0, Math.min(z, Math.floor(maxZoom)))
  const shallowest = Math.max(0, deepest - MAX_FALLBACK_LEVELS)

  for (let zoom = deepest; zoom >= shallowest; zoom--) {
    const tile = ancestorTile(z, x, y, zoom)
    const key = `${tile.z}/${tile.x}/${tile.y}`
    let pending = memo.get(key)
    if (!pending) {
      pending = load({ z: tile.z, x: tile.x, y: tile.y, signal })
      memo.set(key, pending)
    }
    const data = await pending
    if (data !== null) return { data, region: tile.region, z: tile.z }
  }
  return null
}

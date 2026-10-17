import { crc32, deflateSync } from 'node:zlib'

import type { Page } from '@playwright/test'

const TILE_SIZE = 256

/** Minimal RGBA8 PNG encoder (no external deps). */
export function encodePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number]
): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1) // first byte: filter type 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      raw.set([r, g, b, 255], row + 1 + x * 4)
    }
  }

  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, crc])
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA, no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const terrarium = (meters: number) => {
  const value = Math.round((meters + 32768) * 256) / 256
  const integer = Math.floor(value)
  return [
    Math.floor(integer / 256),
    integer % 256,
    Math.round((value - integer) * 256)
  ] as const
}

/** Rolling hills (meters) at global pixel `gx`, `gy`, continuous across tiles. */
export const syntheticElevation = (gx: number, gy: number) =>
  1500 + 1200 * Math.sin(gx / 90) * Math.cos(gy / 110) + 0.01 * gx

const elevationTile = (tx: number, ty: number) =>
  encodePng(TILE_SIZE, TILE_SIZE, (x, y) =>
    terrarium(syntheticElevation(tx * TILE_SIZE + x, ty * TILE_SIZE + y))
  )

/**
 * Child texture colors by position inside the parent tile. The mid-gray SE
 * quadrant catches color-space mistakes (an sRGB texture sampled as linear
 * renders ~188 instead of 128); the primaries are invariant to them.
 */
export const QUADRANT_COLORS = {
  nw: [255, 0, 0],
  ne: [0, 255, 0],
  sw: [0, 0, 255],
  se: [128, 128, 128]
} as const

const textureTile = (col: number, row: number) => {
  const key = `${row % 2 ? 's' : 'n'}${col % 2 ? 'e' : 'w'}` as const
  const color = QUADRANT_COLORS[key]
  return encodePng(TILE_SIZE, TILE_SIZE, () => color)
}

/**
 * Serves deterministic elevation/texture tiles instead of the real servers.
 * Returns the number of requests per texture tile (`col/row`).
 */
export async function mockTileServers(
  page: Page,
  {
    textureReplies = new Map<string, Buffer[]>()
  }: {
    /** JPEG bodies served, one per request, before the regular tile. */
    textureReplies?: Map<string, Buffer[]>
  } = {}
) {
  const cache = new Map<string, Buffer>()
  const memo = (key: string, build: () => Buffer) => {
    const hit = cache.get(key)
    if (hit) return hit
    const value = build()
    cache.set(key, value)
    return value
  }
  const headers = { 'access-control-allow-origin': '*' }
  const requests = new Map<string, number>()

  await page.route('**/elevation-tiles-prod/terrarium/**', (route) => {
    const [x, y] = new URL(route.request().url()).pathname
      .replace(/\.png$/, '')
      .split('/')
      .slice(-2)
      .map(Number)
    return route.fulfill({
      contentType: 'image/png',
      headers,
      body: memo(`e/${x}/${y}`, () => elevationTile(x, y))
    })
  })

  await page.route('https://tiles.maps.eox.at/**', (route) => {
    const query = new URL(route.request().url()).searchParams
    const col = Number(query.get('TileCol'))
    const row = Number(query.get('TileRow'))
    const key = `${col}/${row}`
    requests.set(key, (requests.get(key) ?? 0) + 1)

    const reply = textureReplies.get(key)?.shift()
    return route.fulfill({
      contentType: reply ? 'image/jpeg' : 'image/png',
      headers,
      body: reply ?? memo(`t/${key}`, () => textureTile(col, row))
    })
  })

  return { requests }
}

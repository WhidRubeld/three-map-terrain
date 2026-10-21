// Tiles of a layer's source shared by the terrain tiles using them. Internal.

import type { TileRequest } from './tile-source'

/** A source tile, and its key. */
export interface SourceTileKey {
  readonly z: number
  readonly x: number
  readonly y: number
  readonly key: string
}

/** A terrain tile loads at most 4^this source tiles. */
const MAX_SOURCE_LEVELS = 2

interface SourceTile<T> {
  refs: number
  controller: AbortController
  data: Promise<T>
}

/**
 * Loads each source tile once for every terrain tile using it (with
 * reference counts) and aborts it when the last one lets go.
 */
export class SourceTiles<T> {
  private readonly tiles = new Map<string, SourceTile<T>>()
  private warned = false

  constructor(
    /** Names the layer in warnings. */
    private readonly name: string,
    private readonly load: (tile: TileRequest) => Promise<T>
  ) {}

  /**
   * Source tiles covering a terrain tile, at the zoom the source has:
   * one shared by deeper terrain, or up to 4² children of shallower terrain.
   */
  covering(
    { z, x, y }: { z: number; x: number; y: number },
    minZoom: number,
    maxZoom: number
  ): SourceTileKey[] {
    const zoom = Math.max(minZoom, Math.min(z, maxZoom))
    if (zoom <= z) {
      const scale = 2 ** (z - zoom)
      const sx = Math.floor(x / scale)
      const sy = Math.floor(y / scale)
      return [{ z: zoom, x: sx, y: sy, key: `${zoom}/${sx}/${sy}` }]
    }
    if (zoom - z > MAX_SOURCE_LEVELS) {
      if (!this.warned) {
        console.warn(
          `${this.name}: the source starts at zoom ${minZoom}, too deep for terrain zoom ${z}`
        )
        this.warned = true
      }
      return []
    }
    const scale = 2 ** (zoom - z)
    const tiles = []
    for (let i = 0; i < scale; i++) {
      for (let j = 0; j < scale; j++) {
        const sx = x * scale + i
        const sy = y * scale + j
        tiles.push({ z: zoom, x: sx, y: sy, key: `${zoom}/${sx}/${sy}` })
      }
    }
    return tiles
  }

  /** The tile's data, loaded by the first terrain tile asking for it. */
  acquire({ z, x, y, key }: SourceTileKey): Promise<T> {
    let tile = this.tiles.get(key)
    if (!tile) {
      const controller = new AbortController()
      tile = {
        refs: 0,
        controller,
        data: this.load({ z, x, y, signal: controller.signal })
      }
      this.tiles.set(key, tile)
    }
    tile.refs++
    return tile.data
  }

  /** Lets go of a tile; `true` if it was the last user (the tile is dropped). */
  release(key: string): boolean {
    const tile = this.tiles.get(key)
    if (!tile || --tile.refs > 0) return false
    this.tiles.delete(key)
    tile.controller.abort()
    return true
  }
}

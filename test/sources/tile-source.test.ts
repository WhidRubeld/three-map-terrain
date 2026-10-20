import { describe, expect, it, vi } from 'vitest'

import { expandTileUrl } from '../../src'
import {
  ancestorTile,
  loadWithFallback,
  MAX_FALLBACK_LEVELS,
  quadkey
} from '../../src/sources/tile-source'

const signal = new AbortController().signal

describe('expandTileUrl', () => {
  it('fills z, x, y, TMS rows, quadkeys and drops {r}', () => {
    expect(
      expandTileUrl(
        'https://t/{z}/{x}/{y}{r}.png?tms={-y}&q={quadkey}',
        3,
        5,
        2
      )
    ).toBe('https://t/3/5/2.png?tms=5&q=121')
  })

  it('picks one subdomain per tile', () => {
    const url = 'https://{s}.tile/{z}/{x}/{y}'
    expect(expandTileUrl(url, 1, 0, 0)).toBe('https://a.tile/1/0/0')
    expect(expandTileUrl(url, 1, 1, 0)).toBe('https://b.tile/1/1/0')
    expect(expandTileUrl(url, 1, 1, 0, ['t0', 't1'])).toBe(
      'https://t1.tile/1/1/0'
    )
    expect(expandTileUrl(url, 1, 1, 0)).toBe(expandTileUrl(url, 1, 1, 0))
  })

  it('calls URL functions', () => {
    expect(expandTileUrl((z, x, y) => `${z}-${x}-${y}`, 4, 3, 2)).toBe('4-3-2')
  })
})

describe('quadkey', () => {
  it('matches the Bing tile system', () => {
    expect(quadkey(3, 3, 5)).toBe('213')
    expect(quadkey(0, 0, 0)).toBe('')
  })
})

describe('ancestorTile', () => {
  it('finds the ancestor and where the tile lies in it', () => {
    expect(ancestorTile(13, 4277, 2894, 11)).toEqual({
      z: 11,
      x: 1069,
      y: 723,
      region: { left: 0.25, top: 0.5, size: 0.25 }
    })
    expect(ancestorTile(5, 3, 4, 5).region).toEqual({
      left: 0,
      top: 0,
      size: 1
    })
  })
})

describe('loadWithFallback', () => {
  it('loads the tile itself when it exists', async () => {
    const load = vi.fn(() => Promise.resolve('data'))

    const result = await loadWithFallback(
      { z: 3, x: 1, y: 2, signal },
      20,
      load
    )

    expect(result).toEqual({
      data: 'data',
      z: 3,
      region: { left: 0, top: 0, size: 1 }
    })
    expect(load).toHaveBeenCalledExactlyOnceWith({ z: 3, x: 1, y: 2, signal })
  })

  it('cuts tiles beyond maxZoom out of the ancestor at maxZoom', async () => {
    const load = vi.fn(() => Promise.resolve('data'))

    const result = await loadWithFallback(
      { z: 16, x: 3, y: 1, signal },
      15,
      load
    )

    expect(load).toHaveBeenCalledExactlyOnceWith({ z: 15, x: 1, y: 0, signal })
    expect(result?.region).toEqual({ left: 0.5, top: 0.5, size: 0.5 })
  })

  it('falls back to ancestors while tiles are missing', async () => {
    const load = vi.fn(({ z }: { z: number }) =>
      Promise.resolve(z > 12 ? null : `z${z}`)
    )

    const result = await loadWithFallback(
      { z: 14, x: 5, y: 6, signal },
      20,
      load
    )

    expect(load.mock.calls.map(([tile]) => tile.z)).toEqual([14, 13, 12])
    expect(result).toEqual({
      data: 'z12',
      z: 12,
      region: { left: 0.25, top: 0.5, size: 0.25 }
    })
  })

  it(`gives up after ${MAX_FALLBACK_LEVELS} levels`, async () => {
    const load = vi.fn(() => Promise.resolve(null))

    expect(
      await loadWithFallback({ z: 14, x: 5, y: 6, signal }, 20, load)
    ).toBeNull()
    expect(load).toHaveBeenCalledTimes(MAX_FALLBACK_LEVELS + 1)
  })

  it('loads a shared ancestor once per memo', async () => {
    const load = vi.fn(({ z }: { z: number }) =>
      Promise.resolve(z === 12 ? null : 'parent')
    )
    const memo = new Map<string, Promise<string | null>>()

    await Promise.all(
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1]
      ].map(([x, y]) =>
        loadWithFallback({ z: 12, x, y, signal }, 20, load, memo)
      )
    )

    // four children, then their common parent once
    expect(load).toHaveBeenCalledTimes(5)
  })

  it('propagates errors other than a missing tile', async () => {
    const load = vi.fn(() => Promise.reject(new Error('500')))

    await expect(
      loadWithFallback({ z: 3, x: 1, y: 2, signal }, 20, load)
    ).rejects.toThrow('500')
    expect(load).toHaveBeenCalledOnce()
  })
})

import { describe, expect, it } from 'vitest'

import type { RoadFeature } from '../../../src'
import {
  type BridgePiece,
  clipLine,
  deckAt,
  deckProfile,
  joinBridges
} from '../../../src/layers/roads/bridges'

const road = (id?: string | number): RoadFeature => ({
  id,
  kind: 'primary',
  bridge: true,
  geometry: { type: 'LineString', coordinates: [] },
  properties: {}
})

const piece = (
  feature: RoadFeature,
  points: number[],
  cut: [boolean, boolean] = [false, false]
): BridgePiece => ({ feature, points, cut })

/** Map units within which ends meet; a map unit is 1000 m here. */
const TOLERANCE = 1e-6
const METERS = 1000

describe('clipLine', () => {
  it('cuts a line to a rectangle, telling which ends were cut', () => {
    const runs = clipLine([-1, 0.5, 0.5, 0.5, 0.5, 2], [0, 0, 1, 1])

    expect(runs).toEqual([
      { points: [0, 0.5, 0.5, 0.5, 0.5, 1], cut: [true, true] }
    ])
  })

  it('keeps whole lines uncut, and splits lines leaving and coming back', () => {
    expect(clipLine([0.2, 0.2, 0.8, 0.8], [0, 0, 1, 1])).toEqual([
      { points: [0.2, 0.2, 0.8, 0.8], cut: [false, false] }
    ])
    const runs = clipLine(
      [0.5, 0.5, 1.5, 0.5, 1.5, 0.8, 0.5, 0.8],
      [0, 0, 1, 1]
    )
    expect(runs.map(({ cut }) => cut)).toEqual([
      [false, true],
      [true, false]
    ])
  })
})

describe('joinBridges', () => {
  it('joins the pieces of a road cut at tile edges', () => {
    const viaduct = road(251934592)
    // the same way in two tiles, cut at x = 1 (the second listed reversed)
    const chains = joinBridges(
      [
        piece(viaduct, [1, 0.5, 1.4, 0.6], [true, false]),
        piece(viaduct, [0.6, 0.4, 1, 0.5], [false, true])
      ],
      TOLERANCE,
      METERS
    )

    expect(chains).toHaveLength(1)
    expect(chains[0].points).toEqual([0.6, 0.4, 1, 0.5, 1.4, 0.6])
    expect(chains[0].ends.map(({ type }) => type)).toEqual(['ground', 'ground'])
  })

  it('leaves an end cut where the rest is not loaded free', () => {
    const [chain] = joinBridges(
      [piece(road(1), [0.6, 0.4, 1, 0.5], [false, true])],
      TOLERANCE,
      METERS
    )

    expect(chain.ends.map(({ type }) => type)).toEqual(['ground', 'free'])
  })

  it('joins whole features without ids by their geometry', () => {
    const feature = (): RoadFeature => ({
      ...road(),
      geometry: {
        type: 'LineString',
        coordinates: [
          [6.6, 46.5],
          [6.7, 46.6]
        ]
      }
    })
    const chains = joinBridges(
      [
        piece(feature(), [0.2, 0.5, 1, 0.5], [false, true]),
        piece(feature(), [1, 0.5, 1.7, 0.5], [true, false])
      ],
      TOLERANCE,
      METERS
    )

    expect(chains).toHaveLength(1)
  })

  it('makes one bridge of roads meeting end to end, nothing else there', () => {
    // a viaduct mapped as three ways
    const [a, b, c] = [road('a'), road('b'), road('c')]
    const chains = joinBridges(
      [piece(b, [1, 0, 2, 0]), piece(a, [0, 0, 1, 0]), piece(c, [3, 0, 2, 0])],
      TOLERANCE,
      METERS
    )

    expect(chains).toHaveLength(1)
    expect(chains[0].points).toEqual([0, 0, 1, 0, 2, 0, 3, 0])
    expect(chains[0].features).toEqual([a, b, c])
    expect(chains[0].ends.map(({ type }) => type)).toEqual(['ground', 'ground'])
  })

  it('puts a ramp joining a bridge on that bridge', () => {
    const main = road('main')
    const ramp = road('ramp')
    const chains = joinBridges(
      [piece(main, [0, 0, 1, 0, 2, 0]), piece(ramp, [1, 0, 1.5, 0.5])],
      TOLERANCE,
      METERS
    )

    expect(chains).toHaveLength(2)
    const rampChain = chains.find(({ features }) => features[0] === ramp)
    const mainChain = chains.find(({ features }) => features[0] === main)
    expect(rampChain?.ends[0]).toEqual({
      type: 'on',
      bridge: mainChain,
      s: 1000
    })
    expect(rampChain?.ends[1]).toEqual({ type: 'ground' })
  })

  it('keeps the branches of a fork apart', () => {
    const chains = joinBridges(
      [
        piece(road('a'), [0, 0, 1, 0]),
        piece(road('b'), [1, 0, 2, 0]),
        piece(road('c'), [1, 0, 2, 1])
      ],
      TOLERANCE,
      METERS
    )

    expect(chains).toHaveLength(3)
    for (const chain of chains)
      expect(chain.ends[1].type === 'on' || chain.ends[0].type === 'on').toBe(
        true
      )
  })
})

describe('deckProfile', () => {
  const none = () => 0
  const ground = (heights: number[], length: number) =>
    heights.map((z, i) => ({
      s: (length * i) / (heights.length - 1),
      ground: z
    }))

  it('spans a valley straight from end to end', () => {
    const samples = ground([10, 6, 2, 4, 9], 100)
    const profile = deckProfile(samples, 100, {
      start: 10,
      end: 9,
      clearance: none
    })

    expect(profile).toEqual({ s: [0, 100], z: [10, 9] })
  })

  it('never goes under the ground: a string stretched over it', () => {
    // a bump in the middle, higher than the line between the ends
    const samples = ground([0, 2, 8, 2, 0], 100)
    const profile = deckProfile(samples, 100, {
      start: 0,
      end: 0,
      clearance: none
    })
    if (!profile) throw new Error('no profile')

    for (const { s, ground: z } of samples) {
      expect(deckAt(profile, s)).toBeGreaterThanOrEqual(z)
    }
    expect(profile).toEqual({ s: [0, 50, 100], z: [0, 8, 0] })
  })

  it('keeps a free end level with the fixed one', () => {
    const samples = ground([20, 5, 3, 1], 90)
    const profile = deckProfile(samples, 90, { start: 20, clearance: none })

    expect(profile).toEqual({ s: [0, 90], z: [20, 20] })
  })

  it('rises to the clearance from the ends', () => {
    const samples = ground([0, 0, 0, 0, 0], 100)
    const profile = deckProfile(samples, 100, {
      start: 0,
      end: 0,
      clearance: (s) => Math.min(5, 0.15 * Math.min(s, 100 - s))
    })

    expect(profile && deckAt(profile, 50)).toBeCloseTo(5, 9)
    expect(profile && deckAt(profile, 0)).toBe(0)
  })

  it('skips ground that is not loaded, and gives up without any', () => {
    const samples = [
      { s: 0, ground: undefined },
      { s: 50, ground: 4 },
      { s: 100, ground: undefined }
    ]

    // level with the only ground known (points in line are dropped)
    expect(deckProfile(samples, 100, { clearance: none })).toEqual({
      s: [0, 100],
      z: [4, 4]
    })
    expect(
      deckProfile([{ s: 0, ground: undefined }], 10, { clearance: none })
    ).toBeUndefined()
  })
})

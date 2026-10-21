import { describe, expect, it } from 'vitest'

import {
  clipHalfPlane,
  clipToRect,
  cutPolygon,
  gridCrossings,
  polygonArea
} from '../../src/layers/drape'

/** The triangle of the grid a point lies in: cell and half. */
const triangleOf = (col: number, row: number) => {
  const c = Math.floor(col)
  const r = Math.floor(row)
  return `${c} ${r} ${col - c + (row - r) <= 1 ? 'lower' : 'upper'}`
}

/** The triangle a convex piece lies in, judged by its centroid. */
const centroid = (piece: number[]) => {
  let [x, y] = [0, 0]
  for (let i = 0; i < piece.length; i += 2) {
    x += piece[i]
    y += piece[i + 1]
  }
  return [x / (piece.length / 2), y / (piece.length / 2)]
}

describe('clipHalfPlane', () => {
  it('keeps the part where a·x + b·y ≤ c, interpolating further components', () => {
    const square = [0, 0, 10, 2, 0, 20, 2, 2, 20, 0, 2, 10]
    // x ≤ 1, with a height z as the third component
    const left = clipHalfPlane(square, 1, 0, 1, 3)

    expect(left).toEqual([0, 0, 10, 1, 0, 15, 1, 2, 15, 0, 2, 10])
  })

  it('clips to a rectangle', () => {
    const big = [-1, -1, 3, -1, 3, 3, -1, 3]
    expect(Math.abs(polygonArea(clipToRect(big, [0, 0, 2, 1])))).toBe(2)
  })
})

describe('cutPolygon', () => {
  it('cuts a polygon into pieces that each lie in one triangle', () => {
    // a rotated rectangle across many cells
    const polygon = [0.3, 1.2, 4.1, 0.4, 4.6, 2.7, 0.8, 3.5]
    const pieces: number[][] = []
    cutPolygon(polygon, [0, 0, 8, 8], (piece) => pieces.push(piece))

    const area = pieces.reduce(
      (sum, piece) => sum + Math.abs(polygonArea(piece)),
      0
    )
    expect(area).toBeCloseTo(Math.abs(polygonArea(polygon)), 9)
    for (const piece of pieces) {
      const [cx, cy] = centroid(piece)
      const triangle = triangleOf(cx, cy)
      for (let i = 0; i < piece.length; i += 2) {
        // every vertex is in, or on the edge of, the centroid's triangle
        const [x, y] = [piece[i], piece[i + 1]]
        const [c, r] = triangle.split(' ').map(Number)
        expect(x).toBeGreaterThanOrEqual(c - 1e-9)
        expect(x).toBeLessThanOrEqual(c + 1 + 1e-9)
        expect(y).toBeGreaterThanOrEqual(r - 1e-9)
        expect(y).toBeLessThanOrEqual(r + 1 + 1e-9)
        const diagonal = x - c + (y - r) - 1
        if (triangle.endsWith('lower'))
          expect(diagonal).toBeLessThanOrEqual(1e-9)
        else expect(diagonal).toBeGreaterThanOrEqual(-1e-9)
      }
    }
  })

  it('keeps only what lies in the rectangle', () => {
    const polygon = [-2, -2, 2, -2, 2, 2, -2, 2]
    const pieces: number[][] = []
    cutPolygon(polygon, [0, 0, 1.5, 3], (piece) => pieces.push(piece))

    const area = pieces.reduce(
      (sum, piece) => sum + Math.abs(polygonArea(piece)),
      0
    )
    expect(area).toBeCloseTo(1.5 * 2, 9)
  })
})

describe('gridCrossings', () => {
  it('splits a segment where it crosses columns, rows and diagonals', () => {
    const [ax, ay, bx, by] = [0.2, 0.3, 2.7, 1.9]
    const ts = gridCrossings(ax, ay, bx, by)

    expect(ts[0]).toBe(0)
    expect(ts.at(-1)).toBe(1)
    expect([...ts].sort((a, b) => a - b)).toEqual(ts)
    // between two crossings the segment stays in one triangle
    for (let k = 1; k < ts.length; k++) {
      if (ts[k] - ts[k - 1] < 1e-12) continue
      const at = (t: number) => [ax + (bx - ax) * t, ay + (by - ay) * t]
      const [t0, t1] = [ts[k - 1], ts[k]]
      const middle = triangleOf(...(at((t0 + t1) / 2) as [number, number]))
      for (const t of [t0 + (t1 - t0) * 0.01, t1 - (t1 - t0) * 0.01]) {
        expect(triangleOf(...(at(t) as [number, number]))).toBe(middle)
      }
    }
  })
})

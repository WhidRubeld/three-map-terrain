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
    cutPolygon(polygon, [0, 0, 8, 8], (piece, length) =>
      pieces.push(Array.from(piece.subarray(0, length)))
    )

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
    cutPolygon(polygon, [0, 0, 1.5, 3], (piece, length) =>
      pieces.push(Array.from(piece.subarray(0, length)))
    )

    const area = pieces.reduce(
      (sum, piece) => sum + Math.abs(polygonArea(piece)),
      0
    )
    expect(area).toBeCloseTo(1.5 * 2, 9)
  })
})

describe('cutPolygon, step by step', () => {
  /** The cut as clipHalfPlane makes it: rect, row bands, cells, triangles. */
  const reference = (
    polygon: number[],
    rect: [number, number, number, number]
  ) => {
    const pieces: number[][] = []
    const clipped = clipToRect(polygon, rect)
    if (clipped.length < 6) return pieces
    const ys = clipped.filter((_, i) => i % 2 === 1)
    for (let r = Math.floor(Math.min(...ys)); r < Math.max(...ys); r++) {
      const band = clipHalfPlane(clipHalfPlane(clipped, 0, -1, -r), 0, 1, r + 1)
      if (band.length < 6) continue
      const xs = band.filter((_, i) => i % 2 === 0)
      for (let c = Math.floor(Math.min(...xs)); c < Math.max(...xs); c++) {
        const cell = clipHalfPlane(clipHalfPlane(band, -1, 0, -c), 1, 0, c + 1)
        if (cell.length < 6) continue
        for (const piece of [
          clipHalfPlane(cell, 1, 1, c + r + 1),
          clipHalfPlane(cell, -1, -1, -(c + r + 1))
        ]) {
          if (piece.length >= 6 && Math.abs(polygonArea(piece)) > 1e-9) {
            pieces.push(piece)
          }
        }
      }
    }
    return pieces
  }

  it('cuts exactly the pieces clipping one plane at a time cuts', () => {
    let seed = 5
    const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let k = 0; k < 200; k++) {
      // a convex polygon: points on an ellipse, in order
      const [cx, cy, rx, ry] = [
        next() * 10,
        next() * 10,
        next() * 4,
        next() * 4
      ]
      const count = 3 + Math.floor(next() * 8)
      const polygon: number[] = []
      for (let i = 0; i < count; i++) {
        const angle = (2 * Math.PI * (i + next() * 0.5)) / count
        polygon.push(cx + rx * Math.cos(angle), cy + ry * Math.sin(angle))
      }
      const pieces: number[][] = []
      cutPolygon(polygon, [1, 2, 9, 8], (piece, length) =>
        pieces.push(Array.from(piece.subarray(0, length)))
      )
      expect(pieces).toEqual(reference(polygon, [1, 2, 9, 8]))
    }
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

// What a layer drew on a tile, seen from above: its faces' triangles in a
// grid, to tell whether a point of the ground is taken. Internal.

import type { BufferGeometry } from 'three'

/** Cells of the grid along a side of the indexed area. */
const CELLS = 32

/** Triangles with less area than this (scene units²) are walls: no ground. */
const MIN_AREA = 1e-9

/** The faces of some geometries, from above, in a grid of their bounds. */
export class Footprint {
  /** `[ax, ay, bx, by, cx, cy]` of every triangle. */
  private readonly triangles: number[] = []
  private readonly cells: number[][] = []
  private minX = Infinity
  private minY = Infinity
  private size = 1

  constructor(geometries: readonly BufferGeometry[]) {
    for (const geometry of geometries) {
      const position = geometry.getAttribute('position')
      const index = geometry.getIndex()
      const count = index ? index.count : position.count
      for (let i = 0; i + 2 < count; i += 3) {
        const [a, b, c] = index
          ? [index.getX(i), index.getX(i + 1), index.getX(i + 2)]
          : [i, i + 1, i + 2]
        const t = [
          position.getX(a),
          position.getY(a),
          position.getX(b),
          position.getY(b),
          position.getX(c),
          position.getY(c)
        ]
        const area =
          (t[2] - t[0]) * (t[5] - t[1]) - (t[4] - t[0]) * (t[3] - t[1])
        if (Math.abs(area) < MIN_AREA) continue
        this.triangles.push(...t)
      }
    }
    const n = this.triangles.length / 6
    if (n === 0) return
    let [maxX, maxY] = [-Infinity, -Infinity]
    for (let i = 0; i < this.triangles.length; i += 2) {
      this.minX = Math.min(this.minX, this.triangles[i])
      this.minY = Math.min(this.minY, this.triangles[i + 1])
      maxX = Math.max(maxX, this.triangles[i])
      maxY = Math.max(maxY, this.triangles[i + 1])
    }
    this.size = Math.max(maxX - this.minX, maxY - this.minY, 1e-9) / CELLS
    for (let t = 0; t < n; t++) {
      const [x0, y0, x1, y1] = this.bounds(t)
      for (
        let j = this.cell(y0, this.minY);
        j <= this.cell(y1, this.minY);
        j++
      ) {
        for (
          let i = this.cell(x0, this.minX);
          i <= this.cell(x1, this.minX);
          i++
        ) {
          const key = j * CELLS + i
          ;(this.cells[key] ??= []).push(t)
        }
      }
    }
  }

  private cell(value: number, min: number) {
    return Math.min(
      CELLS - 1,
      Math.max(0, Math.floor((value - min) / this.size))
    )
  }

  private bounds(t: number): [number, number, number, number] {
    const v = this.triangles
    const k = t * 6
    return [
      Math.min(v[k], v[k + 2], v[k + 4]),
      Math.min(v[k + 1], v[k + 3], v[k + 5]),
      Math.max(v[k], v[k + 2], v[k + 4]),
      Math.max(v[k + 1], v[k + 3], v[k + 5])
    ]
  }

  /** Whether a point is on, or within `margin` of, a face. */
  covers(x: number, y: number, margin = 0): boolean {
    if (this.triangles.length === 0) return false
    const cells = Math.ceil(margin / this.size)
    const [ci, cj] = [
      Math.floor((x - this.minX) / this.size),
      Math.floor((y - this.minY) / this.size)
    ]
    if (
      ci + cells < 0 ||
      cj + cells < 0 ||
      ci - cells >= CELLS ||
      cj - cells >= CELLS
    ) {
      return false
    }
    const seen = new Set<number>()
    for (
      let j = Math.max(0, cj - cells);
      j <= Math.min(CELLS - 1, cj + cells);
      j++
    ) {
      for (
        let i = Math.max(0, ci - cells);
        i <= Math.min(CELLS - 1, ci + cells);
        i++
      ) {
        for (const t of this.cells[j * CELLS + i] ?? []) {
          if (seen.has(t)) continue
          seen.add(t)
          if (this.near(t, x, y, margin)) return true
        }
      }
    }
    return false
  }

  /** Whether a point is in triangle `t` or within `margin` of it. */
  private near(t: number, x: number, y: number, margin: number) {
    const v = this.triangles
    const k = t * 6
    const [ax, ay, bx, by, cx, cy] = [
      v[k],
      v[k + 1],
      v[k + 2],
      v[k + 3],
      v[k + 4],
      v[k + 5]
    ]
    const side = (px: number, py: number, qx: number, qy: number) =>
      (qx - px) * (y - py) - (qy - py) * (x - px)
    const [d1, d2, d3] = [
      side(ax, ay, bx, by),
      side(bx, by, cx, cy),
      side(cx, cy, ax, ay)
    ]
    const inside = !(
      (d1 < 0 || d2 < 0 || d3 < 0) &&
      (d1 > 0 || d2 > 0 || d3 > 0)
    )
    if (inside) return true
    if (margin <= 0) return false
    return (
      segmentDistance(x, y, ax, ay, bx, by) <= margin ||
      segmentDistance(x, y, bx, by, cx, cy) <= margin ||
      segmentDistance(x, y, cx, cy, ax, ay) <= margin
    )
  }
}

function segmentDistance(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
) {
  const [dx, dy] = [bx - ax, by - ay]
  const length = dx * dx + dy * dy
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length))
  return Math.hypot(x - ax - dx * t, y - ay - dy * t)
}

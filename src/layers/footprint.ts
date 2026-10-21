// What a layer drew on a tile, seen from above: its faces' triangles in a
// grid, to tell whether a point of the ground is taken. Internal.

import type { BufferGeometry } from 'three'

/** Cells along a side of the indexed area: about this many triangles a cell. */
const PER_CELL = 4
const MIN_CELLS = 16
const MAX_CELLS = 256

/** Triangles with less area than this (scene units²) are walls: no ground. */
const MIN_AREA = 1e-9

/** The faces of some geometries, from above, in a grid of their bounds. */
export class Footprint {
  /** `[ax, ay, bx, by, cx, cy]` of every triangle. */
  private readonly triangles: Float64Array
  /** The triangles of cell `k`: `items[start[k]]` up to `items[start[k + 1]]`. */
  private readonly start: Int32Array
  private readonly items: Int32Array
  private readonly cells: number
  private minX = Infinity
  private minY = Infinity
  private maxX = -Infinity
  private maxY = -Infinity
  private size = 1

  constructor(geometries: readonly BufferGeometry[]) {
    const triangles: number[] = []
    for (const geometry of geometries) {
      const position = geometry.getAttribute('position')
      const index = geometry.getIndex()
      const count = index ? index.count : position.count
      for (let i = 0; i + 2 < count; i += 3) {
        const a = index ? index.getX(i) : i
        const b = index ? index.getX(i + 1) : i + 1
        const c = index ? index.getX(i + 2) : i + 2
        const [ax, ay] = [position.getX(a), position.getY(a)]
        const [bx, by] = [position.getX(b), position.getY(b)]
        const [cx, cy] = [position.getX(c), position.getY(c)]
        const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
        if (Math.abs(area) < MIN_AREA) continue
        triangles.push(ax, ay, bx, by, cx, cy)
      }
    }
    this.triangles = new Float64Array(triangles)
    const n = triangles.length / 6
    this.cells = Math.min(
      MAX_CELLS,
      Math.max(MIN_CELLS, Math.ceil(Math.sqrt(n / PER_CELL)))
    )
    this.start = new Int32Array(this.cells * this.cells + 1)
    this.items = new Int32Array(0)
    if (n === 0) return
    const v = this.triangles
    for (let i = 0; i < v.length; i += 2) {
      this.minX = Math.min(this.minX, v[i])
      this.minY = Math.min(this.minY, v[i + 1])
      this.maxX = Math.max(this.maxX, v[i])
      this.maxY = Math.max(this.maxY, v[i + 1])
    }
    this.size =
      Math.max(this.maxX - this.minX, this.maxY - this.minY, 1e-9) / this.cells

    // the cells every triangle's bounds touch: counted, then listed
    const span = (t: number, each: (cell: number) => void) => {
      const k = t * 6
      const i0 = this.cell(Math.min(v[k], v[k + 2], v[k + 4]), this.minX)
      const i1 = this.cell(Math.max(v[k], v[k + 2], v[k + 4]), this.minX)
      const j0 = this.cell(Math.min(v[k + 1], v[k + 3], v[k + 5]), this.minY)
      const j1 = this.cell(Math.max(v[k + 1], v[k + 3], v[k + 5]), this.minY)
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) each(j * this.cells + i)
      }
    }
    const counts = this.start
    for (let t = 0; t < n; t++) span(t, (cell) => counts[cell + 1]++)
    for (let k = 1; k < counts.length; k++) counts[k] += counts[k - 1]
    this.items = new Int32Array(counts[counts.length - 1])
    const fill = counts.slice(0, -1)
    for (let t = 0; t < n; t++) {
      span(t, (cell) => {
        this.items[fill[cell]++] = t
      })
    }
  }

  /** Whether there are no faces. */
  get empty(): boolean {
    return this.triangles.length === 0
  }

  private cell(value: number, min: number) {
    return Math.min(
      this.cells - 1,
      Math.max(0, Math.floor((value - min) / this.size))
    )
  }

  /** Whether a point is on, or within `margin` of, a face. */
  covers(x: number, y: number, margin = 0): boolean {
    if (
      this.empty ||
      x < this.minX - margin ||
      x > this.maxX + margin ||
      y < this.minY - margin ||
      y > this.maxY + margin
    ) {
      return false
    }
    const [i0, i1] = [
      this.cell(x - margin, this.minX),
      this.cell(x + margin, this.minX)
    ]
    const [j0, j1] = [
      this.cell(y - margin, this.minY),
      this.cell(y + margin, this.minY)
    ]
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = j * this.cells + i
        for (let k = this.start[cell]; k < this.start[cell + 1]; k++) {
          if (this.near(this.items[k], x, y, margin)) return true
        }
      }
    }
    return false
  }

  /** Whether a point is in triangle `t` or within `margin` of it. */
  private near(t: number, x: number, y: number, margin: number) {
    const v = this.triangles
    const k = t * 6
    const ax = v[k]
    const ay = v[k + 1]
    const bx = v[k + 2]
    const by = v[k + 3]
    const cx = v[k + 4]
    const cy = v[k + 5]
    const d1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
    const d2 = (cx - bx) * (y - by) - (cy - by) * (x - bx)
    const d3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx)
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
  const dx = bx - ax
  const dy = by - ay
  const length = dx * dx + dy * dy
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length))
  return Math.hypot(x - ax - dx * t, y - ay - dy * t)
}

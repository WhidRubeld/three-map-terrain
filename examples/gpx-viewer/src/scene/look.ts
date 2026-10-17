import { CanvasTexture, NearestFilter, SRGBColorSpace } from 'three'

import { settingsStore } from '../state/settings'
import { terrainStore } from '../state/viewer'

/** Scene colors per theme; the 2D tokens live in index.css. */
export const PALETTE = {
  dark: {
    bg: '#0a0a0a',
    fg: '#f4f4f4',
    halo: '#000000',
    relief: '#5a5a5a',
    wall: '#141414',
    edge: '#8c8c8c'
  },
  light: {
    bg: '#f2f2f2',
    fg: '#0a0a0a',
    halo: '#ffffff',
    relief: '#e4e4e4',
    wall: '#dcdcdc',
    edge: '#6e6e6e'
  }
} as const

export type Palette = (typeof PALETTE)[keyof typeof PALETTE]

// ------------------------------------------------------------ intro timeline

/** `[start, duration]` in seconds after the terrain grid is ready. */
export const INTRO = {
  rise: [0, 1.6],
  camera: [0, 2.6],
  route: [0.9, 2.4]
} as const satisfies Record<string, readonly [number, number]>

/** 0…1 progress of an intro step; always 1 with animations off. */
export function introPhase([start, duration]: readonly [
  number,
  number
]): number {
  const { readyAt } = terrainStore.state
  if (readyAt === null) return 0
  if (!settingsStore.state.animations) return 1
  const t = ((performance.now() - readyAt) / 1000 - start) / duration
  return Math.min(1, Math.max(0, t))
}

export const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2

// ------------------------------------------------------------ pixel sprites

/**
 * Marker glyphs drawn on a pixel grid (`#` = ink). Every glyph gets a
 * one-pixel halo in the opposite color so it reads on any imagery.
 */
export const GLYPHS = {
  start: [
    '#######',
    '#.....#',
    '#.###.#',
    '#.###.#',
    '#.###.#',
    '#.....#',
    '#######'
  ],
  finish: [
    '#.#.#.#',
    '.#.#.#.',
    '#.#.#.#',
    '.#.#.#.',
    '#.#.#.#',
    '.#.#.#.',
    '#.#.#.#'
  ],
  waypoint: [
    '...#...',
    '..###..',
    '.#####.',
    '#######',
    '.#####.',
    '..###..',
    '...#...'
  ],
  mark: ['###', '###', '###'],
  playhead: [
    '..###..',
    '.#...#.',
    '#..#..#',
    '#.###.#',
    '#..#..#',
    '.#...#.',
    '..###..'
  ],
  hover: [
    '##.....##',
    '#.......#',
    '.........',
    '....#....',
    '...###...',
    '....#....',
    '.........',
    '#.......#',
    '##.....##'
  ],
  cursor: ['..#..', '..#..', '#####', '..#..', '..#..']
} as const

export type GlyphName = keyof typeof GLYPHS

/** Width of a glyph in grid cells, halo included. */
export const glyphCells = (name: GlyphName) => GLYPHS[name][0].length + 2

export function glyphTexture(
  name: GlyphName,
  ink: string,
  halo: string
): CanvasTexture {
  const rows = GLYPHS[name]
  const size = rows[0].length + 2
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) throw new Error('2D canvas context is not available')

  const inked = (x: number, y: number) => rows[y - 1]?.[x - 1] === '#'
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inked(x, y)) context.fillStyle = ink
      else if (
        [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => inked(x + dx, y + dy)))
      )
        context.fillStyle = halo
      else continue
      context.fillRect(x, y, 1, 1)
    }
  }

  const texture = new CanvasTexture(canvas)
  texture.magFilter = texture.minFilter = NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = SRGBColorSpace
  return texture
}

/**
 * Point size (drawing-buffer pixels) that draws one glyph cell as a whole
 * number of pixels: 2 CSS px per cell, never less than 1 buffer pixel.
 */
export const glyphSize = (name: GlyphName, dpr: number) =>
  glyphCells(name) * Math.max(1, Math.round(2 * dpr))

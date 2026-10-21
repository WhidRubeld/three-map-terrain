import { describe, expect, it, vi } from 'vitest'

import {
  applyColorFilter,
  colorFilter,
  parseFilter
} from '../../src/terrain/color-filter'

/** RGBA8 pixels through `filter`. */
const filtered = (filter: string, ...pixels: number[][]) => {
  const data = new Uint8ClampedArray(pixels.flat())
  applyColorFilter(data, parseFilter(filter))
  return Array.from({ length: pixels.length }, (_, i) => [
    ...data.subarray(i * 4, i * 4 + 4)
  ])
}

const RED = [255, 0, 0, 255]
const GREEN = [0, 255, 0, 255]
const BLUE = [0, 0, 255, 255]
const WHITE = [255, 255, 255, 255]

describe('parseFilter', () => {
  it('parses no filter into no steps', () => {
    for (const filter of ['none', 'NONE', '', '  ']) {
      expect(parseFilter(filter)).toEqual([])
    }
  })

  it('takes numbers, percentages and the defaults of CSS', () => {
    const grayscale = parseFilter('grayscale(1)')
    expect(grayscale).toHaveLength(1)
    expect(parseFilter('grayscale(100%)')).toEqual(grayscale)
    expect(parseFilter('grayscale()')).toEqual(grayscale)
    expect(parseFilter(' GrayScale( 1 ) ')).toEqual(grayscale)
    expect(parseFilter('brightness(150%)')).toEqual(
      parseFilter('brightness(1.5)')
    )
  })

  it('clamps amounts over 100% where CSS does', () => {
    for (const name of ['grayscale', 'sepia', 'invert', 'opacity']) {
      expect(parseFilter(`${name}(2)`)).toEqual(parseFilter(`${name}(1)`))
    }
    for (const name of ['saturate', 'brightness', 'contrast']) {
      expect(parseFilter(`${name}(2)`)).not.toEqual(parseFilter(`${name}(1)`))
    }
  })

  it('takes angles in every CSS unit', () => {
    const [half] = parseFilter('hue-rotate(180deg)')
    for (const angle of ['0.5turn', '200grad', `${Math.PI}rad`]) {
      const [matrix] = parseFilter(`hue-rotate(${angle})`)
      matrix.forEach((v, i) => {
        expect(v).toBeCloseTo(half[i], 12)
      })
    }
  })

  it('drops functions that change nothing', () => {
    expect(
      parseFilter('grayscale(0) brightness(1) contrast(100%) hue-rotate(0)')
    ).toEqual([])
    expect(parseFilter('saturate(1) hue-rotate(1turn)')).toEqual([])
  })

  it('keeps the order of the functions', () => {
    const [grayscale] = parseFilter('grayscale(1)')
    const [brightness] = parseFilter('brightness(1.1)')
    expect(parseFilter('grayscale(1) brightness(1.1)')).toEqual([
      grayscale,
      brightness
    ])
  })

  it('rejects anything but the color functions of CSS', () => {
    for (const filter of [
      'blur(2px)',
      'drop-shadow(1px 1px red)',
      'url(#filter)',
      'greyscale(1)',
      'grayscale(-1)',
      'grayscale(1deg)',
      'hue-rotate(90)',
      'hue-rotate(10%)',
      'grayscale(1',
      'grayscale(1) none',
      'grayscale(1) 2'
    ]) {
      expect(() => parseFilter(filter), filter).toThrow(SyntaxError)
    }
  })
})

describe('applyColorFilter', () => {
  it('desaturates with the luminance weights of grayscale()', () => {
    // 0.2126, 0.7152, 0.0722 × 255
    expect(filtered('grayscale(1)', RED, GREEN, BLUE)).toEqual([
      [54, 54, 54, 255],
      [182, 182, 182, 255],
      [18, 18, 18, 255]
    ])
    expect(filtered('grayscale(0.5)', RED)).toEqual([[155, 27, 27, 255]])
    expect(filtered('saturate(0)', RED)).toEqual([[54, 54, 54, 255]])
  })

  it('applies the matrices of the spec, clamped to 0…255', () => {
    // rows of sepia(1) sum to 1.351, 1.203, 0.937
    expect(filtered('sepia(1)', WHITE)).toEqual([[255, 255, 239, 255]])
    expect(filtered('hue-rotate(180deg)', RED)).toEqual([[0, 109, 109, 255]])
    expect(filtered('invert(1)', [0, 128, 255, 255])).toEqual([
      [255, 127, 0, 255]
    ])
    expect(filtered('contrast(0)', RED, BLUE)).toEqual([
      [128, 128, 128, 255],
      [128, 128, 128, 255]
    ])
    expect(filtered('brightness(1.1)', [100, 200, 250, 255])).toEqual([
      [110, 220, 255, 255]
    ])
  })

  it('changes only the alpha with opacity()', () => {
    expect(filtered('opacity(0.5)', [10, 20, 30, 255])).toEqual([
      [10, 20, 30, 128]
    ])
  })

  it('clamps after every function, as CSS does', () => {
    // 200 · 2 → 255, then · 0.5 → 128 — not 200
    expect(filtered('brightness(2) brightness(0.5)', [200, 0, 0, 255])).toEqual(
      [[128, 0, 0, 255]]
    )
    expect(filtered('brightness(0.5) brightness(2)', [200, 0, 0, 255])).toEqual(
      [[200, 0, 0, 255]]
    )
  })

  it('leaves the pixels without steps', () => {
    const data = new Uint8ClampedArray([1, 2, 3, 4])
    applyColorFilter(data, [])
    expect([...data]).toEqual([1, 2, 3, 4])
  })
})

describe('colorFilter', () => {
  it('parses a filter once for all the tiles', () => {
    const steps = colorFilter('sepia(0.25)')
    expect(colorFilter('sepia(0.25)')).toBe(steps)
    expect(steps).toEqual(parseFilter('sepia(0.25)'))
  })

  it('ignores an invalid filter with one warning, as CSS does', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(colorFilter('grayscale(1) blur(1px)')).toEqual([])
    expect(colorFilter('grayscale(1) blur(1px)')).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(
      /grayscale\(1\) blur\(1px\).*grayscale, sepia, saturate, hue-rotate/
    )
  })
})

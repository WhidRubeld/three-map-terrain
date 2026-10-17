import { type BrowserContext, expect, type Page, test } from '@playwright/test'

import type {} from '../playground/types'
import { RETRY_DELAYS } from '../src/image'
import { mockTileServers, QUADRANT_COLORS } from './fixtures'

const collectErrors = (page: Page) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  return errors
}

const openPlayground = async (
  page: Page,
  query: string,
  textureReplies?: Map<string, Buffer[]>
) => {
  const { requests } = await mockTileServers(page, { textureReplies })
  await page.goto(`/?${query}`)
  await page.waitForFunction(() => window.__playground !== undefined)
  await page.evaluate(() => window.__playground?.ready)
  await page.waitForFunction(
    () =>
      window.__playground?.texturedTiles() ===
      Object.keys(window.__playground?.map.tileCache ?? {}).length
  )
  const backend = await page.evaluate(() => window.__playground?.backend)
  return { backend, requests }
}

/** Decodes a PNG screenshot in the page and returns RGB values at `points`. */
const samplePixels = (
  page: Page,
  png: Buffer,
  points: (readonly [number, number])[]
) =>
  page.evaluate(
    async ({ base64, points }) => {
      const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob()
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context')
      context.drawImage(bitmap, 0, 0)
      return points.map(([u, v]) => {
        const { data } = context.getImageData(
          Math.floor(u * bitmap.width),
          Math.floor(v * bitmap.height),
          1,
          1
        )
        return [data[0], data[1], data[2]]
      })
    },
    { base64: png.toString('base64'), points }
  )

/**
 * Screen position of a point of the single tile in `view=top&nTiles=1`
 * (`x` east, `y` south, both 0…1): the tile spans the full height, centered.
 */
const tilePoint = (page: Page, x: number, y: number) => {
  const { width, height } = page.viewportSize() ?? { width: 1, height: 1 }
  return [0.5 + ((x - 0.5) * height) / width, y] as const
}

const expectColor = (
  pixel: number[],
  expected: readonly number[],
  tolerance = 2,
  label = ''
) => {
  expected.forEach((channel, i) => {
    expect(
      Math.abs(pixel[i] - channel),
      `${label} ${JSON.stringify(pixel)}`
    ).toBeLessThanOrEqual(tolerance)
  })
}

for (const renderer of ['webgl', 'webgpu'] as const) {
  test.describe(`${renderer} renderer`, () => {
    test('renders a textured 3×3 terrain without errors', async ({
      page
    }, testInfo) => {
      const errors = collectErrors(page)
      const { backend } = await openPlayground(page, `renderer=${renderer}`)
      const revision = await page.evaluate(() => window.__playground?.revision)
      testInfo.annotations.push(
        { type: 'backend', description: backend },
        { type: 'three', description: `r${revision ?? '?'}` }
      )

      const state = await page.evaluate(() => {
        const map = window.__playground?.map
        return {
          ready: map?.ready,
          meshes: map?.terrain.children.length,
          textured: window.__playground?.texturedTiles()
        }
      })
      expect(state).toEqual({ ready: true, meshes: 9, textured: 9 })

      const png = await page.locator('canvas').screenshot()
      const pixels = await samplePixels(page, png, [
        [0.5, 0.5],
        [0.35, 0.6],
        [0.65, 0.6]
      ])
      // terrain (lit texture) covers the middle of the view, not the background
      for (const pixel of pixels) expect(pixel).not.toEqual([34, 34, 34])

      expect(errors).toEqual([])
    })

    test('lays out child textures NW | NE / SW | SE', async ({ page }) => {
      const errors = collectErrors(page)
      await openPlayground(
        page,
        `renderer=${renderer}&view=top&lights=0&nTiles=1`
      )

      const png = await page.locator('canvas').screenshot()
      const [nw, ne, sw, se] = await samplePixels(page, png, [
        tilePoint(page, 0.25, 0.25),
        tilePoint(page, 0.75, 0.25),
        tilePoint(page, 0.25, 0.75),
        tilePoint(page, 0.75, 0.75)
      ])

      const actual = { nw, ne, sw, se }
      for (const [quadrant, expected] of Object.entries(QUADRANT_COLORS)) {
        const pixel = actual[quadrant as keyof typeof actual]
        expectColor(pixel, expected, 2, quadrant)
      }
      expect(errors).toEqual([])
    })
  })
}

// Tile servers occasionally deliver a cut-off body with status 200, which
// `createImageBitmap` rejects (EOX does it for some tiles).
test.describe('truncated texture responses', () => {
  const SW_CHILD = '2138/1447' // of the center tile 11/1069/723
  const JPEG_COLOR = [64, 128, 192] as const
  const ATTEMPTS = RETRY_DELAYS.length + 1

  const truncatedJpeg = async (context: BrowserContext) => {
    const helper = await context.newPage()
    const jpeg = await helper.evaluate(async (color) => {
      const canvas = new OffscreenCanvas(256, 256)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context')
      context.fillStyle = `rgb(${color.join(' ')})`
      context.fillRect(0, 0, 256, 256)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg' })
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    }, JPEG_COLOR)
    await helper.close()
    return Buffer.from(jpeg).subarray(0, jpeg.length - 64)
  }

  test('re-requests the texture and shows the complete image', async ({
    page,
    context
  }) => {
    const truncated = await truncatedJpeg(context)
    const errors = collectErrors(page)

    const { requests } = await openPlayground(
      page,
      'renderer=webgl&view=top&lights=0&nTiles=1',
      new Map([[SW_CHILD, [truncated]]])
    )

    expect(requests.get(SW_CHILD)).toBe(2)
    const png = await page.locator('canvas').screenshot()
    const [sw] = await samplePixels(page, png, [tilePoint(page, 0.25, 0.75)])
    expectColor(sw, QUADRANT_COLORS.sw, 2, 'sw')
    expect(errors).toEqual([])
  })

  test('falls back to the partial image when every attempt is truncated', async ({
    page,
    context
  }) => {
    const truncated = await truncatedJpeg(context)
    const errors = collectErrors(page)

    const { requests } = await openPlayground(
      page,
      'renderer=webgl&view=top&lights=0&nTiles=1',
      new Map([[SW_CHILD, Array<Buffer>(ATTEMPTS).fill(truncated)]])
    )

    expect(requests.get(SW_CHILD)).toBe(ATTEMPTS)
    const png = await page.locator('canvas').screenshot()
    // the first rows of the truncated JPEG are intact
    const [sw] = await samplePixels(page, png, [tilePoint(page, 0.25, 0.55)])
    expectColor(sw, JPEG_COLOR, 8, 'sw')
    expect(errors).toEqual([])
  })
})

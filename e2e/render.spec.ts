import { expect, type Page, test } from '@playwright/test'

import type {} from '../playground/types'
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
  textureOverrides?: Map<string, Buffer>
) => {
  await mockTileServers(page, { textureOverrides })
  await page.goto(`/?${query}`)
  await page.waitForFunction(() => window.__playground !== undefined)
  await page.evaluate(() => window.__playground?.ready)
  await page.waitForFunction(
    () =>
      window.__playground?.texturedTiles() ===
      Object.keys(window.__playground?.map.tileCache ?? {}).length
  )
  return page.evaluate(() => window.__playground?.backend)
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

for (const renderer of ['webgl', 'webgpu'] as const) {
  test.describe(`${renderer} renderer`, () => {
    test('renders a textured 3×3 terrain without errors', async ({
      page
    }, testInfo) => {
      const errors = collectErrors(page)
      const backend = await openPlayground(page, `renderer=${renderer}`)
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
      const viewport = page.viewportSize() ?? { width: 1, height: 1 }
      // the single tile spans the full height, centered horizontally
      const quarter = (0.25 * viewport.height) / viewport.width
      const [nw, ne, sw, se] = await samplePixels(page, png, [
        [0.5 - quarter, 0.25],
        [0.5 + quarter, 0.25],
        [0.5 - quarter, 0.75],
        [0.5 + quarter, 0.75]
      ])

      const actual = { nw, ne, sw, se }
      for (const [quadrant, expected] of Object.entries(QUADRANT_COLORS)) {
        const pixel = actual[quadrant as keyof typeof actual]
        expected.forEach((channel, i) => {
          expect(
            Math.abs(pixel[i] - channel),
            `${quadrant} ${JSON.stringify(pixel)}`
          ).toBeLessThanOrEqual(2)
        })
      }
      expect(errors).toEqual([])
    })
  })
}

// Tile servers occasionally deliver a cut-off body with status 200.
// `createImageBitmap` rejects such files; the loader must fall back to <img>.
test('textures a tile whose child image is truncated', async ({
  page,
  context
}) => {
  const helper = await context.newPage()
  const jpeg = Buffer.from(
    await helper.evaluate(async () => {
      const canvas = new OffscreenCanvas(256, 256)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context')
      context.fillStyle = '#4080c0'
      context.fillRect(0, 0, 256, 256)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg' })
      return Array.from(new Uint8Array(await blob.arrayBuffer()))
    })
  )
  await helper.close()
  const truncated = jpeg.subarray(0, jpeg.length - 64)

  const errors = collectErrors(page)
  // SW child of the center tile 11/1069/723
  await openPlayground(
    page,
    'renderer=webgl&nTiles=1',
    new Map([['2138/1447', truncated]])
  )

  expect(await page.evaluate(() => window.__playground?.texturedTiles())).toBe(
    1
  )
  expect(errors).toEqual([])
})

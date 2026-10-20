import { type BrowserContext, expect, type Page, test } from '@playwright/test'

import type {} from '../playground/types'
import { Utils } from '../src'
import { RETRY_DELAYS } from '../src/io/fetch'
import { encodeVectorTile } from '../test/support/mvt-encoder'
import {
  mockTileServers,
  QUADRANT_COLORS,
  syntheticElevation
} from './fixtures'

const BACKGROUND = [34, 34, 34] as const

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
  servers: Parameters<typeof mockTileServers>[1] = {}
) => {
  const { requests } = await mockTileServers(page, servers)
  await page.goto(`/?${query}`)
  await page.waitForFunction(() => window.__playground !== undefined)
  await page.evaluate(() => window.__playground?.ready)
  await page.waitForFunction(
    () =>
      window.__playground?.texturedTiles() ===
      Object.keys(window.__playground?.map.tileCache ?? {}).length
  )
  await page.evaluate(() => window.__playground?.buildings?.whenReady())
  // everything is loaded: one last frame, so that capturing it does not have
  // to compete with a render loop (seconds per frame on software renderers)
  await page.evaluate(() => window.__playground?.freeze())
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

/**
 * Per quadrant of the single tile (`view=top&nTiles=1`): the share of
 * background pixels and the mean color of the others.
 */
const quadrantStats = (page: Page, png: Buffer) =>
  page.evaluate(
    async ({ base64, background }) => {
      const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob()
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('no 2d context')
      context.drawImage(bitmap, 0, 0)
      // the tile spans the full height, centered horizontally
      const size = bitmap.height
      const left = Math.round((bitmap.width - size) / 2)
      const half = Math.floor(size / 2)

      const stats = (x: number, y: number) => {
        const { data } = context.getImageData(x + 2, y + 2, half - 4, half - 4)
        const mean = [0, 0, 0]
        let backgroundPixels = 0
        for (let i = 0; i < data.length; i += 4) {
          const pixel = [data[i], data[i + 1], data[i + 2]]
          if (pixel.every((c, k) => Math.abs(c - background[k]) <= 2)) {
            backgroundPixels++
          } else {
            pixel.forEach((c, k) => (mean[k] += c))
          }
        }
        const total = data.length / 4
        const lines = Math.max(1, total - backgroundPixels)
        return {
          background: backgroundPixels / total,
          mean: mean.map((c) => c / lines)
        }
      }

      return {
        nw: stats(left, 0),
        ne: stats(left + half, 0),
        sw: stats(left, half),
        se: stats(left + half, half)
      }
    },
    { base64: png.toString('base64'), background: BACKGROUND }
  )

/** Cosine of the angle between `a - BACKGROUND` and `b - BACKGROUND`. */
const similarity = (a: readonly number[], b: readonly number[]) => {
  const u = a.map((c, i) => c - BACKGROUND[i])
  const v = b.map((c, i) => c - BACKGROUND[i])
  const dot = u.reduce((sum, c, i) => sum + c * v[i], 0)
  return dot / (Math.hypot(...u) * Math.hypot(...v))
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

/**
 * three's WebGPU backend fails on software adapters (SwiftShader on GPU-less
 * CI runners: GPUValidationError, then device lost). There WebGPURenderer is
 * tested with its WebGL2 backend instead; the `backend` annotation tells
 * which one ran.
 */
const rendererQuery = async (page: Page, renderer: 'webgl' | 'webgpu') => {
  if (renderer === 'webgl') return 'renderer=webgl'
  // navigator.gpu needs a secure context (not about:blank); a plain module
  // from the dev server is one, without starting the map
  await page.goto('/types.ts')
  const architecture = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter()
    return adapter?.info.architecture
  })
  return architecture === 'swiftshader'
    ? 'renderer=webgpu&forceWebGL=1'
    : 'renderer=webgpu'
}

for (const renderer of ['webgl', 'webgpu'] as const) {
  test.describe(`${renderer} renderer`, () => {
    test('renders a textured 3×3 terrain without errors', async ({
      page
    }, testInfo) => {
      const query = await rendererQuery(page, renderer)
      const errors = collectErrors(page)
      const { backend } = await openPlayground(page, query)
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
      for (const pixel of pixels) expect(pixel).not.toEqual([...BACKGROUND])

      expect(errors).toEqual([])
    })

    test('renders the wireframe option with the texture on the lines', async ({
      page
    }) => {
      const query = await rendererQuery(page, renderer)
      const errors = collectErrors(page)
      await openPlayground(
        page,
        `${query}&view=top&lights=0&nTiles=1&wireframe=1&segments=8`
      )

      const stats = await quadrantStats(
        page,
        await page.locator('canvas').screenshot()
      )

      for (const [quadrant, color] of Object.entries(QUADRANT_COLORS)) {
        const { background, mean } = stats[quadrant as keyof typeof stats]
        // 4×4 cells of ~75 px per quadrant: mostly background between lines…
        expect(background, quadrant).toBeGreaterThan(0.7)
        // …and the lines carry that quadrant's texture (blended with the
        // background by antialiasing, hence a direction check)
        expect(similarity(mean, color), quadrant).toBeGreaterThan(0.95)
      }
      expect(errors).toEqual([])
    })

    test('lays out child textures NW | NE / SW | SE', async ({ page }) => {
      const query = await rendererQuery(page, renderer)
      const errors = collectErrors(page)
      await openPlayground(page, `${query}&view=top&lights=0&nTiles=1`)

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

test('click → map.pick returns the geolocation under the pointer', async ({
  page
}) => {
  const errors = collectErrors(page)
  await openPlayground(page, 'renderer=webgl&view=top&lights=0&nTiles=1')
  const canvas = page.locator('canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas is not visible')

  // a point a quarter from the west and three quarters from the north edge
  const [u, v] = tilePoint(page, 0.25, 0.75)
  await canvas.click({ position: { x: u * box.width, y: v * box.height } })
  const picked = await page.evaluate(() => window.__playground?.lastPick)

  const [w, s, e, n] = Utils.tile2bbox([1069, 723, 11])
  const pixel = (e - w) / box.height // the tile spans the full height
  expect(Math.abs((picked?.lon ?? 0) - (w + 0.25 * (e - w)))).toBeLessThan(
    2 * pixel
  )
  expect(Math.abs((picked?.lat ?? 0) - (n - 0.75 * (n - s)))).toBeLessThan(
    2 * pixel
  )
  // the altitude of the synthetic terrain at that pixel of tile 1069/723
  // (±2 px of click precision, ~13 m/px at most)
  const expected = syntheticElevation(1069 * 256 + 64, 723 * 256 + 192)
  expect(Math.abs((picked?.alt ?? 0) - expected)).toBeLessThan(50)
  expect(errors).toEqual([])
})

test('draws buildings from vector tiles on the terrain and picks them', async ({
  page
}) => {
  const errors = collectErrors(page)
  const zoom = 14
  const center = Utils.position2tile(46.57634, 7.9904, zoom)
  // a 60 m building over the NW quadrant: from 0.1 to 0.4 of the tile
  const [a, b] = [410, 1638] // of the 4096 extent
  const tile = encodeVectorTile([
    {
      name: 'building',
      features: [
        {
          id: 99,
          type: 3,
          properties: { render_height: 60, render_min_height: 0 },
          geometry: [[a, a, b, a, b, b, a, b]]
        }
      ]
    }
  ])

  await openPlayground(
    page,
    `renderer=webgl&view=top&lights=0&nTiles=1&zoom=${zoom}&buildings=openfreemap`,
    {
      vectorTiles: (z, x, y) =>
        z === zoom && x === center.x && y === center.y ? tile : undefined
    }
  )
  expect(await page.evaluate(() => window.__playground?.buildings?.count)).toBe(
    1
  )

  const canvas = page.locator('canvas')
  const [roof, terrain] = await samplePixels(page, await canvas.screenshot(), [
    tilePoint(page, 0.25, 0.25),
    tilePoint(page, 0.75, 0.75)
  ])
  // the buildings take on the map's color (white by default), unlit — over
  // the red NW texture
  expectColor(roof, [255, 255, 255], 2, 'roof')
  expectColor(terrain, QUADRANT_COLORS.se, 2, 'terrain')

  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas is not visible')
  const [u, v] = tilePoint(page, 0.25, 0.25)
  await canvas.click({ position: { x: u * box.width, y: v * box.height } })
  const picked = await page.evaluate(() => window.__playground?.lastBuilding)
  expect(picked).toMatchObject({ id: 99, height: 60 })
  expect(errors).toEqual([])
})

test('draws terrain without imagery in its color, buildings in tone', async ({
  page
}) => {
  const errors = collectErrors(page)
  const zoom = 14
  const center = Utils.position2tile(46.57634, 7.9904, zoom)
  const [a, b] = [410, 1638]
  const tile = encodeVectorTile([
    {
      name: 'building',
      features: [
        {
          type: 3,
          properties: { render_height: 60 },
          geometry: [[a, a, b, a, b, b, a, b]]
        }
      ]
    }
  ])

  const { requests } = await openPlayground(
    page,
    `renderer=webgl&view=top&lights=0&nTiles=1&zoom=${zoom}&api=none&color=4080c0&buildings=openfreemap`,
    {
      vectorTiles: (z, x, y) =>
        z === zoom && x === center.x && y === center.y ? tile : undefined
    }
  )

  // no imagery: not a single texture request
  expect(requests.size).toBe(0)
  const [roof, terrain] = await samplePixels(
    page,
    await page.locator('canvas').screenshot(),
    [tilePoint(page, 0.25, 0.25), tilePoint(page, 0.75, 0.75)]
  )
  expectColor(terrain, [64, 128, 192], 2, 'terrain')
  expectColor(roof, [64, 128, 192], 2, 'roof')
  expect(errors).toEqual([])
})

test('switches imagery and style at runtime, in one go', async ({ page }) => {
  const errors = collectErrors(page)
  await openPlayground(
    page,
    'renderer=webgl&view=top&lights=0&nTiles=1&segments=8'
  )

  // a look switch: imagery off, wireframe in a color — the order of the
  // calls must not matter
  await page.evaluate(async () => {
    const map = window.__playground?.map
    map?.setSource({ api: 'none' })
    map?.setMaterial({ wireframe: true, color: '#4080c0' })
    await map?.whenReady()
    await window.__playground?.freeze()
  })

  const stats = await quadrantStats(
    page,
    await page.locator('canvas').screenshot()
  )
  for (const { background, mean } of Object.values(stats)) {
    expect(background).toBeGreaterThan(0.7) // lines, not a filled surface
    expect(similarity(mean, [64, 128, 192])).toBeGreaterThan(0.95)
  }
  expect(errors).toEqual([])
})

test('exports the textured terrain as GLB', async ({ page }) => {
  const errors = collectErrors(page)
  await openPlayground(page, 'renderer=webgl&view=top&nTiles=1')

  const glb = await page.evaluate(async () => {
    const blob = await window.__playground?.map.export('glb')
    if (!blob) throw new Error('no map')
    const view = new DataView(await blob.arrayBuffer())
    const length = view.getUint32(12, true)
    const json = JSON.parse(
      new TextDecoder().decode(new Uint8Array(view.buffer, 20, length))
    ) as { meshes: unknown[]; images?: { mimeType: string }[] }
    return {
      type: blob.type,
      magic: view.getUint32(0, true),
      meshes: json.meshes.length,
      images: json.images?.map(({ mimeType }) => mimeType)
    }
  })

  expect(glb).toEqual({
    type: 'model/gltf-binary',
    magic: 0x46546c67, // 'glTF'
    meshes: 1,
    images: ['image/png']
  })
  expect(errors).toEqual([])
})

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
      { textureReplies: new Map([[SW_CHILD, [truncated]]]) }
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
      {
        textureReplies: new Map([
          [SW_CHILD, Array<Buffer>(ATTEMPTS).fill(truncated)]
        ])
      }
    )

    expect(requests.get(SW_CHILD)).toBe(ATTEMPTS)
    const png = await page.locator('canvas').screenshot()
    // the first rows of the truncated JPEG are intact
    const [sw] = await samplePixels(page, png, [tilePoint(page, 0.25, 0.55)])
    expectColor(sw, JPEG_COLOR, 8, 'sw')
    expect(errors).toEqual([])
  })
})

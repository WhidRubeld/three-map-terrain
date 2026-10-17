#!/usr/bin/env node
// Renders the README images in docs/ from the built examples, with real
// tiles: `yarn build`, build both examples, then `node scripts/screenshots.mjs`.
// Uses the installed Google Chrome (it renders on the GPU even headless) and
// `cwebp` (libwebp) on PATH.

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'

import { chromium } from '@playwright/test'

const ROOT = new URL('..', import.meta.url).pathname
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
}

/** A static server for one built example. */
function serve(folder) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    const file = join(folder, normalize(path === '/' ? '/index.html' : path))
    try {
      const body = await readFile(file)
      response.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream'
      })
      response.end(body)
    } catch {
      response.writeHead(404).end()
    }
  })
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, port: server.address().port }))
  )
}

const SCENES = [
  // the README's hero: the live example
  { name: 'hero', example: 'react', click: [770, 520] },
  { name: 'basic', example: 'basic', click: [640, 470] }
]

const work = await mkdtemp(join(tmpdir(), 'three-map-terrain-screenshots-'))
const browser = await chromium.launch({ channel: 'chrome' })

for (const scene of SCENES) {
  const { server, port } = await serve(
    join(ROOT, 'examples', scene.example, 'dist')
  )
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2
  })
  await page.goto(`http://localhost:${port}/`)
  // tiles and their textures: wait until the network is quiet
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2000)
  await page.mouse.click(...scene.click)
  await page.waitForTimeout(1500)
  const png = join(work, `${scene.name}.png`)
  await page.screenshot({ path: png })
  const webp = join(ROOT, 'docs', `${scene.name}.webp`)
  execFileSync('cwebp', ['-quiet', '-q', '82', '-m', '6', png, '-o', webp])
  console.log(webp)
  await page.close()
  server.close()
}

await browser.close()
await rm(work, { recursive: true })

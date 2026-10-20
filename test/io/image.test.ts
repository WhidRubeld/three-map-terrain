import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

import { RETRY_DELAYS } from '../../src/io/fetch'
import { loadImage, loadImageData } from '../../src/io/image'
import {
  bitmaps,
  createImageBitmap,
  FakeOffscreenCanvas,
  fetch,
  installBrowserFakes,
  replies,
  settle
} from '../support/browser-fakes'

const ATTEMPTS = RETRY_DELAYS.length + 1

const cacheModes = () =>
  fetch.mock.calls.map(([, init]) => init?.cache ?? 'unset')

beforeEach(installBrowserFakes)
afterEach(() => {
  vi.useRealTimers()
})

describe('loadImage', () => {
  it('fetches with CORS and the HTTP cache on the first attempt', async () => {
    const controller = new AbortController()
    await loadImage('a', controller.signal)

    expect(fetch).toHaveBeenCalledExactlyOnceWith('a', {
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
      cache: 'default'
    })
  })

  it('retries network failures and overloaded servers, bypassing the cache', async () => {
    replies.set('a', ['network-error', 503])

    const image = await settle(loadImage('a'))

    expect(image).toMatchObject({ url: 'a' })
    expect(cacheModes()).toEqual(['default', 'reload', 'reload'])
  })

  it('does not retry client errors', async () => {
    await expect(loadImage('missing')).rejects.toThrow(
      'Failed to load missing: 404 Nope'
    )
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('gives up after the last retry', async () => {
    replies.set('a', Array<'network-error'>(ATTEMPTS).fill('network-error'))

    const error = await settle(loadImage('a')).catch((e: unknown) => e)

    expect(error).toMatchObject({
      message: 'Failed to load a',
      cause: new TypeError('Failed to fetch')
    })
    expect(fetch).toHaveBeenCalledTimes(ATTEMPTS)
  })

  it('re-requests a truncated body instead of showing it', async () => {
    replies.set('a', ['truncated'])

    const image = await settle(loadImage('a'))

    expect(image).toMatchObject({ url: 'a' })
    expect(cacheModes()).toEqual(['default', 'reload'])
  })

  it('falls back to <img> when the body stays undecodable', async () => {
    const image = await settle(loadImage('a-truncated'))

    expect(image).toMatchObject({ url: 'img:a-truncated' })
    expect(fetch).toHaveBeenCalledTimes(ATTEMPTS)
  })

  it('rejects when no decoder can read the body', async () => {
    await expect(settle(loadImage('a-corrupt'))).rejects.toThrow(
      'Failed to decode a-corrupt'
    )
  })

  it('stops retrying as soon as it is aborted', async () => {
    replies.set('a', ['network-error'])
    const controller = new AbortController()

    const pending = loadImage('a', controller.signal)
    const result = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(10) // inside the first backoff
    controller.abort()

    await result
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe('loadImageData', () => {
  it('reads raw pixels without color-space conversion', async () => {
    const pixels = await loadImageData('elevation.png')

    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none'
    })
    expect(FakeOffscreenCanvas.instances[0].contextSettings).toEqual({
      willReadFrequently: true
    })
    expect([pixels.width, pixels.height]).toEqual([256, 256])
    expect(bitmaps[0].close).toHaveBeenCalled()
  })

  it('re-requests a truncated elevation tile', async () => {
    replies.set('elevation.png', ['truncated'])

    await settle(loadImageData('elevation.png'))

    expect(cacheModes()).toEqual(['default', 'reload'])
  })

  it('never falls back to lenient decoding for elevation data', async () => {
    await expect(
      settle(loadImageData('elevation-truncated.png'))
    ).rejects.toThrow('Failed to decode elevation-truncated.png')
    expect(fetch).toHaveBeenCalledTimes(ATTEMPTS)
  })
})

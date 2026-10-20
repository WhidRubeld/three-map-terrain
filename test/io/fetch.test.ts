import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HttpError,
  isNotFound,
  loadArrayBuffer,
  loadJson
} from '../../src/io/fetch'
import {
  fetch,
  installBrowserFakes,
  replies,
  settle
} from '../support/browser-fakes'

beforeEach(installBrowserFakes)
afterEach(() => {
  vi.useRealTimers()
})

describe('loadArrayBuffer', () => {
  it('returns the body, undefined for 204 No Content', async () => {
    const body = await loadArrayBuffer('tile.pbf')
    expect(new TextDecoder().decode(body)).toBe('tile.pbf')

    replies.set('empty.pbf', [204])
    expect(await loadArrayBuffer('empty.pbf')).toBeUndefined()
  })

  it('throws HttpError with the status, retrying server errors', async () => {
    replies.set('tile.pbf', [503])
    await settle(loadArrayBuffer('tile.pbf'))
    expect(fetch).toHaveBeenCalledTimes(2)

    const error = await loadArrayBuffer('missing.pbf').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(HttpError)
    expect(isNotFound(error)).toBe(true)
  })

  it('passes request options, e.g. a POST body', async () => {
    const body = new URLSearchParams({ data: 'query' })
    await loadArrayBuffer('api', undefined, { method: 'POST', body })

    expect(fetch).toHaveBeenCalledWith(
      'api',
      expect.objectContaining({ method: 'POST', body })
    )
  })
})

describe('loadJson', () => {
  it('parses JSON and retries a cut-off body', async () => {
    fetch.mockImplementationOnce(() => Promise.resolve(new Response('{"a":')))
    fetch.mockImplementationOnce(() => Promise.resolve(new Response('{"a":1}')))

    expect(await settle(loadJson('data.json'))).toEqual({ a: 1 })
    expect(fetch.mock.calls.map(([, init]) => init?.cache)).toEqual([
      'default',
      'reload'
    ])
  })
})

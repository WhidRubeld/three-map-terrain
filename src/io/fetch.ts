// fetch() with retries of transient failures (shared by every tile loader).

/** Backoff before each retry of a transient failure, in ms. */
export const RETRY_DELAYS = [250, 1000, 3000] as const

/** HTTP statuses worth another attempt (timeouts, rate limits, server errors). */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/** A failure that may succeed on another attempt. */
export class TransientError extends Error {}

/** The server answered with an error status. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

class TransientHttpError extends TransientError {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError'

/** `true` for a 404: the tile does not exist (e.g. deeper than the source). */
export const isNotFound = (error: unknown) =>
  (error instanceof HttpError || error instanceof TransientHttpError) &&
  error.status === 404

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason as Error)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })

/** Runs `attempt` again after `TransientError`s, up to `RETRY_DELAYS.length` times. */
export async function retry<T>(
  signal: AbortSignal | undefined,
  attempt: (index: number) => Promise<T>
): Promise<T> {
  for (let index = 0; ; index++) {
    try {
      return await attempt(index)
    } catch (error) {
      if (!(error instanceof TransientError)) throw error
      if (index >= RETRY_DELAYS.length) throw error
      await delay(RETRY_DELAYS[index], signal)
    }
  }
}

/** Extra `fetch()` options, e.g. `{ method: 'POST', body }` for Overpass. */
export type RequestOptions = Pick<RequestInit, 'method' | 'body' | 'headers'>

/** One request; failures worth retrying are thrown as `TransientError`. */
export async function fetchResponse(
  url: string,
  signal: AbortSignal | undefined,
  // a retry must not get the same broken response from the HTTP cache
  cache: RequestCache,
  options?: RequestOptions
): Promise<Response> {
  try {
    const response = await fetch(url, {
      signal,
      mode: 'cors',
      credentials: 'omit',
      cache,
      ...options
    })
    if (!response.ok) {
      const message = `Failed to load ${url}: ${response.status} ${response.statusText}`
      throw RETRYABLE_STATUS.has(response.status)
        ? new TransientHttpError(message, response.status)
        : new HttpError(message, response.status)
    }
    return response
  } catch (error) {
    // fetch() and body reads reject with TypeError on network failures
    if (!(error instanceof TypeError)) throw error
    throw new TransientError(`Failed to load ${url}`, { cause: error })
  }
}

/** Reads a body; a connection lost meanwhile is worth another attempt. */
export async function readBody<T>(url: string, read: () => Promise<T>) {
  try {
    return await read()
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    throw new TransientError(`Failed to load ${url}`, { cause: error })
  }
}

/** Fetches a body with retries; `undefined` for 204 No Content. */
export async function loadArrayBuffer(
  url: string,
  signal?: AbortSignal,
  options?: RequestOptions
): Promise<ArrayBuffer | undefined> {
  return retry(signal, async (index) => {
    const response = await fetchResponse(
      url,
      signal,
      index === 0 ? 'default' : 'reload',
      options
    )
    if (response.status === 204) return undefined
    return readBody(url, () => response.arrayBuffer())
  })
}

/** Fetches and parses JSON with retries (a cut-off body is retried). */
export async function loadJson(
  url: string,
  signal?: AbortSignal,
  options?: RequestOptions
): Promise<unknown> {
  return retry(signal, async (index) => {
    const response = await fetchResponse(
      url,
      signal,
      index === 0 ? 'default' : 'reload',
      options
    )
    const text = await readBody(url, () => response.text())
    try {
      return JSON.parse(text) as unknown
    } catch (cause) {
      throw new TransientError(`Failed to parse ${url}`, { cause })
    }
  })
}

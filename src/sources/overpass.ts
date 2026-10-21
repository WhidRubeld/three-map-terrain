// OpenStreetMap through the Overpass API: every tag, one request at a time.

import { loadJson } from '../io/fetch'

export const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter'

/** One request at a time per endpoint: servers limit parallel ones. */
const queues = new Map<string, Promise<unknown>>()

/**
 * An Overpass API server. Queries run one after the other — for every
 * layer using the endpoint — as public instances ask.
 */
export class Overpass {
  readonly endpoint: string
  readonly attribution = '© OpenStreetMap contributors'

  constructor({ endpoint = OVERPASS_ENDPOINT }: { endpoint?: string } = {}) {
    this.endpoint = endpoint
  }

  /** Runs an Overpass QL query after those queued before; its JSON answer. */
  query(query: string, signal: AbortSignal): Promise<unknown> {
    const previous = queues.get(this.endpoint) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => {
        signal.throwIfAborted()
        return loadJson(this.endpoint, signal, {
          method: 'POST',
          body: new URLSearchParams({ data: query })
        })
      })
    queues.set(this.endpoint, next)
    return next
  }
}

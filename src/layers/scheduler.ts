// Draws the layers' tiles a slice at a time, across every layer and map, so
// that no frame waits long for them: the tiles nearest the focus first,
// back to the browser after a few milliseconds. Internal.

/** Milliseconds a slice draws before the main thread is given back. */
export const SLICE_BUDGET = 6

/** A tile a layer can draw now. */
export interface DrawJob {
  /** From the map's focus, in tiles: the nearest is drawn first. */
  distance: number
  run(): void
}

/** A layer with tiles to draw. */
export interface Drawer {
  /**
   * The tile it would draw next, or `undefined`. Tiles waiting for other
   * layers are left out unless `waiting` — then nothing else can be drawn.
   */
  next(waiting: boolean): DrawJob | undefined
  /** Whether it is loading something it will then draw. */
  loading(): boolean
}

const drawers = new Set<Drawer>()
let scheduled = false
let waiters: (() => void)[] = []

const now = () => performance.now()

/** Runs `callback` in a task of its own: the browser renders in between. */
let post: ((callback: () => void) => void) | undefined

function postTask(callback: () => void) {
  post ??= (() => {
    // a MessageChannel task is not clamped like setTimeout(0) (4 ms)
    if (
      typeof MessageChannel === 'undefined' ||
      typeof document === 'undefined'
    ) {
      return (next: () => void) => void setTimeout(next, 0)
    }
    const channel = new MessageChannel()
    const queue: (() => void)[] = []
    channel.port1.onmessage = () => queue.shift()?.()
    return (next: () => void) => {
      queue.push(next)
      channel.port2.postMessage(undefined)
    }
  })()
  post(callback)
}

export function addDrawer(drawer: Drawer) {
  drawers.add(drawer)
}

export function removeDrawer(drawer: Drawer) {
  drawers.delete(drawer)
  // whoever waits on it may be done
  kick()
}

/** There may be something to draw: a slice runs soon. */
export function kick() {
  if (scheduled) return
  scheduled = true
  postTask(slice)
}

/** Resolves after the next slice. */
export function sliced(): Promise<void> {
  return new Promise((resolve) => waiters.push(resolve))
}

function best(waiting: boolean): DrawJob | undefined {
  let found: DrawJob | undefined
  for (const drawer of drawers) {
    const job = drawer.next(waiting)
    if (job && (!found || job.distance < found.distance)) found = job
  }
  return found
}

function slice() {
  scheduled = false
  const deadline = now() + SLICE_BUDGET
  try {
    for (;;) {
      // tiles waiting on layers that load nothing more would wait forever
      // (layers avoiding each other): those are drawn anyway
      const job =
        best(false) ??
        ([...drawers].some((drawer) => drawer.loading())
          ? undefined
          : best(true))
      if (!job) break
      try {
        job.run()
      } catch (error) {
        console.error(error)
      }
      if (now() >= deadline) {
        kick()
        break
      }
    }
  } finally {
    const done = waiters
    waiters = []
    for (const resolve of done) resolve()
  }
}

// Display formatting. Values come back as [value, unit] so the UI can set the
// number in the dot-matrix face and the unit in the mono face.

export type Parts = readonly [value: string, unit: string]

const DASH = '—'
const MINUS = '−'

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const fixed = (digits: number) =>
  new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })
const oneDecimal = fixed(1)
const twoDecimals = fixed(2)

export const joinParts = ([value, unit]: Parts) =>
  unit ? `${value} ${unit}` : value

export function distanceParts(meters: number | null): Parts {
  if (meters === null) return [DASH, '']
  if (meters < 1000) return [integer.format(meters), 'M']
  return [
    meters < 100_000
      ? twoDecimals.format(meters / 1000)
      : oneDecimal.format(meters / 1000),
    'KM'
  ]
}

export function elevationParts(meters: number | null, signed = false): Parts {
  if (meters === null) return [DASH, '']
  const sign = signed
    ? meters > 0
      ? '+'
      : meters < 0
        ? MINUS
        : ''
    : meters < 0
      ? MINUS
      : ''
  return [sign + integer.format(Math.abs(meters)), 'M']
}

export function speedParts(metersPerSecond: number | null): Parts {
  if (metersPerSecond === null) return [DASH, '']
  return [oneDecimal.format(metersPerSecond * 3.6), 'KM/H']
}

export function gradeParts(grade: number | null): Parts {
  if (grade === null) return [DASH, '']
  const percent = Math.round(grade * 100)
  return [
    (percent > 0 ? '+' : percent < 0 ? MINUS : '') + Math.abs(percent),
    '%'
  ]
}

/** `1:54:12`, or `54:12` under an hour. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return DASH
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

const clock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
})
const shortClock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
})
const date = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric'
})
const offset = new Intl.DateTimeFormat('en-US', { timeZoneName: 'shortOffset' })

export const formatClock = (ms: number | null, seconds = true) =>
  ms === null ? DASH : (seconds ? clock : shortClock).format(ms)

export const formatDate = (ms: number | null) =>
  ms === null ? DASH : date.format(ms).toUpperCase()

/** Viewer's UTC offset at `ms`, e.g. `GMT+2`. */
export function timezoneLabel(ms: number | null): string {
  if (ms === null) return ''
  return (
    offset.formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value ?? ''
  )
}

export function formatLat(lat: number, digits = 5): string {
  return `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? 'N' : 'S'}`
}

export function formatLon(lon: number, digits = 5): string {
  return `${Math.abs(lon).toFixed(digits)}°${lon >= 0 ? 'E' : 'W'}`
}

export const formatCount = (n: number) => integer.format(n)

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${oneDecimal.format(bytes / 1024)} KB`
  return `${oneDecimal.format(bytes / 1024 ** 2)} MB`
}

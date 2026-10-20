// Minimal Mapbox Vector Tile (MVT 2.x) decoder: protobuf + geometry commands.
// Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1

export type VectorTileValue = string | number | boolean

export interface VectorTileFeature {
  /** Feature id; ids above 2^53 lose precision. */
  id: number | undefined
  /** 1 point, 2 line string, 3 polygon (0 unknown). */
  type: number
  properties: Record<string, VectorTileValue>
  /**
   * The geometry in tile coordinates (0…`extent`, y down): one flat
   * `[x0, y0, x1, y1, …]` array per point, line or ring. Rings are not closed
   * (the first point is not repeated).
   */
  geometry: number[][]
}

export interface VectorTileLayer {
  name: string
  extent: number
  features: VectorTileFeature[]
}

const decoder = new TextDecoder()

/** Reads protobuf wire format. Varints beyond 2^53 lose precision. */
class Reader {
  pos = 0
  private readonly view: DataView

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  varint(): number {
    let value = 0
    for (let shift = 0; shift < 70; shift += 7) {
      if (this.pos >= this.bytes.length) throw new Error('Truncated varint')
      const byte = this.bytes[this.pos++]
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return value
    }
    throw new Error('Malformed varint')
  }

  /** A two's complement int64 varint, exact up to 2^53 in magnitude. */
  int64(): number {
    let low = 0
    let high = 0
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.bytes.length) throw new Error('Truncated varint')
      const byte = this.bytes[this.pos++]
      const bits = byte & 0x7f
      if (i < 4) low |= bits << (7 * i)
      else if (i === 4) {
        low |= bits << 28
        high = bits >> 4
      } else high |= bits << (7 * i - 32)
      if (byte < 0x80) return (high | 0) * 2 ** 32 + (low >>> 0)
    }
    throw new Error('Malformed varint')
  }

  /** Iterates the fields of a message until `end`. */
  fields(end: number, read: (field: number, wireType: number) => void) {
    while (this.pos < end) {
      const key = this.varint()
      const start = this.pos
      read(Math.floor(key / 8), key & 7)
      // a field the callback did not read is skipped
      if (this.pos === start) this.skip(key & 7)
    }
    if (this.pos > end) throw new Error('Field runs past its message')
  }

  skip(wireType: number) {
    switch (wireType) {
      case 0:
        this.varint()
        break
      case 1:
        this.pos += 8
        break
      case 2:
        this.pos += this.varint()
        break
      case 5:
        this.pos += 4
        break
      default:
        throw new Error(`Unsupported protobuf wire type ${wireType}`)
    }
  }

  /** End offset of the length-delimited field starting here. */
  end(): number {
    const length = this.varint()
    return this.pos + length
  }

  bytesField(): Uint8Array {
    const end = this.end()
    const value = this.bytes.subarray(this.pos, end)
    this.pos = end
    return value
  }

  string(): string {
    return decoder.decode(this.bytesField())
  }

  float(): number {
    const value = this.view.getFloat32(this.pos, true)
    this.pos += 4
    return value
  }

  double(): number {
    const value = this.view.getFloat64(this.pos, true)
    this.pos += 8
    return value
  }

  packed(): number[] {
    const end = this.end()
    const values: number[] = []
    while (this.pos < end) values.push(this.varint())
    return values
  }
}

const zigzag = (n: number) => (n % 2 === 1 ? -(n + 1) / 2 : n / 2)

function readValue(reader: Reader): VectorTileValue | undefined {
  let value: VectorTileValue | undefined
  reader.fields(reader.end(), (field, wireType) => {
    if (field === 1 && wireType === 2) value = reader.string()
    else if (field === 2 && wireType === 5) value = reader.float()
    else if (field === 3 && wireType === 1) value = reader.double()
    else if (field === 4 && wireType === 0) value = reader.int64()
    else if (field === 5 && wireType === 0) value = reader.varint()
    else if (field === 6 && wireType === 0) value = zigzag(reader.varint())
    else if (field === 7 && wireType === 0) value = reader.varint() !== 0
  })
  return value
}

/** Decodes MoveTo / LineTo / ClosePath commands into flat point lists. */
export function decodeGeometry(commands: readonly number[]): number[][] {
  const parts: number[][] = []
  let part: number[] | undefined
  let x = 0
  let y = 0
  for (let i = 0; i < commands.length;) {
    const command = commands[i++]
    const id = command & 7
    const count = Math.floor(command / 8)
    if (id === 1 || id === 2) {
      for (let k = 0; k < count && i + 1 < commands.length; k++) {
        x += zigzag(commands[i++])
        y += zigzag(commands[i++])
        if (id === 1 || !part) {
          part = [x, y]
          parts.push(part)
        } else {
          part.push(x, y)
        }
      }
    } else if (id !== 7) {
      throw new Error(`Unknown vector tile geometry command ${id}`)
    }
  }
  return parts
}

interface RawFeature {
  id: number | undefined
  type: number
  tags: number[]
  geometry: number[]
}

function readFeature(reader: Reader, end: number): RawFeature {
  const feature: RawFeature = { id: undefined, type: 0, tags: [], geometry: [] }
  reader.fields(end, (field, wireType) => {
    if (field === 1 && wireType === 0) feature.id = reader.varint()
    else if (field === 2 && wireType === 2) feature.tags = reader.packed()
    else if (field === 3 && wireType === 0) feature.type = reader.varint()
    else if (field === 4 && wireType === 2) feature.geometry = reader.packed()
  })
  return feature
}

function readLayer(reader: Reader, wanted?: ReadonlySet<string>) {
  const end = reader.end()
  let name = ''
  let extent = 4096
  const keys: string[] = []
  const values: (VectorTileValue | undefined)[] = []
  // features are decoded once the layer is known to be wanted
  const featureRanges: [start: number, end: number][] = []
  reader.fields(end, (field, wireType) => {
    if (field === 1 && wireType === 2) name = reader.string()
    else if (field === 5 && wireType === 0) extent = reader.varint()
    else if (field === 3 && wireType === 2) keys.push(reader.string())
    else if (field === 4 && wireType === 2) values.push(readValue(reader))
    else if (field === 2 && wireType === 2) {
      const featureEnd = reader.end()
      featureRanges.push([reader.pos, featureEnd])
      reader.pos = featureEnd
    }
  })
  if (wanted && !wanted.has(name)) return undefined

  const resume = reader.pos
  const features = featureRanges.map(
    ([start, featureEnd]): VectorTileFeature => {
      reader.pos = start
      const raw = readFeature(reader, featureEnd)
      const properties: Record<string, VectorTileValue> = {}
      for (let i = 0; i + 1 < raw.tags.length; i += 2) {
        const key = keys.at(raw.tags[i])
        const value = values.at(raw.tags[i + 1])
        if (key !== undefined && value !== undefined) properties[key] = value
      }
      return {
        id: raw.id,
        type: raw.type,
        properties,
        geometry: decodeGeometry(raw.geometry)
      }
    }
  )
  reader.pos = resume
  return { name, extent, features }
}

/**
 * Decodes a vector tile (uncompressed; see `gunzip`). Only the `layers`
 * named are decoded when given.
 */
export function decodeVectorTile(
  data: ArrayBuffer | Uint8Array,
  layers?: readonly string[]
): Record<string, VectorTileLayer> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const reader = new Reader(bytes)
  const wanted = layers ? new Set(layers) : undefined
  const result: Record<string, VectorTileLayer> = {}
  reader.fields(bytes.length, (field, wireType) => {
    if (field !== 3 || wireType !== 2) return
    const layer = readLayer(reader, wanted)
    if (layer) result[layer.name] = layer
  })
  return result
}

/** `true` if the bytes start with the gzip magic number. */
export const isGzip = (bytes: Uint8Array) =>
  bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b

/**
 * Decompresses gzip-compressed tiles (servers that send them without
 * `Content-Encoding`, PMTiles archives); returns other bytes as they are.
 */
export async function gunzip(
  data: ArrayBuffer | Uint8Array
): Promise<Uint8Array> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (!isGzip(bytes)) return bytes
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// Minimal vector tile (MVT) encoder for fixtures; the inverse of src/mvt.ts.

export type EncodedValue =
  string | number | boolean | { float: number } | { int: number }

export interface EncodedFeature {
  id?: number
  /** 1 point, 2 line string, 3 polygon */
  type: 1 | 2 | 3
  properties?: Record<string, EncodedValue>
  /** Flat `[x0, y0, …]` lists in tile coordinates; rings not closed. */
  geometry: number[][]
}

export interface EncodedLayer {
  name: string
  extent?: number
  features: EncodedFeature[]
}

class Writer {
  bytes: number[] = []

  varint(value: number) {
    let n = value
    while (n >= 0x80) {
      this.bytes.push((n % 0x80) | 0x80)
      n = Math.floor(n / 0x80)
    }
    this.bytes.push(n)
  }

  tag(field: number, wireType: number) {
    this.varint(field * 8 + wireType)
  }

  message(field: number, write: (writer: Writer) => void) {
    const inner = new Writer()
    write(inner)
    this.tag(field, 2)
    this.varint(inner.bytes.length)
    this.bytes.push(...inner.bytes)
  }

  string(field: number, value: string) {
    const encoded = new TextEncoder().encode(value)
    this.tag(field, 2)
    this.varint(encoded.length)
    this.bytes.push(...encoded)
  }

  packed(field: number, values: number[]) {
    this.message(field, (writer) => {
      for (const value of values) writer.varint(value)
    })
  }

  fixed(field: number, wireType: 1 | 5, value: number) {
    const buffer = new DataView(new ArrayBuffer(wireType === 1 ? 8 : 4))
    if (wireType === 1) buffer.setFloat64(0, value, true)
    else buffer.setFloat32(0, value, true)
    this.tag(field, wireType)
    this.bytes.push(...new Uint8Array(buffer.buffer))
  }
}

const zigzag = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1)

function commands(type: 1 | 2 | 3, parts: number[][]) {
  const out: number[] = []
  let x = 0
  let y = 0
  // tile coordinates are integers
  const move = (px: number, py: number) => {
    const [ix, iy] = [Math.round(px), Math.round(py)]
    out.push(zigzag(ix - x), zigzag(iy - y))
    x = ix
    y = iy
  }
  if (type === 1) {
    const points = parts.flat()
    out.push(1 + (points.length / 2) * 8)
    for (let i = 0; i < points.length; i += 2) move(points[i], points[i + 1])
    return out
  }
  for (const part of parts) {
    out.push(1 + 8) // MoveTo, 1 point
    move(part[0], part[1])
    out.push(2 + ((part.length - 2) / 2) * 8) // LineTo
    for (let i = 2; i < part.length; i += 2) move(part[i], part[i + 1])
    if (type === 3) out.push(7 + 8) // ClosePath
  }
  return out
}

function writeValue(writer: Writer, value: EncodedValue) {
  if (typeof value === 'string') writer.string(1, value)
  else if (typeof value === 'boolean') {
    writer.tag(7, 0)
    writer.varint(value ? 1 : 0)
  } else if (typeof value === 'object' && 'float' in value) {
    writer.fixed(2, 5, value.float)
  } else if (typeof value === 'object') {
    // int64, two's complement
    writer.tag(4, 0)
    let n = BigInt.asUintN(64, BigInt(value.int))
    while (n >= 0x80n) {
      writer.bytes.push(Number(n % 0x80n) | 0x80)
      n /= 0x80n
    }
    writer.bytes.push(Number(n))
  } else if (Number.isInteger(value) && value >= 0) {
    writer.tag(5, 0)
    writer.varint(value)
  } else if (Number.isInteger(value)) {
    writer.tag(6, 0)
    writer.varint(zigzag(value))
  } else {
    writer.fixed(3, 1, value)
  }
}

/** Encodes layers into an (uncompressed) vector tile. */
export function encodeVectorTile(layers: EncodedLayer[]): Uint8Array {
  const tile = new Writer()
  for (const layer of layers) {
    tile.message(3, (writer) => {
      writer.tag(15, 0)
      writer.varint(2)
      writer.string(1, layer.name)
      const keys: string[] = []
      const values: EncodedValue[] = []
      const index = <T>(list: T[], item: T) => {
        const found = list.findIndex(
          (entry) => JSON.stringify(entry) === JSON.stringify(item)
        )
        if (found !== -1) return found
        list.push(item)
        return list.length - 1
      }
      for (const feature of layer.features) {
        writer.message(2, (featureWriter) => {
          if (feature.id !== undefined) {
            featureWriter.tag(1, 0)
            featureWriter.varint(feature.id)
          }
          const tags = Object.entries(feature.properties ?? {}).flatMap(
            ([key, value]) => [index(keys, key), index(values, value)]
          )
          if (tags.length) featureWriter.packed(2, tags)
          featureWriter.tag(3, 0)
          featureWriter.varint(feature.type)
          featureWriter.packed(4, commands(feature.type, feature.geometry))
        })
      }
      for (const key of keys) writer.string(3, key)
      for (const value of values) {
        writer.message(4, (valueWriter) => {
          writeValue(valueWriter, value)
        })
      }
      if (layer.extent !== undefined) {
        writer.tag(5, 0)
        writer.varint(layer.extent)
      }
    })
  }
  return new Uint8Array(tile.bytes)
}

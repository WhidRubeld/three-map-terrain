import { Color, type ColorRepresentation, type Material } from 'three'

import { WATERWAY_WIDTHS, type WaterFeature } from './features'
import { WaterSource, type WaterSourceProps } from './WaterSource.class'
import type { FlatRing } from '../extrude'
import type { Position, Ring } from '../features'
import {
  type DrawFeatures,
  type FeatureHit,
  FeatureLayer,
  type LayerDistance,
  type LayerMaterial,
  type Look
} from '../FeatureLayer.class'
import type { TileContext } from '../TileContext.class'

export interface WaterOptions {
  /** Where the water comes from: a `WaterSource`, or the props to create one. */
  source: WaterSource | WaterSourceProps
  /**
   * How the water is drawn: the look (by default the map's, the water in
   * blue unless it gives a `color`), one material for every face, or a
   * material per part: `'water'` (areas and waterways on the terrain; give
   * it a polygon offset), `'lines'` (shores and center lines, in
   * wireframe). Areas have UVs in meters east and north, waterways across
   * (0 to 1) and along in meters.
   */
  material?: LayerMaterial
  /** Replaces or extends the geometry. See `FeatureLayer`. */
  build?: (
    ctx: TileContext<WaterFeature>,
    draw: DrawFeatures<WaterFeature>
  ) => void
  /** Meters across waterways by kind (`river`, `stream`…), for those without a width. */
  widths: Readonly<Partial<Record<string, number>>>
  /** Color `highlight()` uses by default. */
  highlightColor: ColorRepresentation
  /**
   * Hides the water of tiles farther than this from the camera, in meters.
   * See `FeatureLayer.maxDistance`.
   */
  maxDistance?: LayerDistance
  /** Terrain tiles below this zoom get no water. */
  minZoom: number
}

export const defaultWaterOptions: Readonly<
  Omit<WaterOptions, 'source' | 'material' | 'build'>
> = Object.freeze({ widths: {}, highlightColor: 0xffb020, minZoom: 10 })

/** The water under a ray: the feature and where it was hit. */
export type WaterHit = FeatureHit<WaterFeature>

/** The water's color unless the look gives one. */
export const WATER_COLOR = '#8ab7dc'

const WHITE = new Color(0xffffff)

/** Water is drawn in front of the terrain, behind roads (−4). */
const WATER_OFFSET = { factor: -1, units: -2 }

/** Meters across waterways without a width or a known kind. */
const DEFAULT_WIDTH = 3

const isPolygon = (
  geometry: WaterFeature['geometry']
): geometry is Extract<WaterFeature['geometry'], { type: 'Polygon' }> =>
  geometry.type === 'Polygon'

/**
 * Water on the terrain — the sea, lakes, rivers, streams —
 * `map.addLayer(new Water({ source: { api: 'openfreemap' } }))`. Areas and
 * waterways lie on the rendered surface, cut along its triangles, as roads
 * do; the holes of areas (islands) stay land. Waterways in tunnels are not
 * drawn.
 */
export class Water extends FeatureLayer<WaterFeature> {
  declare readonly source: WaterSource
  readonly options: Omit<WaterOptions, 'source'>

  constructor({
    source,
    ...props
  }: Pick<WaterOptions, 'source'> & Partial<WaterOptions>) {
    const options = { ...defaultWaterOptions, ...props }
    super({
      source: source instanceof WaterSource ? source : new WaterSource(source),
      build: options.build,
      material: options.material,
      highlightColor: options.highlightColor,
      minZoom: options.minZoom,
      maxDistance: options.maxDistance,
      name: 'water'
    })
    this.options = options
  }

  /** Meters across a waterway. */
  width(feature: WaterFeature): number {
    if (feature.width !== undefined && feature.width > 0) return feature.width
    const kind = feature.kind ?? ''
    return this.options.widths[kind] ?? WATERWAY_WIDTHS[kind] ?? DEFAULT_WIDTH
  }

  protected override createMaterial(
    part: string,
    kind: 'faces' | 'lines',
    look: Look
  ): Material {
    const material = super.createMaterial(part, kind, look)
    if (kind === 'faces' && part === 'water') {
      material.polygonOffset = true
      material.polygonOffsetFactor = WATER_OFFSET.factor
      material.polygonOffsetUnits = WATER_OFFSET.units
    }
    return material
  }

  /** Blue, unless the layer's look has a color. */
  protected override partColor(): ColorRepresentation {
    return this.ownLook.color ?? WATER_COLOR
  }

  protected override draw(
    ctx: TileContext<WaterFeature>,
    features: readonly WaterFeature[]
  ) {
    // the parts' materials have the color
    const color = WHITE
    const wanted = new Set(features)
    const local = (line: readonly Position[]): FlatRing => {
      const flat: FlatRing = []
      for (const position of line) flat.push(...ctx.toLocal(position))
      return flat
    }

    for (const source of ctx.sources) {
      const clip = source.rect
      for (const feature of source.features) {
        if (!wanted.has(feature)) continue
        const { geometry } = feature
        ctx.feature(feature, () => {
          if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
            const polygons: readonly (readonly Ring[])[] = isPolygon(geometry)
              ? [geometry.coordinates]
              : geometry.coordinates
            for (const polygon of polygons) {
              const rings = polygon.map(local)
              ctx.drapePolygon('water', rings, { color, clip })
              // the shores, closed
              for (const ring of rings) {
                ctx.drapePath('lines', [...ring, ring[0], ring[1]], {
                  color,
                  clip
                })
              }
            }
            return
          }
          const lines =
            geometry.type === 'LineString'
              ? [geometry.coordinates]
              : geometry.coordinates
          const width = this.width(feature) * ctx.unitsPerMeter
          for (const line of lines) {
            const flat = local(line)
            ctx.drapeLine('water', flat, width, { color, clip })
            ctx.drapePath('lines', flat, { color, clip })
          }
        })
      }
    }
  }
}

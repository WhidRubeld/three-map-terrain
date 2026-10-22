import 'ol/ol.css'

import { defaults as defaultControls } from 'ol/control/defaults'
import { never } from 'ol/events/condition'
import { equals, type Extent } from 'ol/extent'
import Feature from 'ol/Feature'
import type { Geometry } from 'ol/geom'
import MultiLineString from 'ol/geom/MultiLineString'
import Point from 'ol/geom/Point'
import Polygon, { fromExtent } from 'ol/geom/Polygon'
import { defaults as defaultInteractions } from 'ol/interaction/defaults'
import ExtentInteraction from 'ol/interaction/Extent'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import OlMap from 'ol/Map'
import { unByKey } from 'ol/Observable'
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj'
import OSM, { ATTRIBUTION } from 'ol/source/OSM'
import VectorSource from 'ol/source/Vector'
import { Circle, Fill, Stroke, Style } from 'ol/style'
import View from 'ol/View'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Utils } from 'three-map-terrain'

import { LAYERS, layersBelow, minZoom } from './layers'
import {
  type Area,
  areaOf,
  clamp,
  type Grid,
  gridOf,
  kilometers,
  onTiles,
  sameGrid,
  SIDES,
  ZOOMS
} from './view'

/** A place Photon found: its location and, for areas, their extent. */
interface Place {
  geometry: { coordinates: [lon: number, lat: number] }
  properties: {
    extent?: [west: number, north: number, east: number, south: number]
  }
}

/** The extent of tiles at `zoom` in Web Mercator meters: their outer edges. */
function extentOf({ minX, minY, maxX, maxY }: Grid, zoom: number) {
  return transformExtent(
    [
      Utils.tile2lon(minX, zoom),
      Utils.tile2lat(maxY + 1, zoom),
      Utils.tile2lon(maxX + 1, zoom),
      Utils.tile2lat(minY, zoom)
    ],
    'EPSG:4326',
    'EPSG:3857'
  )
}

/**
 * The tiles under the frame dragged to an extent: the edges on the
 * nearest tile lines, those dragged (off the lines) 1–5 tiles from those
 * that stay.
 */
function tilesUnder(extent: Extent, zoom: number): Grid {
  const [west, south, east, north] = transformExtent(
    extent,
    'EPSG:3857',
    'EPSG:4326'
  )
  const side = (from: number, to: number) => {
    const [first, last] = [Math.round(from), Math.round(to) - 1]
    return Math.abs(from - first) < 1e-6
      ? [first, clamp(last, first + SIDES.min - 1, first + SIDES.max - 1)]
      : [clamp(first, last - SIDES.max + 1, last - SIDES.min + 1), last]
  }
  const [minX, maxX] = side(
    Utils.long2tile(west, zoom),
    Utils.long2tile(east, zoom)
  )
  const [minY, maxY] = side(
    Utils.lat2tile(north, zoom),
    Utils.lat2tile(south, zoom)
  )
  return { minX, minY, maxX, maxY }
}

/** Seen from afar, the area is a dot: nothing dimmed, no edges to drag. */
const small = (marker: Feature, resolution: number) =>
  (marker.get('width') as number) / resolution < 24

/** The world in Web Mercator meters: dimmed around the area. */
const WORLD = fromExtent([-20037508.34, -20037508.34, 20037508.34, 20037508.34])
const ORANGE = '#e8590c'
const STYLES = {
  mask: new Style({ fill: new Fill({ color: 'rgb(16 16 16 / 0.35)' }) }),
  frame: [
    new Style({ stroke: new Stroke({ color: '#fff', width: 5 }) }),
    new Style({ stroke: new Stroke({ color: ORANGE, width: 2.5 }) })
  ],
  tiles: new Style({
    stroke: new Stroke({ color: ORANGE, width: 1, lineDash: [5, 5] })
  }),
  marker: new Style({
    image: new Circle({
      radius: 7,
      fill: new Fill({ color: ORANGE }),
      stroke: new Stroke({ color: '#fff', width: 2 })
    })
  }),
  handle: new Style({
    image: new Circle({
      radius: 6,
      fill: new Fill({ color: '#fff' }),
      stroke: new Stroke({ color: ORANGE, width: 2.5 })
    })
  })
}

/**
 * A map to pick an area on — OpenStreetMap, with OpenLayers: a click puts
 * the area there, wherever the map is; dragging the frame's edges and
 * corners reshapes it, a tile at a time. The frame is the grid `new Map()`
 * gets.
 */
export function Picker({
  area,
  onPick,
  onCancel
}: {
  area: Area
  onPick: (area: Area) => void
  onCancel: () => void
}) {
  const element = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLElement>(null)
  const map = useRef<OlMap>(null)
  const [features] = useState(() => ({
    mask: new Feature<Polygon>(),
    tiles: new Feature<MultiLineString>(),
    frame: new Feature<Polygon>(),
    marker: new Feature<Point>()
  }))
  // the frame's edges and corners, dragged
  const [resize] = useState(
    () =>
      new ExtentInteraction({
        // never a new box: the frame is the one
        createCondition: never,
        condition: ({ map }) =>
          !small(features.marker, map.getView().getResolution() ?? 0),
        boxStyle: [],
        pointerStyle: STYLES.handle,
        pixelTolerance: 12
      })
  )
  const [framed, setFramed] = useState(area)
  const [searching, setSearching] = useState(false)
  const [notFound, setNotFound] = useState(false)

  /** Brings the whole area into view, clear of the panel. */
  const fit = (next: Area, duration = 300) => {
    const view = map.current?.getView()
    const size = map.current?.getSize()
    const box = panel.current?.getBoundingClientRect()
    if (!view || !size || !box) return
    const [width, height] = size
    const margin = 0.15 * Math.min(width, height)
    // beside the panel on wide screens, below it on narrow ones
    const wide = width > 2 * box.width
    view.fit(extentOf(gridOf(next), next.zoom), {
      padding: [
        wide ? margin : box.bottom + margin,
        margin,
        margin,
        wide ? box.right + margin : margin
      ],
      duration
    })
  }

  // the map, made once; a click moves the area there
  useEffect(() => {
    if (!element.current) return
    const { mask, tiles, frame, marker } = features
    mask.setStyle((_, resolution) =>
      small(marker, resolution) ? undefined : STYLES.mask
    )
    marker.setStyle((_, resolution) =>
      small(marker, resolution) ? STYLES.marker : undefined
    )
    tiles.setStyle(STYLES.tiles)
    frame.setStyle(STYLES.frame)
    const created = new OlMap({
      target: element.current,
      layers: [
        new TileLayer({
          source: new OSM({
            attributions: [
              ATTRIBUTION,
              'Search by <a href="https://photon.komoot.io">Photon</a>'
            ]
          })
        }),
        new VectorLayer({
          source: new VectorSource<Feature<Geometry>>({
            features: [mask, tiles, frame, marker]
          }),
          updateWhileInteracting: true
        })
      ],
      view: new View({ enableRotation: false, maxZoom: 19 }),
      controls: defaultControls({ rotate: false }),
      interactions: defaultInteractions({
        altShiftDragRotate: false,
        pinchRotate: false
      })
    })
    created.on('click', ({ coordinate }) => {
      const [lon, lat] = toLonLat(coordinate)
      setFramed((current) => onTiles({ ...current, lat, lon }))
    })
    const resized = resize.on('extentchanged', ({ extent }) => {
      if (!extent) return
      const zoom = resize.get('zoom') as number
      const grid = tilesUnder(extent, zoom)
      const snapped = extentOf(grid, zoom)
      // the edges to drag stay on the frame, on tile lines
      if (!equals(extent, snapped)) {
        resize.setExtent(snapped)
        return
      }
      setFramed((current) =>
        current.zoom === zoom && sameGrid(gridOf(current), grid)
          ? current
          : areaOf(grid, zoom)
      )
    })
    created.addInteraction(resize)
    map.current = created
    fit(area, 0)
    return () => {
      unByKey(resized)
      created.removeInteraction(resize)
      created.setTarget(undefined)
      map.current = null
    }
    // made once, around the area it opens on
  }, [features, resize])

  // the frame, the tiles in it and the world around dimmed
  useEffect(() => {
    const grid = gridOf(framed)
    const { minX, minY, maxX, maxY } = grid
    const extent = extentOf(grid, framed.zoom)
    const [west, south, east, north] = extent
    const lines: number[][][] = []
    for (let x = minX + 1; x <= maxX; x++) {
      const [lon] = fromLonLat([Utils.tile2lon(x, framed.zoom), 0])
      lines.push([
        [lon, south],
        [lon, north]
      ])
    }
    for (let y = minY + 1; y <= maxY; y++) {
      const [, lat] = fromLonLat([0, Utils.tile2lat(y, framed.zoom)])
      lines.push([
        [west, lat],
        [east, lat]
      ])
    }
    const ring = fromExtent(extent)
    features.mask.setGeometry(
      new Polygon([WORLD.getCoordinates()[0], ring.getCoordinates()[0]])
    )
    features.frame.setGeometry(ring)
    features.tiles.setGeometry(new MultiLineString(lines))
    features.marker.setGeometry(new Point(fromLonLat([framed.lon, framed.lat])))
    features.marker.set('width', extent[2] - extent[0])
    // the edges to drag are the frame's
    resize.set('zoom', framed.zoom)
    resize.setExtent(extent)
  }, [features, resize, framed])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  /** The area at another zoom or size, around the same place, in view. */
  const reframe = (zoom: number, columns: number, rows: number) => {
    const next = onTiles({ ...framed, zoom, columns, rows })
    setFramed(next)
    fit(next)
  }

  // a place by name, from Photon (OpenStreetMap data): the area there, at
  // its zoom unless the place needs a wider one
  const search = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const query = new FormData(event.currentTarget).get('q')
    if (typeof query !== 'string' || query.trim() === '') return
    setSearching(true)
    setNotFound(false)
    try {
      const response = await fetch(
        `https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(query)}`
      )
      const {
        features: [found]
      } = (await response.json()) as { features: Place[] }
      if (found === undefined) {
        setNotFound(true)
        return
      }
      const [lon, lat] = found.geometry.coordinates
      // a town has an extent, a peak none
      const [west, north, east, south] = found.properties.extent ?? [
        lon,
        lat,
        lon,
        lat
      ]
      // the deepest zoom whose tiles still take in the place
      const across = Math.max(
        (east - west) / 360,
        Utils.lat2tile(south, 0) - Utils.lat2tile(north, 0)
      )
      const tiles = Math.min(framed.columns, framed.rows)
      const fits = Math.floor(Math.log2(tiles / across))
      const zoom = Math.max(ZOOMS.min, Math.min(framed.zoom, fits))
      const next = onTiles({ ...framed, lat, lon, zoom })
      setFramed(next)
      fit(next)
    } catch {
      setNotFound(true)
    } finally {
      setSearching(false)
    }
  }

  const missing = layersBelow(framed.zoom)

  return (
    <div className='picker'>
      <div className='picker-map' ref={element} />
      <aside className='panel' ref={panel}>
        <h1>Pick an area</h1>
        <p className='muted'>
          Click the map to put the area there, drag its edges to reshape it;
          zoom out to go far.
        </p>
        <form className='search' onSubmit={(event) => void search(event)}>
          <input
            name='q'
            type='search'
            placeholder='Search a place'
            aria-label='Search a place'
            onChange={() => setNotFound(false)}
          />
          <button type='submit' disabled={searching}>
            {searching ? '…' : 'Go'}
          </button>
        </form>
        {notFound && <p className='muted'>Nothing found.</p>}
        <div className='row'>
          <span className='label'>Zoom</span>
          <div className='controls'>
            <button
              type='button'
              aria-label='Zoom out'
              disabled={framed.zoom <= ZOOMS.min}
              onClick={() =>
                reframe(framed.zoom - 1, framed.columns, framed.rows)
              }
            >
              −
            </button>
            <span className='value'>{framed.zoom}</span>
            <button
              type='button'
              aria-label='Zoom in'
              disabled={framed.zoom >= ZOOMS.max}
              onClick={() =>
                reframe(framed.zoom + 1, framed.columns, framed.rows)
              }
            >
              +
            </button>
          </div>
        </div>
        <div className='row'>
          <span className='label'>Tiles</span>
          <div className='choice' role='group' aria-label='Tiles'>
            {[3, 5].map((n) => (
              <button
                key={n}
                type='button'
                aria-pressed={n === framed.columns && n === framed.rows}
                onClick={() => reframe(framed.zoom, n, n)}
              >
                {n} × {n}
              </button>
            ))}
          </div>
        </div>
        <p className='status'>
          {framed.lat.toFixed(5)}, {framed.lon.toFixed(5)} · {framed.columns} ×{' '}
          {framed.rows} tiles · {kilometers(framed)} km
        </p>
        {missing.length > 0 && (
          <p className='muted'>
            Not at this zoom:{' '}
            {missing
              .map((name) => `${name} from ${minZoom(LAYERS[name])}`)
              .join(', ')}
            .
          </p>
        )}
        <div className='actions'>
          <button
            type='button'
            className='primary'
            onClick={() => onPick(framed)}
          >
            Build this area
          </button>
          <button type='button' onClick={onCancel}>
            Cancel
          </button>
        </div>
      </aside>
    </div>
  )
}

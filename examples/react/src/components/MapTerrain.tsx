/* eslint-disable react-hooks/exhaustive-deps */
import React, {
  useState,
  useEffect,
  forwardRef,
  useImperativeHandle
} from 'react'

import { MapProps, Map, Source, MapSupportedApi } from 'three-geo-terrain'

export type MapTerrainProps = Omit<MapProps, 'source'> & {
  source: { api: MapSupportedApi; token: string }
  onReady?: () => void
}

export const MapTerrain = forwardRef<Map | undefined, MapTerrainProps>(
  ({ source, location, material, options, onReady }, ref) => {
    const [ready, setReady] = useState(false)
    const [map, setMap] = useState<Map>()

    useImperativeHandle(ref, () => map)

    useEffect(() => {
      setMap(
        new Map({
          source: new Source(source.api, source.token),
          location: location,
          material: material,
          options: options
        })
      )
    }, [])

    useEffect(() => {
      if (!ready && map) {
        setReady(true)
        map.init(onReady)
      }
    }, [map, ready])

    return (
      // @ts-ignore
      <primitive object={map ? map.terrain : () => {}} position={[0, 0, 0]} />
    )
  }
)

import { useSelector } from '@tanstack/react-store'
import { shallow } from '@tanstack/react-store'

import { elevationParts, formatLat, formatLon, joinParts } from '../lib/format'
import { settingsStore } from '../state/settings'
import { hoverStore, terrainStore, viewerStore } from '../state/viewer'
import { REPOSITORY } from './TopBar'

export function StatusBar() {
  const cursor = useSelector(hoverStore, (s) => s.cursor)
  const terrain = useSelector(
    terrainStore,
    (s) => ({
      fit: s.fit,
      loaded: s.loaded,
      textured: s.textured,
      total: s.total
    }),
    { compare: shallow }
  )
  const exaggeration = useSelector(settingsStore, (s) => s.exaggeration)
  const preset = useSelector(viewerStore, (s) => s.source?.kind === 'preset')

  return (
    <footer className='panel pointer-events-auto flex h-7 items-center gap-4 overflow-hidden px-2.5 text-3xs font-semibold uppercase tracking-[0.12em] tabular-nums'>
      <span
        className='flex min-w-0 flex-none gap-3 sm:w-[19rem]'
        aria-live='off'
      >
        <span className='text-muted'>Cursor</span>
        {cursor ? (
          <>
            <span>{formatLat(cursor.lat)}</span>
            <span>{formatLon(cursor.lon)}</span>
            <span>{joinParts(elevationParts(cursor.alt))}</span>
          </>
        ) : (
          <span className='text-muted'>— off terrain —</span>
        )}
      </span>
      {terrain.fit && (
        <span className='hidden flex-none gap-3 md:flex'>
          <span>Z{terrain.fit.zoom}</span>
          <span>
            {terrain.fit.nTiles}×{terrain.fit.nTiles}
          </span>
          <span>
            Dem {terrain.loaded}/{terrain.total}
          </span>
          <span>
            Img {terrain.textured}/{terrain.total}
          </span>
          <span>Z×{exaggeration.toFixed(2)}</span>
        </span>
      )}

      <span className='min-w-0 flex-1 truncate text-muted'>
        Imagery{' '}
        <a
          className='hover:text-fg'
          href='https://s2maps.eu'
          target='_blank'
          rel='noreferrer'
        >
          Sentinel-2 cloudless by EOX
        </a>{' '}
        (Copernicus Sentinel data 2016) · Elevation{' '}
        <a
          className='hover:text-fg'
          href='https://registry.opendata.aws/terrain-tiles/'
          target='_blank'
          rel='noreferrer'
        >
          AWS Terrain Tiles
        </a>
        {preset && (
          <>
            {' '}
            · Routes ©{' '}
            <a
              className='hover:text-fg'
              href='https://www.openstreetmap.org/copyright'
              target='_blank'
              rel='noreferrer'
            >
              OpenStreetMap
            </a>{' '}
            contributors
          </>
        )}
      </span>
      <a
        className='hidden flex-none hover:underline sm:inline'
        href={REPOSITORY}
        target='_blank'
        rel='noreferrer'
      >
        Built with three-map-terrain ↗
      </a>
    </footer>
  )
}

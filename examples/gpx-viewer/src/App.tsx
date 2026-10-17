import { useSelector } from '@tanstack/react-store'
import { useEffect } from 'react'

import { handleHotkey } from './hotkeys'
import { Scene } from './scene/Scene'
import { settingsStore } from './state/settings'
import {
  COMPACT_QUERY,
  isPresetId,
  loadPreset,
  uiStore,
  type UiState
} from './state/viewer'
import { CompactLayout } from './ui/CompactLayout'
import { HelpDialog } from './ui/HelpDialog'
import { LegendPanel } from './ui/LegendPanel'
import { DropZone, ErrorToast, Hint, LoadingHud } from './ui/Overlays'
import { PerfPanel } from './ui/PerfPanel'
import { ProfilePanel } from './ui/ProfilePanel'
import { StatusBar } from './ui/StatusBar'
import { TopBar } from './ui/TopBar'
import { TrackPanel } from './ui/TrackPanel'
import { ViewPanel } from './ui/ViewPanel'

/** `data-theme` on <html> drives the CSS tokens; the scene reads `uiStore.theme`. */
function useTheme() {
  const setting = useSelector(settingsStore, (s) => s.theme)
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const theme =
        setting === 'system' ? (media.matches ? 'dark' : 'light') : setting
      document.documentElement.dataset.theme = theme
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', theme === 'dark' ? '#0a0a0a' : '#f2f2f2')
      uiStore.setState((s) => (s.theme === theme ? s : { ...s, theme }))
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [setting])
}

/**
 * Measures how much of the canvas the panels cover, so that the camera can
 * frame the route in the free area (see `CameraRig`). Elements marked with
 * `data-inset` count; side panels only while they are open.
 */
function useInsets(layout: UiState['layout']) {
  useEffect(() => {
    const measure = () => {
      const insets = { top: 0, right: 0, bottom: 0, left: 0 }
      const { innerWidth: width, innerHeight: height } = window
      for (const element of document.querySelectorAll<HTMLElement>(
        '[data-inset]'
      )) {
        const rect = element.getBoundingClientRect()
        if (!rect.width || !rect.height) continue
        const side = element.dataset.inset
        if (side === 'top') insets.top = Math.max(insets.top, rect.bottom)
        if (side === 'bottom')
          insets.bottom = Math.max(insets.bottom, height - rect.top)
        if (side === 'left' && rect.height > 160)
          insets.left = Math.max(insets.left, rect.right)
        if (side === 'right' && rect.height > 160)
          insets.right = Math.max(insets.right, width - rect.left)
      }
      // always leave at least a third of the canvas to frame the route in
      const squeeze = (a: number, b: number, size: number) => {
        const k = Math.min(1, (size * 0.67) / Math.max(1, a + b))
        return [a * k, b * k] as const
      }
      ;[insets.left, insets.right] = squeeze(insets.left, insets.right, width)
      ;[insets.top, insets.bottom] = squeeze(insets.top, insets.bottom, height)
      uiStore.setState((s) => {
        const same = (Object.keys(insets) as (keyof typeof insets)[]).every(
          (key) => Math.abs(s.insets[key] - insets[key]) < 1
        )
        return same ? s : { ...s, insets }
      })
    }
    // each layout renders its own marked containers: observe them anew
    const observer = new ResizeObserver(measure)
    for (const element of document.querySelectorAll('[data-inset]'))
      observer.observe(element)
    window.addEventListener('resize', measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [layout])
}

function useLayout() {
  const layout = useSelector(uiStore, (s) => s.layout)
  useEffect(() => {
    const media = matchMedia(COMPACT_QUERY)
    const apply = () => {
      const next = media.matches ? 'compact' : 'regular'
      uiStore.setState((s) =>
        s.layout === next ? s : { ...s, layout: next, sheet: null }
      )
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])
  return layout
}

function useMotion() {
  const animations = useSelector(settingsStore, (s) => s.animations)
  useEffect(() => {
    document.documentElement.dataset.motion = animations ? 'on' : 'off'
  }, [animations])
}

export function App() {
  useTheme()
  useMotion()
  const layout = useLayout()
  useInsets(layout)

  useEffect(() => {
    window.addEventListener('keydown', handleHotkey)
    return () => window.removeEventListener('keydown', handleHotkey)
  }, [])

  // a demo track right away, or the one named in ?track=
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('track')
    void loadPreset(isPresetId(requested) ? requested : 'eiger-trail')
  }, [])

  return (
    <>
      <Scene />
      {layout === 'compact' ? <CompactLayout /> : <RegularLayout />}
      <LoadingHud />
      <ErrorToast />
      <DropZone />
      <HelpDialog />
    </>
  )
}

/** Tablets and desktops: track details left, view settings right, profile below. */
function RegularLayout() {
  return (
    <div className='pointer-events-none fixed inset-0 z-10 flex flex-col gap-3 p-3'>
      <div data-inset='top'>
        <TopBar />
      </div>
      <div className='flex min-h-0 flex-1 items-start justify-between gap-3'>
        <div
          data-inset='left'
          className='flex max-h-full min-h-0 w-[clamp(15rem,24vw,19rem)] flex-col gap-3'
        >
          <TrackPanel />
        </div>
        <div
          data-inset='right'
          className='pointer-events-auto flex max-h-full min-h-0 w-[clamp(14rem,20vw,17rem)] flex-col gap-3 overflow-y-auto'
        >
          <ViewPanel className='flex-none' />
          <LegendPanel className='flex-none' />
          <PerfPanel className='flex-none' />
        </div>
      </div>
      <div data-inset='bottom' className='flex flex-col gap-3'>
        <div className='flex justify-center empty:hidden'>
          <Hint />
        </div>
        <ProfilePanel className='flex-none' />
        <StatusBar />
      </div>
    </div>
  )
}

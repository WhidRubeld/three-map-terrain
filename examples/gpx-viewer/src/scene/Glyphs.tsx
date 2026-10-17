import { Html } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useSelector } from '@tanstack/react-store'
import { type ReactNode, type Ref, useEffect, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  type Points,
  PointsMaterial
} from 'three'

import { uiStore } from '../state/viewer'
import { type GlyphName, glyphSize, glyphTexture, PALETTE } from './look'

function useGlyphMaterial(name: GlyphName) {
  const theme = useSelector(uiStore, (s) => s.theme)
  const dpr = useThree((s) => s.viewport.dpr)
  const material = useMemo(() => {
    const palette = PALETTE[theme]
    return new PointsMaterial({
      map: glyphTexture(name, palette.fg, palette.halo),
      size: glyphSize(name, dpr),
      sizeAttenuation: false,
      transparent: true,
      alphaTest: 0.5,
      depthTest: false,
      depthWrite: false
    })
  }, [name, theme, dpr])
  useEffect(
    () => () => {
      material.map?.dispose()
      material.dispose()
    },
    [material]
  )
  return material
}

/** Screen-space pixel glyphs (`gl.POINTS`), always drawn on top. */
export function Glyphs({
  name,
  positions,
  ref
}: {
  name: GlyphName
  positions: Float32Array
  ref?: Ref<Points>
}) {
  const material = useGlyphMaterial(name)
  const geometry = useMemo(() => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(positions, 3))
    return geometry
  }, [positions])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <points
      ref={ref}
      geometry={geometry}
      material={material}
      renderOrder={30}
      frustumCulled={false}
      raycast={() => undefined}
    />
  )
}

/**
 * A DOM label anchored above a scene point. `visible` is polled every frame,
 * so labels can follow the intro without re-rendering. Labels let the pointer
 * through to the canvas, except the buttons of `interactive` ones.
 */
export function Label({
  position,
  visible,
  interactive = false,
  placement = 'above',
  children
}: {
  position: readonly [number, number, number]
  visible?: () => boolean
  interactive?: boolean
  /** `below` for points near the top of the canvas */
  placement?: 'above' | 'below'
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useFrame(() => {
    const element = ref.current
    if (!element || !visible) return
    const show = visible()
    if (element.dataset.visible !== String(show))
      element.dataset.visible = String(show)
  })
  return (
    <Html
      position={position as [number, number, number]}
      zIndexRange={[40, 0]}
      wrapperClass='scene-anchor'
    >
      <div
        ref={ref}
        className='scene-label'
        data-visible='true'
        data-interactive={interactive}
        data-placement={placement}
      >
        {children}
      </div>
    </Html>
  )
}

import '@fontsource-variable/jetbrains-mono'
import '@fontsource-variable/doto/full.css'
import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('#root element not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)

// for the console and browser tests: `__viewer.terrainStore.state` etc.
if (import.meta.env.DEV) {
  void Promise.all([
    import('./state/viewer'),
    import('./state/settings'),
    import('./scene/refs')
  ]).then(([viewer, settings, refs]) => {
    Object.assign(window, { __viewer: { ...viewer, ...settings, ...refs } })
  })
}

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import library from '../../package.json' with { type: 'json' }

export default defineConfig({
  // relative asset URLs: served from https://<user>.github.io/three-map-terrain/
  base: './',
  plugins: [react(), tailwindcss()],
  define: {
    __LIBRARY_VERSION__: JSON.stringify(library.version)
  },
  resolve: {
    // `three-map-terrain` is linked from the repo root: make it use this
    // example's copy of three instead of bundling a second one
    dedupe: ['three']
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1600
  }
})

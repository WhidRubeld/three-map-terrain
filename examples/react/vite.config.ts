import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // `three-map-terrain` is linked from the repo root: make it use this
    // example's copy of three instead of bundling a second one
    dedupe: ['three']
  }
})

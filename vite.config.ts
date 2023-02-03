import path from 'path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

import pkg from './package.json'

export default defineConfig({
  build: {
    minify: true,
    sourcemap: true,
    target: 'esnext',
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      formats: ['es', 'cjs'],
      fileName: '[name]'
    },
    rollupOptions: {
      external: Object.keys(pkg.peerDependencies || {}),
      output: {
        sourcemapExcludeSources: true
      }
    }
  },
  plugins: [dts(), nodePolyfills()]
})

import path from 'path'
import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import dts from 'vite-plugin-dts'

export default defineConfig({
  build: {
    minify: false,
    sourcemap: true,
    target: 'esnext',
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      formats: ['es', 'cjs'],

      fileName: '[name]'
    },
    rollupOptions: {
      external: (id) => !id.startsWith('.') && !path.isAbsolute(id),
      output: {
        preserveModules: true,
        sourcemapExcludeSources: true
      }
    }
  },
  plugins: [
    dts(),
    nodePolyfills({
      // Whether to polyfill `node:` protocol imports.
      protocolImports: true
    })
  ]
})

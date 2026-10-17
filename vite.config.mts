import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// Library build. Type declarations are emitted separately by `tsc -p tsconfig.build.json`.
export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: fileURLToPath(new URL('src/index.ts', import.meta.url)),
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.mjs' : 'index.js')
    },
    rolldownOptions: {
      // `three` and its subpaths are peer dependencies and must never be bundled
      external: [/^three(\/.*)?$/]
    }
  }
})

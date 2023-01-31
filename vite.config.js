import path from 'path'
import { defineConfig } from 'vite'

const config = {
  build: {
    build: {
      minify: false,
      sourcemap: true,
      target: 'esnext',
      lib: {
        formats: ['es', 'cjs'],
        entry: 'src/index.ts',
        fileName: '[name]'
      },
      rollupOptions: {
        external: (id) => !id.startsWith('.') && !path.isAbsolute(id),
        output: {
          preserveModules: true,
          sourcemapExcludeSources: true
        }
      }
    }
  }
}

export default defineConfig(({ command }) => config[command])

import { defineConfig, devices } from '@playwright/test'

const port = 5174

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    viewport: { width: 800, height: 600 }
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 800, height: 600 },
        launchOptions: {
          // software WebGL/WebGPU so the tests also run on GPU-less CI runners
          args: ['--enable-unsafe-swiftshader', '--enable-unsafe-webgpu']
        }
      }
    }
  ],
  webServer: {
    command: `yarn vite playground --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI
  }
})

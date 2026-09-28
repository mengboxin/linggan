import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { defineConfig as defineVitestConfig } from 'vitest/config'

export default defineVitestConfig(({ mode }) => {
  const apiBase = process.env.VITE_API_BASE || 'http://localhost:8000'

  return {
    base: './',
    plugins: [react()],
    resolve: {
      alias: {
        '@': '/src',
      },
    },
    server: {
      port: Number(process.env.VITE_PORT) || 5173,
      proxy: {
        '/api': {
          target: apiBase,
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      include: [
        '**/*.{test,spec}.?(c|m)[jt]s?(x)',
        '**/tests/properties/**/*.property.?(c|m)[jt]s?(x)',
      ],
    },
  }
})

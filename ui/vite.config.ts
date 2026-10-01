/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Safari still needs -webkit-backdrop-filter; naming it as a target makes the CSS
  // minifier emit the prefix instead of dropping the standard property (e1 panels blur).
  build: { cssTarget: ['chrome120', 'safari16', 'firefox120'] },
  // `vite dev` against a running daemon: LOOMWATCH_DAEMON=http://127.0.0.1:3100 pnpm dev
  server: {
    proxy: {
      '/api': { target: process.env.LOOMWATCH_DAEMON ?? 'http://127.0.0.1:3000', ws: true, changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
})

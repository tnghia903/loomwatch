/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Safari still needs -webkit-backdrop-filter; naming it as a target makes the CSS
  // minifier emit the prefix instead of dropping the standard property (e1 panels blur).
  build: {
    cssTarget: ['chrome120', 'safari16', 'firefox120'],
    rolldownOptions: {
      output: {
        // Libraries change far less often than the app: give the big ones their own long-lived,
        // content-hashed chunks so an app update does not make the browser re-download them.
        // Lazily imported libraries (the Markdown stack, ajv) are left to their own split points.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 30 },
            { name: 'flow', test: /node_modules[\\/](@xyflow|d3-[a-z-]+|zustand|classcat)[\\/]/, priority: 20 },
            { name: 'yaml', test: /node_modules[\\/]yaml[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
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

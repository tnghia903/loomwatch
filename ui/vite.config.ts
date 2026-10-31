/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

/**
 * PDF.js's own data, served with the app at `/pdfjs/` so a PDF an agent made draws with no network
 * (ADR 0091; `lib/files/pdf.ts`): the fonts a PDF names but doesn't hold, the character maps some
 * Chinese, Japanese and Korean text needs, the decoders for scanned pictures (JPEG 2000, JBIG2,
 * fax) and a colour profile, each with its licence. PDF scripting (`quickjs`) is left out, as the
 * reader runs none, and so are the decoders' slower copies for browsers without WebAssembly.
 */
function pdfjsData(): Plugin {
  const root = fileURLToPath(new URL('./node_modules/pdfjs-dist/', import.meta.url))
  const folders = ['cmaps', 'standard_fonts', 'wasm', 'iccs']
  const kept = (name: string) => !/quickjs|_nowasm_fallback/.test(name)
  return {
    name: 'pdfjs-data',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const [folder, name] = (request.url ?? '').split('?')[0].split('/').filter(Boolean)
        const file = folder && name && folders.includes(folder) && kept(name) ? join(root, folder, name) : ''
        if (!file || !existsSync(file) || !statSync(file).isFile()) return next()
        response.end(readFileSync(file))
      })
    },
    generateBundle() {
      for (const folder of folders) {
        for (const name of readdirSync(join(root, folder)).filter(kept)) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${folder}/${name}`, source: readFileSync(join(root, folder, name)) })
        }
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), pdfjsData()],
  // Safari 16 still needs -webkit-backdrop-filter; naming it as a target makes the CSS minifier
  // keep the prefix beside the standard property. Lightning CSS drops the standard property when
  // the -webkit- one follows it, so the sheets write the prefix first (src/styles/glass-blur.test.ts).
  build: {
    cssTarget: ['chrome120', 'safari16', 'firefox120'],
    // The app's own chunk is ~615 kB (189 kB gzipped), so Vite's 500 kB default warned on every
    // install; just above it, the warning means the bundle really grew.
    chunkSizeWarningLimit: 650,
    rolldownOptions: {
      // The app, and the island the Mac app shows at the notch (ADR 0083).
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        island: fileURLToPath(new URL('./island.html', import.meta.url)),
      },
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
    // Node would take the deck reader's UMD build, as its package names no exports: tests use the
    // module the app is built from.
    alias: { pptxtojson: fileURLToPath(new URL('./node_modules/pptxtojson/dist/index.js', import.meta.url)) },
  },
})

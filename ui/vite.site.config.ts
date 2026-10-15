import { defineConfig } from 'vite'

// The landing page's live figures (src/site/landingLive.ts) as one ES module, three.js included.
// site/build.sh runs this with LANDING_LIVE_OUT set to the page's assets/live folder.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: process.env.LANDING_LIVE_OUT ?? 'dist-site',
    emptyOutDir: true,
    copyPublicDir: false,
    reportCompressedSize: false,
    minify: true,
    chunkSizeWarningLimit: 900,
    lib: { entry: 'src/site/landingLive.ts', formats: ['es'], fileName: () => 'live.js' },
  },
})

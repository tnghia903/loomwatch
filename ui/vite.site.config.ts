import { defineConfig } from 'vite'

// The landing page's live figures (src/site/landingLive.ts) as an ES module, three.js included,
// and the bench's code as a second one that live.js loads when the page asks for it.
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
    rolldownOptions: {
      // The bench's module takes three.js and the rest it shares with the crew from live.js, which
      // exports them for it. Held to its own exports, live.js would leave them in a third module,
      // and the crew would wait for live.js to ask for it.
      preserveEntrySignatures: 'allow-extension',
      // Minified all the way: an ES library build keeps its whitespace and /* @__PURE__ */ notes for
      // a bundler downstream to tree-shake with, and nothing bundles the page's modules again.
      // The same code either way, 16 KB less to download gzipped.
      output: { minify: true, comments: false },
    },
  },
})

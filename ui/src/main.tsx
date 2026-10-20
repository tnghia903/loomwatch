import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AgentFigure } from './components/agents/benchFigure'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { MarkdownRenderer } from './components/ui/markdownCode'

// The two pieces of code that come as their own downloads are asked for now, beside the first
// draw, so neither holds its part of the page back later: the bench on the agent pages, and
// Markdown, which answers, files and Ask all show with.
if (window.location.pathname.startsWith('/agents')) AgentFigure.preload().catch(() => {})
MarkdownRenderer.preload().catch(() => {})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // Installation is optional; the web UI remains usable if workers are unavailable.
    })
  })
}

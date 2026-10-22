// The island at the notch (ADR 0083): the page the Mac app shows in its see-through panel over the
// notch, served by `loomwatchd` beside the app itself.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { Island } from './Island'
import './index.css'

createRoot(document.getElementById('island')!).render(
  <StrictMode>
    <Island />
  </StrictMode>,
)

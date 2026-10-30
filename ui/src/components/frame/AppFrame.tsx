import type { ReactNode } from 'react'

import { Dock } from './Dock'

/**
 * The one frame every screen sits in (round 3): the dock down the side, the screen beside it. A
 * screen's own root fills the space beside the dock, so pages laid out to fill the window keep
 * working unchanged.
 */
export function AppFrame({ children }: { children: ReactNode }) {
  return (
    <div className="lw-app">
      <Dock />
      <div className="lw-app-main">{children}</div>
    </div>
  )
}

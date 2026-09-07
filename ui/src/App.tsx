import { ReactFlowProvider } from '@xyflow/react'
import { useEffect, useState } from 'react'

import { Canvas } from './components/Canvas'
import { Library } from './components/library'
import { type DetectedHarness, fetchHarnesses } from './lib/harnesses'

function App() {
  const [harnesses, setHarnesses] = useState<DetectedHarness[]>([])
  const [harnessesLoading, setHarnessesLoading] = useState(true)
  const [harnessesError, setHarnessesError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchHarnesses()
      .then((detected) => {
        if (!cancelled) {
          setHarnesses(detected)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHarnessesError(error instanceof Error ? error.message : String(error))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHarnessesLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="relative h-screen w-screen bg-canvas">
      <ReactFlowProvider>
        <div className="pointer-events-none absolute inset-4 z-10">
          <Library harnesses={harnesses} harnessesLoading={harnessesLoading} harnessesError={harnessesError} />
        </div>
        <Canvas />
      </ReactFlowProvider>
    </div>
  )
}

export default App

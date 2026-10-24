// The box's agent at its workbench (ADR 0083, decision 11): the builder's bench, to look at, at rest
// or acting out its newest run in its own chat. Its own download, with three.js, fetched the first
// time a bench opens (Island.tsx), so the box itself opens at once.
import { Suspense, useState } from 'react'

import { AgentFigure } from '../components/agents/benchFigure'
import { useSavedBench } from '../components/agents/benchOf'
import { FigureStill } from '../components/agents/FigureStill'
import type { SavedJob } from '../lib/library/jobs'
import { figureFor } from '../lib/library/figures'
import type { RunRecord } from '../lib/runs/client'
import type { Island } from './useIsland'

const NOTHING = () => {}

export default function BenchCard({ island }: { island: Island }) {
  const box = island.box
  const [failed, setFailed] = useState(false)
  if (!box) return null
  // Its figure stands in while the bench comes, and where it can't be drawn: there is nothing the
  // person could do about that, so nothing is said.
  const still = <FigureStill figure={figureFor(box.id, box.job.figure)} alt="" />
  return (
    <div className="island-bench" role="group" aria-label={`${box.name}’s workbench`}>
      {failed ? (
        <div className="island-bench-still">
          <span className="island-bench-figure">{still}</span>
        </div>
      ) : (
        <Suspense fallback={<div className="island-bench-still"><span className="island-bench-figure">{still}</span></div>}>
          <Bench key={box.id} job={box.job} record={island.boxRecord} onFail={() => setFailed(true)} />
        </Suspense>
      )}
    </div>
  )
}

function Bench({ job, record, onFail }: { job: SavedJob; record: RunRecord | null; onFail: () => void }) {
  const { view, labels } = useSavedBench(job, record)
  return <AgentFigure view={view} labels={labels} open={null} onPart={NOTHING} onKey={NOTHING} onSkillDrop={NOTHING} skillMime="" onFail={onFail} readOnly tone="dark" />
}

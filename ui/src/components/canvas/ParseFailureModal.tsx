import type { LoadFailure } from '../../lib/team-file/useTeamDocument'

export function ParseFailureModal({ failure }: { failure: LoadFailure }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-ink/15 p-4">
      <div role="alertdialog" aria-modal="true" aria-label="Team file could not be parsed" className="w-full max-w-lg rounded-xl border border-red/30 bg-surface-solid p-5 shadow-[0_24px_80px_rgb(0_0_0/.25)]">
        <h1 className="text-[18px] font-semibold text-ink">This team file could not be opened</h1>
        <p className="mt-2 text-[13px] text-ink-2">{failure.message}</p>
        {failure.line && <code className="mt-3 block rounded-md bg-canvas p-3 font-mono text-[12px] text-red">{failure.line}</code>}
        <button type="button" onClick={() => { window.history.replaceState({}, '', '/'); window.location.reload() }} className="mt-4 rounded-full bg-iris px-4 py-2 text-[13px] font-medium text-white">Open another team…</button>
      </div>
    </div>
  )
}

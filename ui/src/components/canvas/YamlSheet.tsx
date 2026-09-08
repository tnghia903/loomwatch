export function YamlSheet({ title, yaml, onClose }: { title: string; yaml: string; onClose: () => void }) {
  return (
    <aside role="dialog" aria-label={title} className="absolute inset-y-4 right-4 z-50 flex w-[min(480px,calc(100vw-32px))] flex-col rounded-xl border border-hairline/10 bg-surface-solid shadow-[0_24px_80px_rgb(0_0_0/.2)]">
      <header className="flex h-12 items-center border-b border-hairline/10 px-4">
        <h2 className="flex-1 text-[14px] font-semibold text-ink">{title}</h2>
        <button type="button" onClick={onClose} aria-label="Close YAML" className="rounded-md px-2 py-1 text-ink-3 hover:bg-hairline/10">×</button>
      </header>
      <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-[12px] leading-5 text-ink-2"><code>{yaml}</code></pre>
    </aside>
  )
}

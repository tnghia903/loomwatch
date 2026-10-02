import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import type { AskApp } from '../../lib/ask/client'
import type { AskModel } from '../../lib/ask/useAsk'
import { fetchHarnessModels, type HarnessModels } from '../../lib/harnesses'

type Catalog = { state: 'loading' } | { state: 'ready'; models: HarnessModels } | { state: 'failed' }

/** Each app's models, read once per page: finding them starts the app, which takes seconds. Only a
    list that was actually read is kept, so a cold start that timed out is tried again next time. */
const catalogs = new Map<string, HarnessModels>()

function useModels(appId: string | null, enabled: boolean): Catalog | null {
  const [read, setRead] = useState<{ appId: string; catalog: Catalog } | null>(null)
  useEffect(() => {
    if (!enabled || !appId || catalogs.has(appId)) return
    let cancelled = false
    fetchHarnessModels(appId).then(
      (models) => {
        catalogs.set(appId, models)
        if (!cancelled) setRead({ appId, catalog: { state: 'ready', models } })
      },
      () => { if (!cancelled) setRead({ appId, catalog: { state: 'failed' } }) },
    )
    return () => { cancelled = true }
  }, [appId, enabled])
  if (!appId) return null
  const known = catalogs.get(appId)
  if (known) return { state: 'ready', models: known }
  return read?.appId === appId ? read.catalog : { state: 'loading' }
}

interface AskAppPickerProps {
  apps: AskApp[]
  /** The app and model shown as in use: the live conversation's, else the next one's. */
  app: AskApp
  model: AskModel | null
  /** A conversation is under way, so a change starts a new one. */
  inConversation: boolean
  disabled?: boolean
  onChoose: (app: string, model: AskModel | null) => void
}

/**
 * "Using Claude on this computer", where Claude is a button: the person picks which of their AI
 * apps Ask talks to, and optionally which of its models. Choosing an app keeps the list open on its
 * models; choosing a model closes it.
 */
export function AskAppPicker({ apps, app, model, inConversation, disabled = false, onChoose }: AskAppPickerProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const appsHeading = useId()
  const modelsHeading = useId()
  const catalog = useModels(app.id, open)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const close = () => { setOpen(false); toggle.current?.focus() }
  const currentId = catalog?.state === 'ready' ? catalog.models.currentModelId : undefined
  const listed = catalog?.state === 'ready' ? catalog.models.models : []
  const defaultModel = currentId ? listed.find((item) => item.id === currentId)?.name ?? currentId : null
  // The app's current model is what "Its default" already means, so it is listed once, unless it
  // is the one chosen.
  const models = listed.filter((item) => item.id !== currentId || item.id === model?.id)
  const label = model ? `${app.name} · ${model.name}` : app.name

  return (
    <div
      ref={root}
      className="ask-app"
      onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); close() } }}
    >
      <button
        ref={toggle}
        type="button"
        className="ask-app-toggle"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`AI app: ${label}. Change`}
        title="Choose the AI app and model Ask uses"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ask-app-name">{label}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div role="dialog" aria-label="Choose the AI app Ask uses" className="pop e2 ask-app-pop">
          <h3 id={appsHeading} className="ask-app-pop-label t-micro">AI app</h3>
          <div role="group" aria-labelledby={appsHeading} className="ask-app-pop-list">
            {apps.map((item) => {
              const chosen = item.id === app.id
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`pop-row ${chosen ? 'current' : ''}`}
                  aria-pressed={chosen}
                  disabled={!item.available}
                  title={item.available ? undefined : item.reason ?? undefined}
                  autoFocus={chosen}
                  onClick={() => { if (!chosen) onChoose(item.id, null) }}
                >
                  <span className="name t-body">{item.name}</span>
                  {!item.available && <span className="aside t-meta">Can’t run here</span>}
                  {chosen && <Check className="ask-app-check" size={14} aria-hidden="true" />}
                </button>
              )
            })}
          </div>
          <div className="pop-sep" />
          <h3 id={modelsHeading} className="ask-app-pop-label t-micro">Model</h3>
          <div role="group" aria-labelledby={modelsHeading} className="ask-app-pop-list">
            <button
              type="button"
              className={`pop-row ${model ? '' : 'current'}`}
              aria-pressed={!model}
              onClick={() => { if (model) onChoose(app.id, null); close() }}
            >
              <span className="name t-body">Its default</span>
              {defaultModel && <span className="aside t-meta">{defaultModel}</span>}
              {!model && <Check className="ask-app-check" size={14} aria-hidden="true" />}
            </button>
            {catalog?.state === 'loading' && (
              <p className="pop-empty t-meta ask-app-finding" role="status">
                <Loader2 className="ask-step-spin" size={13} aria-hidden="true" />
                Finding {app.name}’s models…
              </p>
            )}
            {catalog?.state === 'failed' && <p className="pop-empty t-meta">{app.name} will use its own default. LoomWatch couldn’t list its other models.</p>}
            {models.map((item) => {
              const chosen = model?.id === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`pop-row ${chosen ? 'current' : ''}`}
                  aria-pressed={chosen}
                  title={item.description}
                  onClick={() => { if (!chosen) onChoose(app.id, { id: item.id, name: item.name }); close() }}
                >
                  <span className="name t-body">{item.name}</span>
                  {chosen && <Check className="ask-app-check" size={14} aria-hidden="true" />}
                </button>
              )
            })}
          </div>
          {inConversation && (
            <>
              <div className="pop-sep" />
              <p className="pop-note t-meta ask-app-note">Changing the app or model starts a new conversation.</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

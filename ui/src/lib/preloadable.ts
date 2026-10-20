import { createElement, lazy, useState, type ComponentType } from 'react'

/**
 * A component whose code loads when it is first shown, as with React's `lazy`, that can also be
 * fetched ahead (`preload`) and then shows at once. `lazy` alone suspends the first time it shows
 * even when its code is in, and React keeps the fallback up for 300 ms before it shows the content.
 */
export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | null = null
  let pending: Promise<ComponentType<P>> | null = null
  const preload = () => {
    pending ??= load().then(
      (component) => (loaded = component),
      (failed: unknown) => { pending = null; throw failed },
    )
    return pending
  }
  const Lazy = lazy(() => preload().then((component) => ({ default: component })))
  function Preloaded(props: P) {
    // Picked once where it shows, so code arriving later never swaps what is mounted.
    const [component] = useState<ComponentType<P>>(() => loaded ?? Lazy)
    return createElement(component, props)
  }
  return Object.assign(Preloaded, { preload })
}

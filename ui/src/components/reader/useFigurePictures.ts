import { useEffect, useState } from 'react'

/** Each picture fetched once a page, however many readers ask. */
const fetched = new Map<string, Promise<string | null>>()

function asData(url: string): Promise<string | null> {
  let picture = fetched.get(url)
  if (!picture) {
    picture = fetch(url)
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => blob && new Promise<string | null>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
        reader.onerror = () => resolve(null)
        reader.readAsDataURL(blob)
      }))
      .catch(() => null)
    fetched.set(url, picture)
  }
  return picture
}

/**
 * The agents' figures as `data:` pictures, by their address, as they arrive: for a web page an agent
 * made, which runs with no origin and may load nothing from this computer (lib/files/pageFrame.ts),
 * so it is handed the pictures its bubbles show.
 */
export function useFigurePictures(urls: readonly string[]): ReadonlyMap<string, string> {
  const [pictures, setPictures] = useState<ReadonlyMap<string, string>>(new Map())
  const wanted = [...new Set(urls)].sort().join('\n')
  useEffect(() => {
    let live = true
    for (const url of wanted ? wanted.split('\n') : []) {
      void asData(url).then((data) => {
        if (live && data) setPictures((current) => (current.get(url) === data ? current : new Map(current).set(url, data)))
      })
    }
    return () => { live = false }
  }, [wanted])
  return pictures
}

/**
 * Holds the figures' idle breath still while the window is in the background (motion.css): a loop no
 * one is looking at is only work, and the review's motion rules keep nothing looping then. Sets
 * `figures-still` on the document element when the window loses focus or the page is hidden, and
 * takes it off when it is back. Returns a function that stops watching.
 */
export function watchFiguresStill(win: Window = window): () => void {
  const doc = win.document
  const sync = () => { doc.documentElement.classList.toggle('figures-still', doc.hidden || !doc.hasFocus()) }
  win.addEventListener('focus', sync)
  win.addEventListener('blur', sync)
  doc.addEventListener('visibilitychange', sync)
  sync()
  return () => {
    win.removeEventListener('focus', sync)
    win.removeEventListener('blur', sync)
    doc.removeEventListener('visibilitychange', sync)
    doc.documentElement.classList.remove('figures-still')
  }
}

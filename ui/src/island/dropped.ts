// Files that come to the island through the page's file picker (ADR 0083). Those dropped on it that
// the Mac app took itself: files another app writes only once they are dropped, as Mail does with a
// message. WebKit's own way of taking them ends the page, so the app takes them and the page asks
// for them through a file picker, which the app answers with them. And files chosen with + in the
// box, which the app asks for in an Open panel when it took none. Either way they arrive as the
// page's own files, as a file dragged from Finder does.

/** Ask for files through the page's file picker, at once, while a press or the app's message counts
    as the person's own doing: WebKit opens a file picker only then. `took` hears them, if any come;
    `cancelled`, if the person chose none. */
export function pickFiles(took: (files: File[]) => void, cancelled?: () => void): void {
  const picker = document.createElement('input')
  picker.type = 'file'
  picker.multiple = true
  picker.hidden = true
  const done = () => picker.remove()
  picker.addEventListener('change', () => {
    const files = [...(picker.files ?? [])]
    done()
    if (files.length) took(files)
  }, { once: true })
  picker.addEventListener('cancel', () => {
    done()
    cancelled?.()
  }, { once: true })
  document.body.append(picker)
  picker.click()
}

// Files dropped on the island that the Mac app took itself (ADR 0083): files another app writes
// only once they are dropped, as Mail does with a message. WebKit's own way of taking them ends
// the page, so the app takes them and the page asks for them through a file picker, which the app
// answers with them. They arrive as the page's own files, as a file dragged from Finder does.

/** Ask for the files the app took, at once, while the app's message counts as the person's own
    doing: WebKit opens a file picker only then. `took` hears them, if the app has any. */
export function takeDropped(took: (files: File[]) => void): void {
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
  picker.addEventListener('cancel', done, { once: true })
  document.body.append(picker)
  picker.click()
}

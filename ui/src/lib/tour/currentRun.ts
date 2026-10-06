/**
 * The newest piece of work on screen: the team's chat says it (ADR 0051), and a run opened by link
 * names it in the address.
 */
export function currentRun(): string | null {
  const chat = document.querySelector('[data-tour="chat"]')?.getAttribute('data-newest-run')
  return chat || new URLSearchParams(window.location.search).get('run')
}

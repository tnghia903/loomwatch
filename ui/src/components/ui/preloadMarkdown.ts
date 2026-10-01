/** Starts fetching the Markdown renderer early, e.g. when a run opens, so the answer formats without a flash. */
export function preloadMarkdown(): void {
  void import('./MarkdownRenderer')
}

/** Changes on this page that leaving would lose, and how to keep or drop them first. */
export interface LeaveGuard {
  /** Saves; true once saved. */
  save: () => Promise<boolean>
  /** Why it can't be saved as it is, if it can't. */
  problem: string | null
  /** Drops the changes, when that takes more than leaving. */
  discard?: () => Promise<void>
}

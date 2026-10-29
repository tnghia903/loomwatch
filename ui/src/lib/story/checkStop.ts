// What a check step that stopped to ask says (ADR 0062, `whenStillNotMet: ask`): the work, what is
// still not met, and why it stopped sending it back. One module so the chat, the composer and Needs
// you say it alike.

import type { CheckWait } from '../runs/client'

function checksWord(count: number): string {
  return count === 1 ? '1 check' : `${count} checks`
}

function timesWord(count: number): string {
  return count === 1 ? 'once' : `${count} times`
}

/** Tries, as the person's message counted them (ADR 0098): the first work is one. */
function triesWord(rounds: number): string {
  return rounds === 0 ? '1 try' : `${rounds + 1} tries`
}

/** One line: "Writer’s work still misses 2 checks after going back 2 times." */
export function checkStopTitle(check: CheckWait, name: (id: string) => string, checker: string): string {
  const work = `${name(check.checked)}’s work`
  const misses = checksWord(check.items.length)
  switch (check.reason) {
    case 'no_progress':
      return check.tries
        ? `${work} still misses ${misses} after ${triesWord(check.rounds)}: the last try fixed none of them.`
        : `${work} still misses ${misses}: the last round fixed none of them.`
    case 'unchecked':
      return `${checker} could not confirm ${misses} on ${work}.`
    case 'not_open':
      return `${work} still misses ${misses}, and ${name(check.checked)} has finished, so it can’t be sent back.`
    default:
      if (check.tries) return `${work} still misses ${misses} after ${triesWord(check.rounds)}.`
      return check.rounds > 0 ? `${work} still misses ${misses} after going back ${timesWord(check.rounds)}.` : `${work} still misses ${misses}.`
  }
}

/** What is still open, one line each: "Not met: Cites the 2025 report — cites the 2023 one". */
export function checkStopLines(check: CheckWait): string[] {
  return check.items.map((item) => `${item.verdict === 'not_met' ? 'Not met' : 'Not sure'}: ${item.item}${item.evidence ? ` — ${item.evidence}` : ''}`)
}

/** What a send-back from the stop does, said where the person decides. It needs no note: the checks
 *  still open say what is wrong (ADR 0098). */
export function checkStopTip(check: CheckWait, name: (id: string) => string, checker: string): string {
  return `Approve keeps the work as it is. Send back has ${name(check.checked)} try again on what’s not met, and ${checker} checks it again; a note in the box below says more.`
}

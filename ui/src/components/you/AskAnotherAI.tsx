import { Check, Copy } from 'lucide-react'
import { useRef, useState } from 'react'

import { keys } from '../../lib/platform'
import { MAX_ABOUT_CHARS } from '../../lib/you/client'

/**
 * The message a person pastes into ChatGPT or Claude, which already remember them, so it writes
 * the About you note for them. It asks for the same things the box's hint names, written as the
 * person ("I…"), short enough for the box, and without anything private, since every agent's task
 * carries the note to the AI it runs on.
 */
export const ASK_ANOTHER_AI = `I use an app where AI agents do work for me, and I want them to know me the way you do. Using everything you remember about me, both your saved memory and what you’ve learned from our past chats, write a short note about me that I can paste into the app’s “About you” box.

Rules:
- Write it in first person, as if I wrote it (“I work as…”, “Answer in…”).
- Keep it under 140 words. It must fit in ${MAX_ABOUT_CHARS.toLocaleString('en-US')} characters. Use plain sentences: no headings, bullet points or markdown.
- Cover these, in this order: what I do and how expert I am; what I’m working on now; the language I want answers in; how long and detailed I like answers; the tone and format I prefer; anything I’ve asked you more than once to do or avoid.
- Only include things you’re sure of that are still true today. Leave out one-off topics and anything you’d be guessing.
- Leave out my name and anything private: passwords, keys, account or ID numbers, addresses, phone numbers, email, money, health, and other people’s personal details.

Reply with only the note, with nothing before or after it.`

/**
 * Folded under the About you box: someone who already uses ChatGPT or Claude copies one message,
 * and that AI writes the note from what it remembers. Nothing is sent from here; the person
 * pastes the message there and the answer back.
 */
export function AskAnotherAI() {
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  const message = useRef<HTMLPreElement>(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(ASK_ANOTHER_AI)
      setCopied('yes')
    } catch {
      // No clipboard here: select the message, so the keyboard's copy takes it in one press.
      if (message.current) window.getSelection()?.selectAllChildren(message.current)
      setCopied('no')
    }
  }

  return (
    <details className="lw-settings-advanced">
      <summary className="t-body">Already use ChatGPT or Claude? Have it write this for you</summary>
      <ol className="lw-settings-steps t-body">
        <li>Copy the message below.</li>
        <li>Paste it into a new chat in ChatGPT or Claude, and send it.</li>
        <li>Read the answer, take out anything you don’t want your agents to know, and paste the rest in the box above.</li>
      </ol>
      <pre ref={message} className="code t-mono-sm lw-you-prompt" aria-label="The message to copy">{ASK_ANOTHER_AI}</pre>
      <div className="lw-settings-actions">
        <button type="button" className="btn" onClick={() => void copy()}>
          {copied === 'yes' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied === 'yes' ? 'Copied' : 'Copy message'}
        </button>
        {copied === 'no' && <span className="t-meta lw-settings-quiet">Couldn’t copy here. The message is selected: press {keys('⌘C')}.</span>}
      </div>
      <p className="t-meta lw-settings-quiet">It works best with Memory turned on in that app’s settings. Without it, the app knows only what’s in that one chat.</p>
    </details>
  )
}

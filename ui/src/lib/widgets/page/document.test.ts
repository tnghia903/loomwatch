import { describe, expect, it } from 'vitest'

import { FRAME_SANDBOX, frameDocument, framePolicy } from './document'

/** The policy a frame's document carries, read from its `<meta>`. */
function policyOf(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
}

describe('a page\'s frame', () => {
  it('may run scripts and nothing else: no origin, forms, pop-ups or moving the chat', () => {
    expect(FRAME_SANDBOX).toBe('allow-scripts')
  })

  it('loads nothing from any address, and runs only LoomWatch\'s renderer and its worker', () => {
    const policy = policyOf(frameDocument({ html: '<p>Hi</p>' }, 'token', 'nonce123'))
    expect(policy).toBe(framePolicy('nonce123'))
    const rules = new Map(policy.split(';').map((rule) => {
      const [name, ...values] = rule.trim().split(/\s+/u)
      return [name, values.join(' ')] as const
    }))
    expect(rules.get('default-src')).toBe("'none'")
    expect(rules.get('connect-src')).toBe("'none'")
    expect(rules.get('script-src')).toBe("'nonce-nonce123' blob:")
    expect(rules.get('img-src')).toBe('data: blob:')
    expect(rules.get('font-src')).toBe('data:')
    expect(rules.get('frame-src')).toBe("'none'")
    expect(rules.get('form-action')).toBe("'none'")
    expect(rules.get('base-uri')).toBe("'none'")
    expect(policy).not.toMatch(/unsafe-eval|https?:|\*/u)
  })

  it('carries the agent\'s script as data, never as a script of its own', () => {
    const script = 'lw.draw("</script><script>alert(1)</script>")'
    const html = frameDocument({ html: '<p>Hi</p>', script }, 'token', 'n0nce')
    const parsed = new DOMParser().parseFromString(html, 'text/html')
    const scripts = Array.from(parsed.querySelectorAll('script'))
    expect(scripts.map((each) => each.getAttribute('type') ?? 'js')).toEqual(['application/json', 'js'])
    expect(scripts[1].getAttribute('nonce')).toBe('n0nce')
    expect(scripts[1].textContent).not.toContain('alert(1)')
    const boot = JSON.parse(scripts[0].textContent ?? '{}') as { script: string; html: string; token: string }
    expect(boot.script).toBe(script)
    expect(boot.html).toBe('<p>Hi</p>')
    expect(boot.token).toBe('token')
  })

  it('looks up no address ahead of time and sends no referrer', () => {
    const parsed = new DOMParser().parseFromString(frameDocument({ html: '' }, 't', 'n'), 'text/html')
    expect(parsed.querySelector('meta[http-equiv="x-dns-prefetch-control"]')?.getAttribute('content')).toBe('off')
    expect(parsed.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer')
  })
})

import { afterEach, expect, it, vi } from 'vitest'

import { startChatGptSignIn } from './client'

afterEach(() => { vi.unstubAllGlobals() })

it('starts the ChatGPT sign-in at the address LoomWatch gives', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ url: 'https://auth.openai.com/authorize?x=1' }), { status: 200 })))
  await expect(startChatGptSignIn()).resolves.toBe('https://auth.openai.com/authorize?x=1')
})

// An answer with no address once put "Cannot read properties of null (reading 'url')" on the card.
it('says in words when LoomWatch answers with no address to sign in at', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
  await expect(startChatGptSignIn()).rejects.toThrow('Couldn’t start the sign-in with ChatGPT. Try again.')
})

it('says the same when the answer is there but has no address in it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  await expect(startChatGptSignIn()).rejects.toThrow('Couldn’t start the sign-in with ChatGPT. Try again.')
})

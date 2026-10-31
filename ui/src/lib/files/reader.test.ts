import { afterEach, describe, expect, it, vi } from 'vitest'

import { ChangedSince, putBack, rawVersion, writeFile } from './reader'

const respond = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

afterEach(() => vi.unstubAllGlobals())

describe('changing a file in the reader (ADR 0107)', () => {
  it('writes the change as bytes, naming the version it was made on, from LoomWatch’s own page', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => respond(200, { version: 'sha256:new', kept: 'k1' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await writeFile('/t/.loomwatch/team/writer/notes.md', 'Since April.\n', 'sha256:old')).toEqual({ version: 'sha256:new', kept: 'k1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/files/write?path=%2Ft%2F.loomwatch%2Fteam%2Fwriter%2Fnotes.md')
    expect(init?.method).toBe('PUT')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/octet-stream', 'If-Match': '"sha256:old"', 'X-LoomWatch-Request': '1' })
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('Since April.\n')
  })

  it('says when the file changed on disk since it was read, apart from any other refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(() => respond(409, { error: 'notes.md changed since you opened it' })))
    const changed = writeFile('/t/notes.md', 'x', 'sha256:old')
    await expect(changed).rejects.toBeInstanceOf(ChangedSince)
    await expect(changed).rejects.toThrow('changed since you opened it')
    vi.stubGlobal('fetch', vi.fn(() => respond(403, { error: 'LoomWatch changes only files your agents made' })))
    const refused = writeFile('/t/team.yaml', 'x', 'sha256:old')
    await expect(refused).rejects.not.toBeInstanceOf(ChangedSince)
    await expect(refused).rejects.toThrow('only files your agents made')
  })

  it('puts a kept copy back by its id', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => respond(200, { version: 'sha256:old', kept: 'k2' }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await putBack('k1')).toEqual({ version: 'sha256:old', kept: 'k2' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/files/put-back')
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', 'X-LoomWatch-Request': '1' })
    expect(JSON.parse(String(init?.body))).toEqual({ id: 'k1' })
  })

  it('reads the version a deck’s bytes were answered with', () => {
    expect(rawVersion(new Response('', { headers: { ETag: '"sha256:abc"' } }))).toBe('sha256:abc')
    expect(rawVersion(new Response('', { headers: { ETag: 'W/"sha256:abc"' } }))).toBe('sha256:abc')
    expect(rawVersion(new Response(''))).toBeNull()
  })
})

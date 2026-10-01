/** What the operator sees whenever the browser cannot reach the daemon at all. */
export const DAEMON_UNREACHABLE =
  'Can’t reach the LoomWatch server. Check that it is still running in its terminal, then try again.'

/** The daemon did not answer: it stopped, crashed, or was never started. */
export class DaemonUnreachableError extends Error {
  constructor() {
    super(DAEMON_UNREACHABLE)
  }
}

/**
 * `fetch` for the daemon's API. When the daemon is down the browser rejects with "Failed to fetch"
 * (Safari: "Load failed"), and a dev proxy answers 502 with an empty body that then fails to parse
 * as "Unexpected end of JSON input". Neither tells anyone what to do, so both become one sentence
 * that does. Any answer the daemon itself gave, error or not, passes through untouched.
 */
export async function daemonFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let response: Response
  try {
    response = await (init === undefined ? fetch(input) : fetch(input, init))
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new DaemonUnreachableError()
  }
  const gateway = response.status === 502 || response.status === 503 || response.status === 504
  if (gateway && !(response.headers?.get('content-type') ?? '').includes('application/json')) throw new DaemonUnreachableError()
  return response
}

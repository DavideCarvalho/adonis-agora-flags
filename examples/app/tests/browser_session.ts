/**
 * A tiny cookie-keeping HTTP client: what a browser does, against the real server. It echoes the
 * XSRF-TOKEN cookie on writes, as the flags console does.
 */
export class BrowserSession {
  cookies = new Map<string, string>()

  constructor(readonly base: string) {}

  async request(
    path: string,
    init: { method?: string; json?: unknown; headers?: Record<string, string> } = {}
  ) {
    const method = init.method ?? (init.json === undefined ? 'GET' : 'POST')
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers }
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    }
    const xsrf = this.cookies.get('XSRF-TOKEN')
    if (xsrf && method !== 'GET') headers['x-xsrf-token'] = decodeURIComponent(xsrf)
    let body: string | undefined
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.json)
    }
    const response = await fetch(`${this.base}${path}`, { method, headers, body, redirect: 'manual' })
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';')
      const index = pair.indexOf('=')
      const name = pair.slice(0, index).trim()
      const value = pair.slice(index + 1).trim()
      const expired = attributes.some((a) => /max-age=0\b/i.test(a.trim()))
      if (value === '' || expired) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return response
  }

  async json<T = any>(path: string, init?: Parameters<BrowserSession['request']>[1]) {
    const response = await this.request(path, init)
    const text = await response.text()
    return { status: response.status, body: (text ? JSON.parse(text) : null) as T, response }
  }

  /** Signs in through the app's own login route (a GET first, for the CSRF cookie). */
  async login(email: string, password = 'secret-password') {
    await this.request('/')
    const response = await this.request('/login', { json: { email, password } })
    if (response.status !== 200) throw new Error(`login failed: ${response.status}`)
    return this
  }
}

export const base = () => `http://${process.env.HOST}:${process.env.PORT}`

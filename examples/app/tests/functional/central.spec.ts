import { type ChildProcess, spawn } from 'node:child_process'
import { copyFileSync, rmSync } from 'node:fs'
import { test } from '@japa/runner'
import Database from 'better-sqlite3'
import { BrowserSession } from '#tests/browser_session'

const CP_PORT = 3401
const TENANT_PORT = 3402
const SECRET = 'tenant-secret'

/** Starts this same app as its own process, with another topology, port and database. */
function startApp(port: number, env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import=@poppinss/ts-exec', 'bin/server.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      HOST: 'localhost',
      PORT: String(port),
      APP_URL: `http://localhost:${port}`,
      LOG_LEVEL: 'warn',
      FLAGS_SECRET: SECRET,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout!.on('data', (chunk) => (output += chunk))
  child.stderr!.on('data', (chunk) => (output += chunk))
  return { child, output: () => output }
}

async function waitUntilUp(port: number, logs: () => string) {
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    try {
      if ((await fetch(`http://localhost:${port}/`)).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`app on ${port} did not start:\n${logs()}`)
}

async function eventually<T>(read: () => Promise<T> | T, ok: (value: T) => boolean, ms = 20_000) {
  const until = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > until) return value
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

test.group('a central flags server and a tenant app, as two real processes', (group) => {
  const processes: ChildProcess[] = []
  let logs: Array<() => string> = []

  group.setup(async () => {
    // Both start from the test database: same users, migrated.
    for (const name of ['cp', 'tenant']) {
      rmSync(`tmp/${name}.sqlite3`, { force: true })
      copyFileSync(process.env.DB_FILE!, `tmp/${name}.sqlite3`)
    }
    const cp = startApp(CP_PORT, { FLAGS_TOPOLOGY: 'control-plane', DB_FILE: 'tmp/cp.sqlite3' })
    const tenant = startApp(TENANT_PORT, {
      FLAGS_TOPOLOGY: 'tenant',
      DB_FILE: 'tmp/tenant.sqlite3',
      FLAGS_URL: `http://localhost:${CP_PORT}/_flags`,
    })
    processes.push(cp.child, tenant.child)
    logs = [cp.output, tenant.output]
    await waitUntilUp(CP_PORT, cp.output)
    await waitUntilUp(TENANT_PORT, tenant.output)
    return async () => {
      for (const child of processes) child.kill('SIGTERM')
    }
  })

  test('a change in the central console reaches the tenant; its events reach the center', async ({
    assert,
  }) => {
    const center = `http://localhost:${CP_PORT}`
    const app = `http://localhost:${TENANT_PORT}`

    // The tenant starts from the code defaults.
    const visitor = new BrowserSession(app)
    assert.isFalse((await visitor.json('/checkout')).body.newCheckout)

    const admin = await new BrowserSession(center).login('admin@shop.test')
    const saved = await admin.json('/flags/api/flags/new_checkout', {
      method: 'PUT',
      json: {
        definition: {
          variants: { on: true, off: false },
          enabled: true,
          offVariant: 'off',
          fallthrough: { variant: 'on' },
        },
      },
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))

    const seen = await eventually(
      async () => (await visitor.json('/checkout')).body.newCheckout,
      (value) => value === true
    )
    assert.isTrue(seen, logs.map((l) => l()).join('\n'))

    // A conversion on the tenant lands in the center's warehouse, under the tenant's name.
    const customer = await new BrowserSession(app).login('pro@shop.test')
    assert.equal((await customer.request('/purchase', { json: { value: 12 } })).status, 204)
    const warehouse = new Database('tmp/cp.sqlite3', { readonly: true })
    try {
      const rows = await eventually(
        () => warehouse.prepare("SELECT app FROM flags_tracks WHERE name = 'purchase'").all() as Array<{ app: string }>,
        (found) => found.some((row) => row.app === 'shop'),
        30_000
      )
      assert.isTrue(rows.some((row) => row.app === 'shop'), logs.map((l) => l()).join('\n'))
    } finally {
      warehouse.close()
    }
  }).timeout(90_000)

  test('the tenant hands its browser a token for the central flags API', async ({ assert }) => {
    const customer = await new BrowserSession(`http://localhost:${TENANT_PORT}`).login(
      'pro@shop.test'
    )
    const { status, body: issued } = await customer.json('/_flags/token')
    assert.equal(status, 200, logs.map((l) => l()).join('\n'))
    assert.equal(issued.url, `http://localhost:${CP_PORT}/_flags`)

    const api = new BrowserSession('')
    const evaluated = await api.json(`${issued.url}/v1/client/evaluate`, {
      json: {},
      headers: { authorization: `Bearer ${issued.token}` },
    })
    assert.equal(evaluated.status, 200)
    assert.isTrue(evaluated.body.values.new_checkout)
  }).timeout(60_000)
})

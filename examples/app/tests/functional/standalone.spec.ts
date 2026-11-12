import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { base, BrowserSession } from '#tests/browser_session'

const session = () => new BrowserSession(base())

const CHECKOUT_FOR_PRO = {
  variants: { classic: 'classic', one_page: 'one_page' },
  enabled: true,
  offVariant: 'classic',
  rules: [
    {
      id: 'pro',
      conditions: [{ attribute: 'plan', op: 'in', values: ['pro'] }],
      serve: { variant: 'one_page' },
    },
  ],
  fallthrough: { variant: 'classic' },
}

/** Waits for something the background worker does (relay to the warehouse tables). */
async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean, ms = 20_000) {
  const until = Date.now() + ms
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > until) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

test.group('reading flags in a real app', () => {
  test('an anonymous visitor gets the code defaults and a stable anonymous id', async ({
    assert,
  }) => {
    const visitor = session()
    const { body } = await visitor.json('/checkout')
    assert.include(body, { newCheckout: false, variant: 'classic', maxUploads: 10 })
    assert.exists(visitor.cookies.get('anon_id'))

    const { body: shared } = await visitor.json('/client-flags')
    assert.deepEqual(Object.keys(shared).sort(), ['checkout', 'new_checkout'])

    assert.equal((await visitor.request('/beta')).status, 404)
    const page = await (await visitor.request('/checkout/page')).text()
    assert.include(page, 'classic checkout')
    assert.include(page, 'Up to 10 files')
  })
})

test.group('the console, behind @adonisjs/auth and Bouncer', () => {
  test('anonymous → login, customer → 403, developer → in', async ({ assert }) => {
    const anonymous = await session().request('/flags')
    assert.equal(anonymous.status, 302)
    assert.equal(anonymous.headers.get('location'), '/login')

    const customer = await (await session().login('free@shop.test')).request('/flags/api/flags')
    assert.equal(customer.status, 403)

    const developer = await session().login('dev@shop.test')
    assert.equal((await developer.request('/flags')).status, 200)
    const { status, body } = await developer.json('/flags/api/flags')
    assert.equal(status, 200)
    assert.isTrue(JSON.stringify(body).includes('new_checkout'))
  })

  test('only admins change production; the change reaches the app at once', async ({
    assert,
  }) => {
    const developer = await session().login('dev@shop.test')
    const denied = await developer.request('/flags/api/flags/new_checkout/enabled', {
      json: { enabled: true },
    })
    assert.equal(denied.status, 403)

    const admin = await session().login('admin@shop.test')
    const { status } = await admin.json('/flags/api/flags/new_checkout', {
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
    assert.equal(status, 200)

    const visitor = session()
    assert.isTrue((await visitor.json('/checkout')).body.newCheckout)
    assert.equal((await visitor.request('/beta')).status, 200)
    assert.include(await (await visitor.request('/checkout/page')).text(), 'new checkout')

    const { body: log } = await admin.json('/flags/api/audit?key=new_checkout')
    assert.equal(log.entries[0].actor.id, String((await db.from('users').where('email', 'admin@shop.test').first()).id))
    assert.equal(log.entries[0].actor.name, 'admin')
  })

  test('targeting reads attributes from the app’s own data (plan)', async ({ assert }) => {
    const admin = await session().login('admin@shop.test')
    const saved = await admin.json('/flags/api/flags/checkout', {
      method: 'PUT',
      json: { definition: CHECKOUT_FOR_PRO },
    })
    assert.equal(saved.status, 200)

    const pro = await session().login('pro@shop.test')
    assert.equal((await pro.json('/checkout')).body.variant, 'one_page')
    assert.include(await (await pro.request('/checkout/page')).text(), 'one page')
    const free = await session().login('free@shop.test')
    assert.equal((await free.json('/checkout')).body.variant, 'classic')
  })
})

test.group('frontends without Inertia: the token endpoint and the flags API', () => {
  test('the session user gets a token; the flags API answers for them', async ({ assert }) => {
    const pro = await session().login('pro@shop.test')
    const { status, body: issued } = await pro.json('/_flags/token')
    assert.equal(status, 200)
    assert.equal(issued.url, '/_flags')

    // From here on the browser only presents the token: no cookies.
    const api = new BrowserSession(base())
    const evaluated = await api.json(`${issued.url}/v1/client/evaluate`, {
      json: {},
      headers: { authorization: `Bearer ${issued.token}` },
    })
    assert.equal(evaluated.status, 200)
    assert.equal(evaluated.body.values.checkout, 'one_page')
    assert.notProperty(evaluated.body.values, 'max_uploads')

    const events = await api.json(`${issued.url}/v1/client/events`, {
      json: { events: [{ type: 'track', name: 'banner_click' }] },
      headers: { authorization: `Bearer ${issued.token}` },
    })
    assert.equal(events.status, 202)
    assert.equal(events.body.accepted, 1)

    const refused = await api.request(`${issued.url}/v1/client/evaluate`, {
      json: {},
      headers: { authorization: 'Bearer forged' },
    })
    assert.equal(refused.status, 401)
  })
})

test.group('experiments end to end', () => {
  test('exposures and conversions reach the warehouse tables', async ({ assert }) => {
    const admin = await session().login('admin@shop.test')
    const saved = await admin.json('/flags/api/flags/checkout', {
      method: 'PUT',
      json: {
        definition: {
          variants: { classic: 'classic', one_page: 'one_page' },
          enabled: true,
          offVariant: 'classic',
          fallthrough: {
            split: [
              { variant: 'classic', weight: 1 },
              { variant: 'one_page', weight: 1 },
            ],
          },
          experiment: {},
        },
      },
    })
    assert.equal(saved.status, 200)

    const free = await session().login('free@shop.test')
    const { body } = await free.json('/checkout')
    assert.oneOf(body.variant, ['classic', 'one_page'])
    assert.equal(body.details.reason, 'SPLIT')
    assert.equal((await free.request('/purchase', { json: { value: 30 } })).status, 204)

    const user = await db.from('users').where('email', 'free@shop.test').first()
    const exposures = await eventually(
      () => db.from('flags_exposures').where('subject', String(user.id)),
      (rows) => rows.length > 0
    )
    assert.lengthOf(exposures, 1)
    assert.equal(exposures[0].variant, body.variant)
    const tracks = await eventually(
      () => db.from('flags_tracks').where('subject', String(user.id)).where('name', 'purchase'),
      (rows) => rows.length > 0
    )
    assert.lengthOf(tracks, 1)
  }).timeout(40_000)
})

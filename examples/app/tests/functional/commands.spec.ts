import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { test } from '@japa/runner'
import { base, BrowserSession } from '#tests/browser_session'

const run = promisify(execFile)
const ace = (...args: string[]) =>
  run(process.execPath, ['ace', ...args], {
    env: { ...process.env, NODE_ENV: 'test' },
  })

test.group('ace commands against the same database', () => {
  test('flags:set changes what the running app serves; flags:list shows it', async ({
    assert,
  }) => {
    const visitor = new BrowserSession(base())
    const variant = async (wanted: string) => {
      let value = ''
      for (let i = 0; i < 40 && value !== wanted; i++) {
        value = (await visitor.json('/checkout')).body.variant
        if (value !== wanted) await new Promise((resolve) => setTimeout(resolve, 250))
      }
      return value
    }

    await ace('flags:set', 'checkout', 'one_page', '--note', 'e2e')
    // The running server picks the change up from the store, without a restart.
    assert.equal(await variant('one_page'), 'one_page')

    const { stdout } = await ace('flags:list', '--json')
    const listed = JSON.parse(stdout.slice(stdout.indexOf('[')))
    assert.exists(listed.find((row: { key: string }) => row.key === 'checkout'), stdout)

    await ace('flags:set', 'checkout', 'kill')
    assert.equal(await variant('classic'), 'classic')
  }).timeout(60_000)

  test('flags:types writes the types of console-created flags', async ({ assert }) => {
    await ace('flags:types', '--out', 'tmp/flags_types.d.ts')
    const generated = readFileSync('tmp/flags_types.d.ts', 'utf8')
    assert.include(generated, '@adonis-agora/flags/types')
  }).timeout(60_000)
})

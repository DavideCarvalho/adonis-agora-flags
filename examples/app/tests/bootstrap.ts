import { assert } from '@japa/assert'
import app from '@adonisjs/core/services/app'
import type { Config } from '@japa/runner/types'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import testUtils from '@adonisjs/core/services/test_utils'
import User from '#models/user'

export const plugins: Config['plugins'] = [assert(), pluginAdonisJS(app)]

async function seed() {
  for (const [email, role, plan] of [
    ['admin@shop.test', 'admin', 'pro'],
    ['dev@shop.test', 'developer', 'free'],
    ['pro@shop.test', 'customer', 'pro'],
    ['free@shop.test', 'customer', 'free'],
  ]) {
    await User.create({ email, role, plan, password: 'secret-password', fullName: email.split('@')[0] })
  }
}

export const runnerHooks: Required<Pick<Config, 'setup' | 'teardown'>> = {
  setup: [() => testUtils.db().migrate(), seed],
  teardown: [],
}

export const configureSuite: Config['configureSuite'] = (suite) => {
  if (suite.name === 'functional') return suite.setup(() => testUtils.httpServer().start())
}

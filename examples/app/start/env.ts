import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  APP_KEY: Env.schema.secret(),
  APP_URL: Env.schema.string({ format: 'url', tld: false }),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string(),
  SESSION_DRIVER: Env.schema.enum(['cookie', 'memory'] as const),
  /** Where the SQLite file lives (the central-server test runs two apps side by side). */
  DB_FILE: Env.schema.string.optional(),
  /** standalone (default), control-plane or tenant. */
  FLAGS_TOPOLOGY: Env.schema.enum.optional(['standalone', 'control-plane', 'tenant'] as const),
  FLAGS_URL: Env.schema.string.optional(),
  FLAGS_SECRET: Env.schema.string.optional(),
  FLAGS_ENVIRONMENT: Env.schema.string.optional(),
})

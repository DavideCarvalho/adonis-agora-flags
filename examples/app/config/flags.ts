import env from '#start/env'
import { defineConfig, flag, metric, type InferFlags, verifiers } from '@adonis-agora/flags'
import User from '#models/user'
import AppFlagsIdentity from '#flags/identity'

const flags = {
  new_checkout: flag.boolean({ default: false, description: 'The new checkout page', client: true }),
  checkout: flag.string({
    default: 'classic',
    variants: ['classic', 'one_page'],
    description: 'Checkout experiment',
    client: true,
  }),
  max_uploads: flag.number({ default: 10 }),
}

const shared = {
  flags,
  app: 'shop',
  environment: env.get('FLAGS_ENVIRONMENT', 'production'),
  identity: new AppFlagsIdentity(),
  // Targeting attributes come from our own data; the session only says who the user is.
  attributes: async (subject: { id: string | number; type?: string }) => {
    if (subject.type !== 'user') return {}
    const user = await User.find(subject.id)
    return { plan: user?.plan, role: user?.role }
  },
  browser: {},
}

const owned = {
  metrics: { conversion: metric.conversion('purchase') },
  experiments: { checkout: { metrics: ['conversion'] } },
}

const topology = env.get('FLAGS_TOPOLOGY', 'standalone')

const flagsConfig =
  topology === 'tenant'
    ? defineConfig({
        ...shared,
        topology: 'tenant',
        tenant: {
          url: env.get('FLAGS_URL', 'http://localhost:3333/_flags'),
          partition: 'shop',
          token: env.get('FLAGS_SECRET', ''),
        },
      })
    : topology === 'control-plane'
      ? defineConfig({
          ...shared,
          ...owned,
          app: 'flags-server',
          topology: 'control-plane',
          controlPlane: {
            verifyTenant: verifiers.sharedSecret({ shop: env.get('FLAGS_SECRET', '') }),
          },
        })
      : defineConfig({ ...shared, ...owned })

export default flagsConfig

declare module '@adonis-agora/flags/types' {
  interface FlagsList extends InferFlags<{ flags: typeof flags }> {}
}

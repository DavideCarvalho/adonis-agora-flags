import { Bouncer } from '@adonisjs/bouncer'
import type User from '#models/user'

/** Opens the flags console and changes flags outside production. */
export const manageFlags = Bouncer.ability((user: User) =>
  ['admin', 'developer'].includes(user.role)
)

/** Changes flags in production. */
export const changeProductionFlags = Bouncer.ability((user: User) => user.role === 'admin')

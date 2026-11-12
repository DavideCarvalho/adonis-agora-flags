import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

server.errorHandler(() => import('#exceptions/handler'))

server.use([() => import('#middleware/container_bindings_middleware')])

router.use([
  () => import('@adonisjs/core/bodyparser_middleware'),
  () => import('@adonisjs/session/session_middleware'),
  () => import('@adonisjs/shield/shield_middleware'),
  () => import('@adonisjs/auth/initialize_auth_middleware'),
  () => import('#middleware/initialize_bouncer_middleware'),
  () => import('@adonis-agora/flags/flags_middleware'),
])

export const middleware = router.named({
  auth: () => import('#middleware/auth_middleware'),
  flag: () => import('@adonis-agora/flags/flag_middleware'),
})

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'

const SessionController = () => import('#controllers/session_controller')
const ShopController = () => import('#controllers/shop_controller')

router.get('/', ({ response }) => response.json({ ok: true }))
router.post('/login', [SessionController, 'store'])
router.post('/logout', [SessionController, 'destroy'])

router.get('/checkout', [ShopController, 'checkout'])
router.get('/checkout/page', [ShopController, 'page'])
router.get('/client-flags', [ShopController, 'clientFlags'])
router.post('/purchase', [ShopController, 'purchase']).use(middleware.auth())
router.get('/beta', [ShopController, 'beta']).use(middleware.flag({ flag: 'new_checkout' }))

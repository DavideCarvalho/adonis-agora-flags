import type { HttpContext } from '@adonisjs/core/http'
import flags from '@adonis-agora/flags/services/main'

export default class ShopController {
  /** Reads flags through ctx.flags, as an app would. */
  async checkout({ flags: requestFlags, response }: HttpContext) {
    return response.json({
      newCheckout: await requestFlags.enabled('new_checkout'),
      variant: await requestFlags.variant('checkout'),
      maxUploads: await requestFlags.value('max_uploads'),
      details: await requestFlags.details('checkout'),
    })
  }

  /** What Inertia would share with the page. */
  async clientFlags({ flags: requestFlags, response }: HttpContext) {
    return response.json(await requestFlags.all())
  }

  /** A conversion, recorded for the signed-in user. */
  async purchase({ auth, response, request }: HttpContext) {
    const user = auth.getUserOrFail()
    await flags.track(user, 'purchase', { value: Number(request.input('value', 0)) })
    return response.noContent()
  }

  async page({ view }: HttpContext) {
    return view.render('checkout')
  }

  async beta({ response }: HttpContext) {
    return response.json({ beta: true })
  }
}

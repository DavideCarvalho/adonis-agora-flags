# @adonis-agora/flags

Feature flags and A/B experiments for AdonisJS. Part of the [Agora](https://davidecarvalho.github.io/agora) ecosystem.

```sh
node ace add @adonis-agora/flags
```

```ts
async show({ flags, inertia }: HttpContext) {
  if (await flags.enabled('new_player')) return inertia.render('player/new')
  return inertia.render('player/classic')
}
```

Documentation: https://davidecarvalho.github.io/agora/docs/flags

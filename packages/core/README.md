# @adonis-agora/flags-core

The framework-agnostic engine behind `@adonis-agora/flags`: the versioned ruleset format,
deterministic evaluation with OpenFeature-shaped results, and experiment statistics.

Most apps use `@adonis-agora/flags` and never import this package directly.

```ts
import { evaluate } from '@adonis-agora/flags-core'

const details = evaluate(ruleset, 'checkout_v2', 'control', { targetingKey: user.id, plan: 'pro' })
// { flagKey, value, variant, reason: 'SPLIT', flagMetadata: { rulesetVersion, ruleId } }
```

`evaluate` never throws. When something is wrong it returns the default you passed, with
`reason: 'ERROR'` and an `errorCode`.

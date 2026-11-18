/**
 * Whether a token holding `granted` may do `required`. This is the capability rule shared by every
 * Agora library: capabilities are compared segment by segment (split on `:`), a `*` segment matches
 * exactly one segment, and a capability ending in a `*` segment matches zero or more further
 * segments. So `*` matches everything, `flags:*` matches `flags` and `flags:ruleset:read`, and
 * `flags:ruleset:*` matches `flags:ruleset` and `flags:ruleset:read` — but nothing is implied:
 * `flags:events:write` does not grant `flags:ruleset:read`, and `flags:*` does not grant
 * `config:read`. Empty or non-string grants are ignored.
 */
export function capabilityAllows(granted: readonly string[], required: string): boolean {
  const want = required.split(':');
  for (const capability of granted) {
    if (typeof capability !== 'string' || capability === '') continue;
    const have = capability.split(':');
    let matched = true;
    for (let index = 0; index < have.length; index += 1) {
      if (have[index] === '*') continue;
      if (index >= want.length || have[index] !== want[index]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    // A trailing `*` covers the rest; otherwise the shapes must have the same length.
    if (have.length === want.length || have[have.length - 1] === '*') return true;
  }
  return false;
}

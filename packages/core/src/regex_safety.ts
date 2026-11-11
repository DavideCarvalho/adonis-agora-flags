/**
 * Guards for the `matches` operator. Its patterns are written by whoever edits targeting, and
 * JavaScript's backtracking engine can take exponential time on patterns like `(a+)+$`. A slow
 * pattern would stall every request that evaluates the flag, so patterns are checked when the
 * ruleset is saved (`validateRuleset`) and again when it is evaluated.
 *
 * The check is deliberately conservative: it rejects the constructs behind catastrophic
 * backtracking (a quantified group that itself contains a quantifier, and backreferences) and caps
 * the pattern and input sizes. A rejected pattern makes the flag fail closed (`PARSE_ERROR`).
 */

/** Longest pattern accepted. */
export const MAX_PATTERN_LENGTH = 256;
/** Longest input a pattern is run against; longer attribute values never match. */
export const MAX_MATCH_INPUT_LENGTH = 4096;

/** Why `source` is not allowed as a `matches` pattern, or `undefined` when it is. */
export function unsafeRegexReason(source: string): string | undefined {
  if (source.length > MAX_PATTERN_LENGTH) {
    return `pattern is longer than ${MAX_PATTERN_LENGTH} characters`;
  }
  try {
    new RegExp(source);
  } catch {
    return 'invalid regular expression';
  }
  if (/\\[1-9]|\\k</.test(source)) return 'backreferences are not allowed';
  if (hasNestedQuantifier(source)) {
    return 'a quantified group may not contain another quantifier (catastrophic backtracking)';
  }
  return undefined;
}

/**
 * Walks the pattern tracking, for each open group, whether a quantifier appeared inside it. A group
 * that contains a quantifier and is itself followed by a quantifier is the `(a+)+` shape.
 */
function hasNestedQuantifier(source: string): boolean {
  const stack: boolean[] = [];
  let inClass = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') {
      stack.push(false);
      continue;
    }
    if (ch === ')') {
      const innerQuantified = stack.pop() ?? false;
      const next = source[i + 1];
      const quantified = next === '*' || next === '+' || next === '?' || next === '{';
      if (innerQuantified && quantified && next !== '?') return true;
      if (innerQuantified && next === '{') return true;
      // The group's content counts as quantified for any enclosing group.
      if ((innerQuantified || quantified) && stack.length > 0) stack[stack.length - 1] = true;
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '{') {
      if (stack.length > 0) stack[stack.length - 1] = true;
      continue;
    }
    if (ch === '?' && source[i - 1] !== '(' && stack.length > 0) {
      // `?` after a group opener is a group modifier, not a quantifier.
      stack[stack.length - 1] = true;
    }
  }
  return false;
}

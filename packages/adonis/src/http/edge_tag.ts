/**
 * `@flag` for Edge templates. Needs the `flags` the middleware shares with views.
 *
 * ```edge
 * @flag('new_player')
 *   @include('partials/new_player')
 * @else
 *   @include('partials/classic_player')
 * @end
 *
 * @flag('checkout', 'one_page', 'two_page')
 *   …
 * @end
 * ```
 *
 * It compiles to `if (await flags.matches(…)) { … }`, so `@else` works as with `@if`.
 */
export const flagTag = {
  tagName: 'flag',
  block: true,
  seekable: true,
  compile(parser: EdgeParser, buffer: EdgeBuffer, token: EdgeToken) {
    const args = token.properties.jsArg.trim();
    if (args.length === 0) {
      throw new Error(`@flag needs a flag key (${token.filename}:${token.loc.start.line})`);
    }
    const ast = parser.utils.transformAst(
      parser.utils.generateAST(`await flags.matches(${args})`, token.loc, token.filename),
      token.filename,
      parser,
    );
    buffer.writeStatement(
      `if (${parser.utils.stringify(ast)}) {`,
      token.filename,
      token.loc.start.line,
    );
    for (const child of token.children) parser.processToken(child, buffer);
    buffer.writeStatement('}', token.filename, -1);
  },
};

interface EdgeToken {
  filename: string;
  loc: { start: { line: number; col: number }; end: { line: number; col: number } };
  properties: { jsArg: string };
  children: unknown[];
}

interface EdgeParser {
  utils: {
    generateAST(expression: string, loc: EdgeToken['loc'], filename: string): unknown;
    transformAst(ast: unknown, filename: string, parser: EdgeParser): unknown;
    stringify(ast: unknown): string;
  };
  processToken(token: unknown, buffer: EdgeBuffer): void;
}

interface EdgeBuffer {
  writeStatement(statement: string, filename: string, line: number): void;
}

/** Registers `@flag` on the app's Edge instance when `edge.js` is installed. */
export async function registerEdgeTag(): Promise<boolean> {
  try {
    const edge = (
      (await import('edge.js')) as unknown as {
        default: { registerTag(tag: typeof flagTag): void };
      }
    ).default;
    edge.registerTag(flagTag);
    return true;
  } catch {
    return false;
  }
}

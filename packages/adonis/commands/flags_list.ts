import { flags } from '@adonisjs/core/ace';
import { effectiveDeclarations } from '../src/declare.js';
import { describeServing, FlagsCommand } from './shared.js';

export default class FlagsList extends FlagsCommand {
  static override commandName = 'flags:list';
  static override description = 'List flags: declared type and default, and what each one serves';

  @flags.string({ description: 'Environment (default: the configured one)' })
  declare env?: string;

  @flags.boolean({ description: 'Print JSON' })
  declare json?: boolean;

  override async run() {
    const runtime = await this.runtime();
    const environment = this.env ?? runtime.manager.environment;
    const ruleset = await runtime.store!.readRuleset(environment);
    // Flags declared in code and flags created in the console alike.
    const declarations = effectiveDeclarations(runtime.manager.declarations, ruleset);
    const keys = [...new Set([...Object.keys(declarations), ...Object.keys(ruleset.flags)])].sort();
    const rows = keys.map((key) => {
      const declaration = declarations[key];
      return {
        key,
        type: declaration?.type ?? 'undeclared',
        default: declaration ? JSON.stringify(declaration.default) : '-',
        serving: describeServing(ruleset.flags[key]),
        owner: declaration?.owner ?? '',
      };
    });
    if (this.json) {
      this.logger.log(JSON.stringify(rows, null, 2));
      return;
    }
    this.logger.info(`environment ${environment}, ruleset version ${ruleset.version}`);
    const table = this.ui.table();
    table.head(['Flag', 'Type', 'Default', 'Serving', 'Owner']);
    for (const row of rows) table.row([row.key, row.type, row.default, row.serving, row.owner]);
    table.render();
  }
}

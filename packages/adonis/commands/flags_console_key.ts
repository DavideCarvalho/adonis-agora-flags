import { flags } from '@adonisjs/core/ace';
import { consoleCommandKeys, resolveConsoleCommands } from '../src/federation/console.js';
import { appKeyOf, releaseSecret } from '../src/http/browser.js';
import { FlagsCommand } from './shared.js';

/**
 * Prints this app's console-command public key: what another app's federated console sets as
 * `apps.<key>.controlPlane.publicKey` to send it commands in token mode. Derived from `APP_KEY`
 * and the `consoleCommands` prefix; only the public half is printed.
 */
export default class FlagsConsoleKey extends FlagsCommand {
  static override commandName = 'flags:console-key';
  static override description =
    "Print this app's console-command public key, for another console's controlPlane.publicKey";

  @flags.string({ description: 'The consoleCommands prefix (default: the configured one)' })
  declare prefix?: string;

  override async run() {
    const runtime = await this.runtime();
    const option = resolveConsoleCommands(
      (runtime.config as { consoleCommands?: Parameters<typeof resolveConsoleCommands>[0] })
        .consoleCommands ?? true,
      runtime.manager.app,
    );
    const prefix = this.prefix ?? option!.prefix;
    const appKey = releaseSecret(await appKeyOf(this.app));
    if (!appKey || appKey.length < 16) {
      throw new Error(
        'no APP_KEY (at least 16 characters): the console-command key derives from it',
      );
    }
    this.logger.log(JSON.stringify(consoleCommandKeys(appKey, prefix).publicKey));
  }
}

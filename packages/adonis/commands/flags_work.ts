import { flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { FlagsCommand } from './shared.js';

/**
 * The background loop outside web processes: relay events to sinks, run scheduled changes,
 * recompute experiment results, maintain the event log. `--once` runs one pass and exits (cron
 * jobs); without it the command stays up until SIGTERM.
 */
export default class FlagsWork extends FlagsCommand {
  static override commandName = 'flags:work';
  static override description =
    'Run the flags background work (relay, schedules, results, maintenance)';
  static override options: CommandOptions = { startApp: true, staysAlive: true };

  @flags.boolean({ description: 'Run one pass and exit' })
  declare once?: boolean;

  @flags.string({ description: 'Only relay to this sink' })
  declare sink?: string;

  override async run() {
    const runtime = await this.runtime();
    const worker = runtime.worker!;
    if (this.sink) {
      if (!runtime.relay && runtime.transport?.attachSinks) {
        this.logger.error(
          `the "${runtime.transport.name}" transport has no relay: its own jobs deliver to the sinks`,
        );
        this.exitCode = 1;
        return;
      }
      if (!runtime.sinks.has(this.sink)) {
        this.logger.error(
          `unknown sink "${this.sink}" (configured: ${[...runtime.sinks.keys()].join(', ') || 'none'})`,
        );
        this.exitCode = 1;
        return;
      }
      let stopping = false;
      const stop = () => {
        stopping = true;
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      do {
        const result = await worker.relaySink(this.sink);
        if (result)
          this.logger.info(
            `${this.sink}: delivered ${result.delivered}${result.busy ? ' (leased elsewhere)' : ''}`,
          );
        if (this.once) break;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } while (!stopping);
      return;
    }
    if (this.once) {
      await worker.runAll();
      this.logger.success('flags: one pass done');
      return;
    }
    this.logger.info('flags: worker running (Ctrl+C to stop)');
    worker.start();
    await new Promise<void>((resolve) => {
      const stop = async () => {
        await worker.stop();
        resolve();
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
    });
  }
}

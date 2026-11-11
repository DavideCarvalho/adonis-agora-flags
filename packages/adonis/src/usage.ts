import type { UsageRow } from './stores/store.js';

/**
 * Counts evaluations per flag in memory and hands them off periodically — the input of stale-flag
 * detection ("not evaluated in 30 days"). Counting is a Map increment; nothing touches I/O on the
 * evaluation path.
 */
export class UsageCounter {
  #counts = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly environment: string,
    private readonly sink: (rows: UsageRow[]) => Promise<void>,
    private readonly onError?: (error: unknown) => void,
  ) {}

  hit(flag: string) {
    this.#counts.set(flag, (this.#counts.get(flag) ?? 0) + 1);
  }

  start(intervalMs = 60_000) {
    this.#timer ??= setInterval(() => void this.flush(), intervalMs);
    this.#timer.unref();
  }

  async flush(): Promise<void> {
    if (this.#counts.size === 0) return;
    const day = new Date().toISOString().slice(0, 10);
    const rows = [...this.#counts].map(([flag, evaluations]) => ({
      environment: this.environment,
      flag,
      day,
      evaluations,
    }));
    this.#counts.clear();
    try {
      await this.sink(rows);
    } catch (error) {
      // Put the counts back; they go out with the next flush.
      for (const row of rows)
        this.#counts.set(row.flag, (this.#counts.get(row.flag) ?? 0) + row.evaluations);
      this.onError?.(error);
    }
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.flush();
  }
}

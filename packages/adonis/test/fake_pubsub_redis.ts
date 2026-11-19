/**
 * Redis pub/sub and `SET … PX … NX`, in memory, shaped like an ioredis client: `duplicate()` gives a
 * subscriber connection sharing the same server. `publish` answers how many subscribers got the
 * message, like Redis, so "nobody listens" can be told apart.
 */
interface Server {
  keys: Map<string, string>;
  subscribers: Set<FakePubSubRedis>;
  published: Array<{ channel: string; message: string }>;
}

export class FakePubSubRedis {
  readonly #channels = new Set<string>();
  readonly #listeners: Array<(channel: string, message: string) => void> = [];

  constructor(
    readonly server: Server = { keys: new Map(), subscribers: new Set(), published: [] },
  ) {}

  async publish(channel: string, message: string): Promise<number> {
    this.server.published.push({ channel, message });
    let receivers = 0;
    for (const sub of [...this.server.subscribers]) {
      if (!sub.#channels.has(channel)) continue;
      receivers++;
      // Delivered on a later tick, as over a socket.
      setImmediate(() => {
        for (const listener of sub.#listeners) listener(channel, message);
      });
    }
    return receivers;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    if (args.includes('NX') && this.server.keys.has(key)) return null;
    this.server.keys.set(key, value);
    return 'OK';
  }

  duplicate(): FakePubSubRedis {
    return new FakePubSubRedis(this.server);
  }

  async subscribe(...channels: string[]): Promise<number> {
    for (const channel of channels) this.#channels.add(channel);
    this.server.subscribers.add(this);
    return this.#channels.size;
  }

  on(_event: 'message', listener: (channel: string, message: string) => void): this {
    this.#listeners.push(listener);
    return this;
  }

  disconnect(): void {
    this.server.subscribers.delete(this);
  }
}

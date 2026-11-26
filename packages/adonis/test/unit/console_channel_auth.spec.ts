import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_MAX_AGE_MS,
  type FlagsConsoleCommand,
  RedisConsoleChannel,
} from '../../src/federation/redis_channel.js';
import { FakePubSubRedis } from '../fake_pubsub_redis.js';

/**
 * The federated console's Redis channel authenticates every command and answer with the secret
 * both apps share: whoever can publish on the Redis without it can neither run, replay nor answer a
 * command.
 */

const SECRET = 'test-console-secret-0123456789';
const PREFIX = 'et';
const COMMANDS = `${PREFIX}-flags-console`;
const REPLIES = `${PREFIX}-flags-console-reply`;

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

function sealed(channel: string, body: Record<string, unknown>, secret = SECRET): string {
  const p = JSON.stringify(body);
  const mac = createHmac('sha256', secret).update(`${channel}\n${p}`).digest('base64');
  return JSON.stringify({ v: 1, p, mac });
}

async function answering(redis: FakePubSubRedis) {
  const ran: FlagsConsoleCommand[] = [];
  const errors: string[] = [];
  const channel = new RedisConsoleChannel({
    client: redis.duplicate(),
    prefix: PREFIX,
    secret: SECRET,
  });
  await channel.answer(
    async (command) => {
      ran.push(command);
      return { done: command.verb };
    },
    { onError: (error) => errors.push((error as Error).message) },
  );
  return { channel, ran, errors };
}

const open: RedisConsoleChannel[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const channel of open.splice(0)) await channel.close();
});

describe('console channel authentication', () => {
  it('refuses to be built without a secret of 16+ characters', () => {
    const redis = new FakePubSubRedis();
    expect(() => new RedisConsoleChannel({ client: redis, prefix: PREFIX } as never)).toThrow(
      /consoleCommands\.secret/,
    );
    expect(
      () => new RedisConsoleChannel({ client: redis, prefix: PREFIX, secret: 'too-short' }),
    ).toThrow(/at least 16/);
    expect(
      () =>
        new RedisConsoleChannel({
          client: redis,
          prefix: PREFIX,
          secret: { release: () => SECRET },
        }),
    ).not.toThrow();
  });

  it('runs a command sealed with the shared secret and authenticates the answer', async () => {
    const redis = new FakePubSubRedis();
    const app = await answering(redis);
    open.push(app.channel);
    const console = new RedisConsoleChannel({ client: redis, prefix: PREFIX, secret: SECRET });
    open.push(console);
    const reply = await console.send(
      { id: 'c1', verb: 'setRollout', args: [{ a: 1 }], actor: { id: 'ops' } },
      { timeoutMs: 1000 },
    );
    expect(reply).toEqual({ id: 'c1', ok: true, data: { done: 'setRollout' } });
    expect(app.ran).toHaveLength(1);
    expect(app.ran[0]).toMatchObject({ id: 'c1', verb: 'setRollout', actor: { id: 'ops' } });
  });

  it('drops a plain (unsealed) command, as the 0.x protocol sent it', async () => {
    const redis = new FakePubSubRedis();
    const app = await answering(redis);
    open.push(app.channel);
    await redis.publish(
      COMMANDS,
      JSON.stringify({ id: 'x1', verb: 'approveChange', args: [], actor: { id: 'mallory' } }),
    );
    await settle();
    expect(app.ran).toEqual([]);
    expect(app.errors.join('\n')).toMatch(/not authenticated/);
    expect(redis.server.published.filter((m) => m.channel === REPLIES)).toEqual([]);
  });

  it('drops a command sealed with another secret, or sealed for another channel', async () => {
    const redis = new FakePubSubRedis();
    const app = await answering(redis);
    open.push(app.channel);
    const body = { id: 'x2', verb: 'setRollout', args: [], ts: Date.now() };
    await redis.publish(COMMANDS, sealed(COMMANDS, body, 'another-secret-0123456789'));
    await redis.publish(COMMANDS, sealed(REPLIES, { ...body, id: 'x3' }));
    await settle();
    expect(app.ran).toEqual([]);
    expect(app.errors.join('\n')).toMatch(/bad MAC/);
  });

  it('refuses a stale command and runs a replayed one only once', async () => {
    const redis = new FakePubSubRedis();
    const app = await answering(redis);
    open.push(app.channel);
    const stale = {
      id: 's1',
      verb: 'setRollout',
      args: [],
      ts: Date.now() - COMMAND_MAX_AGE_MS - 1,
    };
    await redis.publish(COMMANDS, sealed(COMMANDS, stale));
    const fresh = sealed(COMMANDS, { id: 'f1', verb: 'setRollout', args: [], ts: Date.now() });
    await redis.publish(COMMANDS, fresh);
    await redis.publish(COMMANDS, fresh);
    await settle();
    expect(app.ran.map((c) => c.id)).toEqual(['f1']);
    expect(app.errors.join('\n')).toMatch(/stale/);
  });

  it('never crashes on garbage', async () => {
    const redis = new FakePubSubRedis();
    const app = await answering(redis);
    open.push(app.channel);
    for (const garbage of ['', 'not json', 'null', '[]', '{"p":1}', '{"p":"{","mac":"AA=="}']) {
      await redis.publish(COMMANDS, garbage);
    }
    await settle();
    expect(app.ran).toEqual([]);
    // Still answering afterwards.
    const console = new RedisConsoleChannel({ client: redis, prefix: PREFIX, secret: SECRET });
    open.push(console);
    await expect(
      console.send({ id: 'ok', verb: 'profile', args: [] }, { timeoutMs: 1000 }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('ignores a forged answer', async () => {
    const redis = new FakePubSubRedis();
    // Something listens (so the command is not "unreachable"), but never answers.
    const listener = redis.duplicate();
    await listener.subscribe(COMMANDS);
    const console = new RedisConsoleChannel({ client: redis, prefix: PREFIX, secret: SECRET });
    open.push(console);
    const pending = console.send({ id: 'c9', verb: 'profile', args: [] }, { timeoutMs: 200 });
    await settle();
    await redis.publish(REPLIES, JSON.stringify({ id: 'c9', ok: true, data: 'forged' }));
    await redis.publish(
      REPLIES,
      sealed(
        REPLIES,
        { id: 'c9', ok: true, data: 'forged', ts: Date.now() },
        'wrong-secret-0123456789',
      ),
    );
    await expect(pending).rejects.toThrow(/answered/);
  });
});

import { execFileSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';

/**
 * One Postgres, Redis, ClickHouse and MySQL for the whole run, handed down through the environment (vitest forks
 * every spec file into its own process; per-file containers would cost minutes).
 */
let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;
let clickhouse: string | undefined;
let mysql: string | undefined;

/** MySQL 8 through the docker CLI. */
async function startMysql(): Promise<string> {
  mysql = execFileSync('docker', [
    'run',
    '-d',
    '--rm',
    '-p',
    '127.0.0.1::3306',
    '-e',
    'MYSQL_ROOT_PASSWORD=flags',
    'mysql:8.4',
  ])
    .toString()
    .trim();
  const port = execFileSync('docker', ['port', mysql, '3306/tcp'])
    .toString()
    .trim()
    .split(':')
    .pop();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      execFileSync(
        'docker',
        ['exec', mysql, 'mysql', '-uroot', '-pflags', '-h127.0.0.1', '-e', 'SELECT 1'],
        {
          stdio: 'ignore',
        },
      );
      return `mysql://root:flags@127.0.0.1:${port}`;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error('MySQL did not start');
}

/** ClickHouse through the docker CLI (no testcontainers module needed for it). */
async function startClickHouse(): Promise<string> {
  clickhouse = execFileSync('docker', [
    'run',
    '-d',
    '--rm',
    '-p',
    '127.0.0.1::8123',
    '-e',
    'CLICKHOUSE_USER=flags',
    '-e',
    'CLICKHOUSE_PASSWORD=flags',
    '-e',
    'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
    'clickhouse/clickhouse-server:24.8',
  ])
    .toString()
    .trim();
  const port = execFileSync('docker', ['port', clickhouse, '8123/tcp'])
    .toString()
    .trim()
    .split(':')
    .pop();
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/ping`)).ok) return url;
    } catch {
      // starting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('ClickHouse did not start');
}

export async function setup(): Promise<void> {
  let clickhouseUrl: string;
  let mysqlUrl: string;
  [postgres, redis, clickhouseUrl, mysqlUrl] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').start(),
    new RedisContainer('redis:7.4-alpine').start(),
    startClickHouse(),
    startMysql(),
  ]);
  process.env.FLAGS_TEST_MYSQL_URL = mysqlUrl;
  process.env.FLAGS_TEST_CLICKHOUSE_URL = clickhouseUrl;
  process.env.FLAGS_TEST_PG_URL = postgres.getConnectionUri();
  process.env.FLAGS_TEST_REDIS_URL = redis.getConnectionUrl();
}

export async function teardown(): Promise<void> {
  await Promise.all([postgres?.stop(), redis?.stop()]);
  for (const id of [clickhouse, mysql]) if (id) execFileSync('docker', ['stop', id]);
}

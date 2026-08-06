// GSD 08-04: type declarations for scripts/verify-redis-config.mjs.
// See scripts/lint-migrations.d.mts for why these exist.

export type RedisConfigMap = Record<string, string | null | undefined>;

export interface RedisConfigFailure {
  directive: string;
  expected: string;
  observed: string;
}

export interface RedisConfigResult {
  pass: boolean;
  failures: RedisConfigFailure[];
  observed: Record<string, string | null>;
}

export declare const REQUIRED_DIRECTIVES: readonly string[];

export function parseRedisUrl(raw: string): { host: string; port: number };
export function readRedisConfig(url: string, timeoutMs?: number): Promise<Record<string, string | null>>;
export function checkRedisConfig(config: RedisConfigMap): RedisConfigResult;

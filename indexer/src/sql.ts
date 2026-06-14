/**
 * Minimal SQL execution surface the Postgres read-model store depends on.
 * Keeping it as an interface lets `PgStore` be unit tested with a fake executor
 * (no live database) while `pgExecutor.ts` provides the node-postgres backing.
 */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

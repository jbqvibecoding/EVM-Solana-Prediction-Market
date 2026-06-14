import { Pool } from "pg";
import { SqlExecutor } from "./sql.js";

export interface PgExecutor extends SqlExecutor {
  close(): Promise<void>;
}

/** node-postgres backed {@link SqlExecutor}. The only module that imports `pg`. */
export function createPgExecutor(connectionString: string): PgExecutor {
  const pool = new Pool({ connectionString });
  return {
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> {
      const result = await pool.query(text, params as unknown[]);
      return result.rows as T[];
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

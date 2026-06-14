import { decodeProgramDataLogs } from "./events.js";
import { ReadModel, applyEvents } from "./projection.js";

/** A confirmed transaction's logs, as needed for indexing. */
export interface TxLogs {
  signature: string;
  slot: number;
  logs: string[];
}

/**
 * Source of new transaction logs for the indexed programs, oldest-first, after
 * the given cursor signature. Implemented over Solana RPC in rpcSource.ts; the
 * core ingest loop takes this interface so it can be tested with a mock.
 */
export interface LogSource {
  fetchSince(cursor: string | null): Promise<TxLogs[]>;
}

export interface Cursor {
  last: string | null;
}

/**
 * Pull one batch of transactions, project their events into the model, and
 * advance the cursor. Returns the number of transactions processed.
 */
export async function ingestOnce(
  source: LogSource,
  model: ReadModel,
  cursor: Cursor,
): Promise<number> {
  const txs = await source.fetchSince(cursor.last);
  for (const tx of txs) {
    const events = decodeProgramDataLogs(tx.logs);
    applyEvents(model, events, { signature: tx.signature, slot: tx.slot });
    cursor.last = tx.signature;
  }
  return txs.length;
}

/** Continuously poll `source` every `intervalMs` until `signal.stop` is set. */
export async function runIngestLoop(
  source: LogSource,
  model: ReadModel,
  cursor: Cursor,
  intervalMs: number,
  signal: { stop: boolean } = { stop: false },
): Promise<void> {
  while (!signal.stop) {
    try {
      await ingestOnce(source, model, cursor);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("ingest error", err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

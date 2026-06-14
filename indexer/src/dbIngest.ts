import { decodeProgramDataLogs } from "./events.js";
import { LogSource } from "./ingest.js";
import { Store } from "./store.js";

/**
 * DB-backed ingest: read the persisted cursor, pull new transactions, project
 * each event into the {@link Store}, and persist the advanced cursor. Cursor
 * lives in the store (ingest_cursor) so ingestion is resumable across restarts.
 */
export async function ingestOnceDb(source: LogSource, store: Store): Promise<number> {
  const cursor = await store.getCursor();
  const txs = await source.fetchSince(cursor);
  for (const tx of txs) {
    const events = decodeProgramDataLogs(tx.logs);
    for (const ev of events) {
      await store.applyEvent(ev, { signature: tx.signature, slot: tx.slot });
    }
    await store.setCursor(tx.signature);
  }
  return txs.length;
}

/** Continuously poll `source` every `intervalMs` until `signal.stop` is set. */
export async function runIngestLoopDb(
  source: LogSource,
  store: Store,
  intervalMs: number,
  signal: { stop: boolean } = { stop: false },
): Promise<void> {
  while (!signal.stop) {
    try {
      await ingestOnceDb(source, store);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("db ingest error", err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

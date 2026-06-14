import { Connection, PublicKey } from "@solana/web3.js";
import { LogSource, TxLogs } from "./ingest.js";

/**
 * LogSource backed by Solana RPC. Pulls recent signatures for the indexed
 * program addresses (newer than the cursor), fetches each transaction's logs,
 * and returns them oldest-first so projection is applied in order.
 */
export class RpcLogSource implements LogSource {
  constructor(
    private readonly connection: Connection,
    private readonly programs: PublicKey[],
    private readonly limit = 100,
  ) {}

  async fetchSince(cursor: string | null): Promise<TxLogs[]> {
    const seen = new Set<string>();
    const infos: { signature: string; slot: number }[] = [];

    for (const program of this.programs) {
      const sigs = await this.connection.getSignaturesForAddress(program, {
        until: cursor ?? undefined,
        limit: this.limit,
      });
      for (const s of sigs) {
        if (seen.has(s.signature)) continue;
        seen.add(s.signature);
        infos.push({ signature: s.signature, slot: s.slot });
      }
    }

    // Apply oldest-first.
    infos.sort((a, b) => a.slot - b.slot);

    const out: TxLogs[] = [];
    for (const info of infos) {
      const tx = await this.connection.getTransaction(info.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      out.push({
        signature: info.signature,
        slot: info.slot ?? tx?.slot ?? 0,
        logs: tx?.meta?.logMessages ?? [],
      });
    }
    return out;
  }
}

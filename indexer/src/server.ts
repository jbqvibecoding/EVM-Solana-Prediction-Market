import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Connection, PublicKey } from "@solana/web3.js";
import { handleRequest } from "./api.js";
import { Cursor, runIngestLoop } from "./ingest.js";
import { emptyModel } from "./projection.js";
import { RpcLogSource } from "./rpcSource.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function main(): Promise<void> {
  const connection = new Connection(requireEnv("RPC_URL"), "confirmed");
  const programs = [
    new PublicKey(requireEnv("EXCHANGE_PROGRAM_ID")),
    new PublicKey(requireEnv("CONDITIONAL_TOKEN_PROGRAM_ID")),
  ];
  const model = emptyModel();
  const cursor: Cursor = { last: process.env.START_CURSOR ?? null };
  const source = new RpcLogSource(connection, programs);
  const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? "3000");

  // Fire-and-forget ingest loop; the read model is updated in place.
  void runIngestLoop(source, model, cursor, intervalMs);

  const port = Number(process.env.PORT ?? "9200");
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const query: Record<string, string | undefined> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    const response = handleRequest(model, {
      method: req.method ?? "GET",
      path: url.pathname,
      query,
    });
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(JSON.stringify(response.body));
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`indexer listening on :${port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

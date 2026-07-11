import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Connection, PublicKey } from "@solana/web3.js";
import { ApiResponse, handleRequest } from "./api.js";
import { handleDbRequest } from "./dbApi.js";
import { runIngestLoopDb } from "./dbIngest.js";
import { Cursor, runIngestLoop } from "./ingest.js";
import { createPgExecutor } from "./pgExecutor.js";
import { PgStore } from "./pgStore.js";
import { emptyModel } from "./projection.js";
import { RpcLogSource } from "./rpcSource.js";

interface RouteRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
}

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
  // Optional: index the events_futures (spark markets) program when configured
  // (e.g. 7sech8m8biTTjb6e2UpdGx6wnnSqjMVyRFEVGPSvZ6sc once deployed).
  if (process.env.SPARK_FUTURES_PROGRAM_ID) {
    programs.push(new PublicKey(process.env.SPARK_FUTURES_PROGRAM_ID));
  }
  const source = new RpcLogSource(connection, programs);
  const intervalMs = Number(process.env.POLL_INTERVAL_MS ?? "3000");

  // Persistent (Postgres) read model when DATABASE_URL is set; otherwise the
  // in-memory model. Both serve identical routes and JSON shapes.
  const databaseUrl = process.env.DATABASE_URL;
  let route: (req: RouteRequest) => Promise<ApiResponse>;

  if (databaseUrl) {
    const store = new PgStore(createPgExecutor(databaseUrl));
    void runIngestLoopDb(source, store, intervalMs);
    route = (req) => handleDbRequest(store, req);
  } else {
    const model = emptyModel();
    const cursor: Cursor = { last: process.env.START_CURSOR ?? null };
    void runIngestLoop(source, model, cursor, intervalMs);
    route = async (req) => handleRequest(model, req);
  }

  const port = Number(process.env.PORT ?? "9200");
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const query: Record<string, string | undefined> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    route({ method: req.method ?? "GET", path: url.pathname, query })
      .then((response) => {
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(JSON.stringify(response.body));
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("request error", err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal error" }));
      });
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

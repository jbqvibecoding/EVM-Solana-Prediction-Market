import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ApiRequest, handleRequest } from "./api.js";
import { MatchingEngine } from "./engine.js";
import { OrderBook } from "./orderbook.js";
import { SolanaSettler } from "./solanaSettler.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function loadOperator(): Keypair {
  // OPERATOR_SECRET_KEY is a JSON array of bytes (solana keygen format).
  const raw = requireEnv("OPERATOR_SECRET_KEY");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
}

function buildEngine(): MatchingEngine {
  const connection = new Connection(requireEnv("RPC_URL"), "confirmed");
  const operator = loadOperator();
  const settler = new SolanaSettler(connection, operator, {
    exchangeProgramId: new PublicKey(requireEnv("EXCHANGE_PROGRAM_ID")),
    conditionalTokenProgramId: new PublicKey(
      requireEnv("CONDITIONAL_TOKEN_PROGRAM_ID"),
    ),
    collateralMint: new PublicKey(requireEnv("COLLATERAL_MINT")),
    feeAuthority: new PublicKey(requireEnv("FEE_AUTHORITY")),
  });
  return new MatchingEngine(new OrderBook(), settler);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  const engine = buildEngine();
  const port = Number(process.env.PORT ?? "9100");

  const server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const query: Record<string, string | undefined> = {};
        url.searchParams.forEach((value, key) => {
          query[key] = value;
        });

        let body: unknown;
        try {
          body = await readBody(req);
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
          return;
        }

        const apiReq: ApiRequest = {
          method: req.method ?? "GET",
          path: url.pathname,
          query,
          body,
        };
        const response = await handleRequest(engine, apiReq);
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(JSON.stringify(response.body));
      })();
    },
  );

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`matching-engine listening on :${port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

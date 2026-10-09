/**
 * The loopback HTTP listener that fronts handleCommandRequest.
 *
 * Loopback only, and a port conflict is never fatal: a second Live instance or
 * a stale host must not stop the context-menu actions from registering.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { AddressInfo } from "net";
import { handleCommandRequest, type CommandResponse, type Dispatcher } from "./endpoint.js";

/** Fixed so the Max device and Stream Deck can hardcode a URL. */
export const DEFAULT_PORT = 17818;

/** Env override, for running two Live instances side by side. */
export const PORT_ENV_VAR = "PT_CLIP_PORT";

export interface CommandEndpoint {
  port: number;
  address: string;
  close(): Promise<void>;
}

export interface ListenerOptions {
  port?: number | undefined;
  /** When set, requests must carry a matching `token=` query param. */
  token?: string | undefined;
}

export function portFromEnv(env: Record<string, string | undefined>): number | undefined {
  const raw = env[PORT_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

/**
 * Starts the endpoint. Resolves to null (never throws) if the port is taken.
 */
export async function startCommandEndpoint(
  deps: Dispatcher,
  opts: ListenerOptions = {},
): Promise<CommandEndpoint | null> {
  const port = opts.port ?? DEFAULT_PORT;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      }

      let out: CommandResponse;
      try {
        out = await handleCommandRequest(req.url ?? "/", headers, deps, opts.token);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        out = { status: 500, body: { ok: false, error: msg } };
      }

      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    })();
  });

  return new Promise<CommandEndpoint | null>((resolve) => {
    const onError = (e: NodeJS.ErrnoException) => {
      console.log(
        `[pt-clip-shortcuts] command endpoint unavailable on port ${port} ` +
          `(${e.code ?? e.message}); context-menu actions still work. ` +
          `Set ${PORT_ENV_VAR} to use another port.`,
      );
      server.close();
      resolve(null);
    };

    server.once("error", onError);

    // Loopback only. Never 0.0.0.0 — nothing on the network may reach this.
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const info = server.address() as AddressInfo;
      console.log(
        `[pt-clip-shortcuts] command endpoint listening on http://127.0.0.1:${info.port}/cmd`,
      );
      resolve({
        port: info.port,
        address: info.address,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

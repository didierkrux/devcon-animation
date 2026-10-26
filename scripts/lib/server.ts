// Small HTTP API next to the sync loop, so a run can be started on demand
// (e.g. right after the schedule changes) instead of waiting for the timer.
//
//   GET  /health                      -> 200 "ok" (no auth; for the container healthcheck)
//   GET  /status                      -> what's running, queued, next scheduled run, last run
//   POST /run                         -> queue a full run
//   POST /run {"codes":["RPAPTP"]}    -> queue a run limited to these talks (also ?codes=RPAPTP,KWXPU8)
//
// /status and /run need `Authorization: Bearer $TRIGGER_TOKEN`.
import { timingSafeEqual } from "node:crypto";
import http from "node:http";

export type TriggerResult = { queued: "all" | string[]; running: boolean };

export type ServerHandlers = {
  trigger(codes: string[] | null): TriggerResult;
  status(): object;
};

const MAX_BODY = 64 * 1024;
const CODE = /^[A-Z0-9]{1,32}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2) + "\n";
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
  res.end(text);
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseCodes(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const list = typeof raw === "string" ? raw.split(",") : raw;
  if (!Array.isArray(list) || !list.every((c) => typeof c === "string")) {
    throw new HttpError(400, `"codes" must be a list of talk codes`);
  }
  const codes = [...new Set(list.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  const bad = codes.filter((c) => !CODE.test(c));
  if (bad.length) throw new HttpError(400, `not talk codes: ${bad.join(", ")}`);
  return codes.length ? codes : null;
}

export function startServer(port: number, token: string | undefined, handlers: ServerHandlers): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /health") return send(res, 200, "ok");
      if (route !== "GET /status" && route !== "POST /run") throw new HttpError(404, "not found");
      if (!token) throw new HttpError(503, "TRIGGER_TOKEN is not set on the server");
      if (!authorized(req, token)) throw new HttpError(401, "missing or wrong bearer token");

      if (route === "GET /status") return send(res, 200, handlers.status());

      const body = await readBody(req);
      let json: { codes?: unknown } = {};
      if (body.trim()) {
        try {
          json = JSON.parse(body);
        } catch {
          throw new HttpError(400, "body must be JSON");
        }
      }
      const codes = parseCodes(json.codes ?? url.searchParams.get("codes") ?? undefined);
      send(res, 202, handlers.trigger(codes));
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error("HTTP error:", err);
      send(res, 500, { error: "internal error" });
    }
  });
  server.listen(port, () => {
    console.log(`HTTP trigger on :${port}${token ? "" : " (TRIGGER_TOKEN not set: only /health answers)"}`);
  });
  return server;
}

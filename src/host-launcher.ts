import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

type LaunchPayload = {
  macAppName?: string;
};

const host = process.env.HOST_LAUNCHER_HOST ?? "127.0.0.1";
const port = Number(process.env.HOST_LAUNCHER_PORT ?? "3848");

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let rawBody = "";

  for await (const chunk of request) {
    rawBody += String(chunk);
  }

  return rawBody ? JSON.parse(rawBody) : {};
}

async function openMacApp(macAppName: string): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Host launcher must run on macOS");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("open", ["-a", macAppName], {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `open exited with code ${code}`));
    });
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS"
    });
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { ok: true, host, port });
    return;
  }

  if (request.method !== "POST" || request.url !== "/api/desktop-apps/launch") {
    sendJson(response, 404, { ok: false, error: "Not found" });
    return;
  }

  const body = (await readJsonBody(request)) as LaunchPayload;
  const macAppName = typeof body.macAppName === "string" ? body.macAppName.trim() : "";

  if (!macAppName) {
    sendJson(response, 400, { ok: false, error: "Missing macAppName" });
    return;
  }

  await openMacApp(macAppName);
  console.log(`[${new Date().toISOString()}] opened ${macAppName}`);
  sendJson(response, 200, { ok: true, launched: true });
}

async function main(): Promise<void> {
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("HOST_LAUNCHER_PORT must be a positive number");
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      sendJson(response, 500, { ok: false, error: message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  console.log(`tabcoach host launcher listening on http://${host}:${port}/api/desktop-apps/launch`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});

import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRelayServer } from "./relay-server.js";
import { RelayRoom } from "./relay-room.js";

const host = getArg("--host") ?? process.env.HOST ?? "0.0.0.0";
const port = parseInt(getArg("--port") ?? process.env.PORT ?? "8080", 10);
const defaultLogFile = join(homedir(), ".paseo", "relay.log");
const logFile = getArg("--log") ?? process.env.RELAY_LOG ?? defaultLogFile;

// Set up file logging
mkdirSync(join(homedir(), ".paseo"), { recursive: true });
const stream = createWriteStream(logFile, { flags: "a" });
RelayRoom.fileLog = (line) => {
  stream.write(line + "\n");
};

const relay = createRelayServer({ host, port });

relay.start().then(() => {
  const msg = `tiny-paseo-relay listening on ${host}:${port}`;
  console.log(msg);
  console.log(`  Health: http://${host}:${port}/health`);
  console.log(`  WebSocket: ws://${host}:${port}/ws`);
  console.log(`  Log: ${logFile}`);
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down...");
  relay.stop().then(() => {
    process.exit(0);
  });
}

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

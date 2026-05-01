# AGENTS.md

## Project

tiny-paseo-relay — a lightweight Node.js WebSocket relay implementing the Paseo relay v2 protocol. It forwards end-to-end encrypted traffic between a mobile app (client) and a Paseo daemon (server). The relay only sees ciphertext.

## Build & Run

```bash
npm install
npm run build       # tsc → dist/
npm start           # node dist/index.js
npm run dev         # tsx src/index.ts (no build)

# CLI options
node dist/index.js --port 8443 --host 0.0.0.0 --log ~/.paseo/relay.log
```

Default port is 39217 via Dockerfile, or 8080 from source code. Use `--host 0.0.0.0` to bind all interfaces.

## Architecture

```
src/
  index.ts           # Entry point: CLI parsing, file logging, signal handling
  relay-server.ts    # HTTP server + WebSocket upgrade, room lifecycle
  relay-room.ts      # Core routing: tag-based socket indexing, frame buffering
  types.ts           # Shared type definitions
```

- `RelayRoom` — per-serverId room managing WebSocket connections for one daemon
- `createRelayServer` — factory that wires HTTP health checks, WS upgrade, and room GC
- Tag-based socket index (`server-control`, `server:<connId>`, `client:<connId>`)

## Endpoints

- `GET /health` → `{"status":"ok"}`
- `WebSocket /ws?serverId=...&role=server|client&connectionId=...&v=2`

## Conventions

- ESM only (`"type": "module"` in package.json)
- TypeScript, target ES2022, NodeNext module resolution
- Log via `RelayRoom.fileLog` static hook (set by index.ts)
- No external config files — all configuration via CLI flags or env vars
- Graceful shutdown on SIGTERM/SIGINT

## README Sync

**`README.md` and `README.zh.md` must always be updated together.** Any change to one must be mirrored in the other. The default README shown on GitHub is `README.md` (English). `README.zh.md` is the Chinese translation with identical structure and content.

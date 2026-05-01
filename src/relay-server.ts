import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Duplex } from "node:stream";
import { RelayRoom } from "./relay-room.js";
import type { ConnectionRole } from "./types.js";

const ROOM_IDLE_TIMEOUT_MS = 60_000;

export type RelayServerConfig = {
  host: string;
  port: number;
};

export function createRelayServer(config: RelayServerConfig) {
  const rooms = new Map<string, RelayRoom>();
  const roomIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const wss = new WebSocketServer({ noServer: true });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const serverId = url.searchParams.get("serverId");
    const role = url.searchParams.get("role") as ConnectionRole | null;
    const connectionId = url.searchParams.get("connectionId")?.trim() || null;
    const version = url.searchParams.get("v");

    if (!serverId) {
      socket.write("HTTP/1.1 400 Missing serverId\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!role || (role !== "server" && role !== "client")) {
      socket.write("HTTP/1.1 400 Missing or invalid role\r\n\r\n");
      socket.destroy();
      return;
    }

    if (version !== "2") {
      socket.write("HTTP/1.1 400 Only v=2 is supported\r\n\r\n");
      socket.destroy();
      return;
    }

    const room = getOrCreateRoom(serverId);

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      room.handleConnection(ws, { role, connectionId });
    });
  });

  function getOrCreateRoom(serverId: string): RelayRoom {
    // Cancel idle timer if room is being reused
    const existingTimer = roomIdleTimers.get(serverId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      roomIdleTimers.delete(serverId);
    }

    let room = rooms.get(serverId);
    if (room) return room;

    room = new RelayRoom(serverId);
    room.onEmpty = () => scheduleRoomCleanup(serverId);
    rooms.set(serverId, room);
    return room;
  }

  function scheduleRoomCleanup(serverId: string): void {
    const existing = roomIdleTimers.get(serverId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      roomIdleTimers.delete(serverId);
      const room = rooms.get(serverId);
      if (room && room.socketCount === 0) {
        room.destroy();
        rooms.delete(serverId);
      }
    }, ROOM_IDLE_TIMEOUT_MS);
    roomIdleTimers.set(serverId, timer);
  }

  function start(): Promise<void> {
    return new Promise((resolve) => {
      server.listen(config.port, config.host, () => {
        resolve();
      });
    });
  }

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const timer of roomIdleTimers.values()) {
        clearTimeout(timer);
      }
      roomIdleTimers.clear();

      for (const room of rooms.values()) {
        room.destroy();
      }
      rooms.clear();

      wss.close(() => {
        server.close(() => resolve());
      });
    });
  }

  return { start, stop, server };
}

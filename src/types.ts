import type { WebSocket } from "ws";

export type ConnectionRole = "server" | "client";

export type SocketAttachment = {
  serverId: string;
  role: ConnectionRole;
  connectionId: string | null;
  tags: string[];
  createdAt: number;
};

export type ControlMessage =
  | { type: "sync"; connectionIds: string[] }
  | { type: "connected"; connectionId: string }
  | { type: "disconnected"; connectionId: string }
  | { type: "pong"; ts: number };

export type TaggedSocket = {
  ws: WebSocket;
  attachment: SocketAttachment;
};

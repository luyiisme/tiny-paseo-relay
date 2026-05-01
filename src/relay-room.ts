import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import type { ConnectionRole, ControlMessage, SocketAttachment } from "./types.js";

const MAX_BUFFER_FRAMES = 200;
const NUDGE_INITIAL_DELAY_MS = 10_000;
const NUDGE_SECOND_DELAY_MS = 5_000;

export class RelayRoom {
  public readonly serverId: string;

  private sockets = new Map<WebSocket, SocketAttachment>();
  private socketsByTag = new Map<string, Set<WebSocket>>();
  private pendingFrames = new Map<string, Array<Buffer | string>>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private destroyed = false;

  /** Called when all sockets have disconnected. */
  onEmpty: (() => void) | null = null;

  constructor(serverId: string) {
    this.serverId = serverId;
  }

  // --- Public API ---

  handleConnection(
    ws: WebSocket,
    params: { role: ConnectionRole; connectionId: string | null },
  ): void {
    if (this.destroyed) return;

    const { role } = params;
    let connectionId = params.connectionId ?? null;

    // Assign connectionId for clients that don't provide one
    if (role === "client" && !connectionId) {
      connectionId = `conn_${randomBytes(8).toString("hex")}`;
    }

    const isServerControl = role === "server" && !connectionId;
    const isServerData = role === "server" && !!connectionId;

    // Replace existing sockets of the same identity
    if (isServerControl) {
      for (const existing of this.getSocketsByTag("server-control")) {
        this.closeSocket(existing, 1008, "Replaced by new connection");
      }
    } else if (isServerData) {
      for (const existing of this.getSocketsByTag(`server:${connectionId}`)) {
        this.closeSocket(existing, 1008, "Replaced by new connection");
      }
    }

    // Assign tags
    const tags: string[] = [];
    if (role === "client") {
      tags.push("client", `client:${connectionId}`);
    } else if (isServerControl) {
      tags.push("server-control");
    } else {
      tags.push("server", `server:${connectionId}`);
    }

    const attachment: SocketAttachment = {
      serverId: this.serverId,
      role,
      connectionId,
      tags,
      createdAt: Date.now(),
    };

    this.addSocket(ws, attachment);
    this.log(`[connect] ${role}${connectionId ? `:${connectionId}` : "(control)"} tags=[${tags}]`);

    // Wire up event handlers
    ws.on("message", (data, isBinary) => {
      const message = isBinary ? (data as Buffer) : data.toString();
      this.handleMessage(ws, message);
    });

    ws.on("close", (code, reason) => {
      this.log(`[close] ${role}${connectionId ? `:${connectionId}` : "(control)"} code=${code} reason=${reason}`);
      this.handleClose(ws, code, reason.toString());
    });

    ws.on("error", (err) => {
      this.log(`[error] ${role}${connectionId ? `:${connectionId}` : "(control)"} ${err.message}`);
    });

    // Post-connect actions
    if (role === "client") {
      this.notifyControls({ type: "connected", connectionId: connectionId! });
      this.nudgeOrResetControlForConnection(connectionId!);
    } else if (isServerControl) {
      this.sendToSocket(ws, JSON.stringify({
        type: "sync",
        connectionIds: this.listConnectedConnectionIds(),
      } satisfies ControlMessage));
    } else if (isServerData && connectionId) {
      this.flushFrames(connectionId, ws);
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const ws of this.sockets.keys()) {
      this.closeSocket(ws, 1001, "Relay shutting down");
    }
    this.sockets.clear();
    this.socketsByTag.clear();
    this.pendingFrames.clear();
  }

  get socketCount(): number {
    return this.sockets.size;
  }

  private log(msg: string): void {
    const line = `[${new Date().toISOString()}] [${this.serverId}] ${msg}`;
    console.log(line);
    RelayRoom.fileLog?.(line);
  }

  static fileLog: ((line: string) => void) | null = null;

  // --- Message handling ---

  private handleMessage(ws: WebSocket, message: Buffer | string): void {
    const attachment = this.sockets.get(ws);
    if (!attachment) return;

    const { role, connectionId } = attachment;

    // Control channel: no connectionId
    if (!connectionId) {
      if (typeof message === "string") {
        try {
          const parsed = JSON.parse(message) as { type?: string };
          if (parsed?.type === "ping") {
            this.sendToSocket(ws, JSON.stringify({ type: "pong", ts: Date.now() }));
          }
        } catch {
          // Ignore non-JSON control payloads
        }
      }
      return;
    }

    const len = typeof message === "string" ? message.length : message.length;
    const preview = typeof message === "string" ? message.slice(0, 80) : `<binary ${len}B>`;

    // Client → server data socket
    if (role === "client") {
      const servers = this.getSocketsByTag(`server:${connectionId}`);
      if (servers.length === 0) {
        this.log(`[msg] client→server ${connectionId} BUFFERED len=${len}`);
        this.bufferFrame(connectionId, message);
        return;
      }
      this.log(`[msg] client→server ${connectionId} len=${len} preview=${preview}`);
      for (const target of servers) {
        this.sendToSocket(target, message);
      }
      return;
    }

    // Server data socket → all clients
    const clients = this.getSocketsByTag(`client:${connectionId}`);
    this.log(`[msg] server→client ${connectionId} len=${len} targets=${clients.length} preview=${preview}`);
    for (const target of clients) {
      this.sendToSocket(target, message);
    }
  }

  // --- Close handling ---

  private handleClose(ws: WebSocket, _code: number, _reason: string): void {
    const attachment = this.sockets.get(ws);
    if (!attachment) return;

    this.removeSocket(ws);

    const { role, connectionId } = attachment;

    if (role === "client" && connectionId) {
      // Check if there are remaining client sockets for this connectionId
      const remaining = this.getSocketsByTag(`client:${connectionId}`);
      if (remaining.length > 0) return;

      // Last client disconnected: clean up
      this.pendingFrames.delete(connectionId);

      // Close matching server data socket
      for (const serverWs of this.getSocketsByTag(`server:${connectionId}`)) {
        this.closeSocket(serverWs, 1001, "Client disconnected");
      }

      this.notifyControls({ type: "disconnected", connectionId });
    } else if (role === "server" && connectionId) {
      // Server data disconnected: close all matching client sockets
      for (const clientWs of this.getSocketsByTag(`client:${connectionId}`)) {
        this.closeSocket(clientWs, 1001, "Server disconnected");
      }
    }

    if (this.sockets.size === 0) {
      this.onEmpty?.();
    }
  }

  // --- Nudge/reset logic ---

  private nudgeOrResetControlForConnection(connectionId: string): void {
    const timer1 = setTimeout(() => {
      this.timers.delete(timer1);
      if (this.destroyed) return;
      if (!this.hasClientSocket(connectionId)) return;
      if (this.hasServerDataSocket(connectionId)) return;

      // Nudge: send sync
      this.notifyControls({
        type: "sync",
        connectionIds: this.listConnectedConnectionIds(),
      });

      const timer2 = setTimeout(() => {
        this.timers.delete(timer2);
        if (this.destroyed) return;
        if (!this.hasClientSocket(connectionId)) return;
        if (this.hasServerDataSocket(connectionId)) return;

        // Force close control
        for (const ws of this.getSocketsByTag("server-control")) {
          this.closeSocket(ws, 1011, "Control unresponsive");
        }
      }, NUDGE_SECOND_DELAY_MS);
      this.timers.add(timer2);
    }, NUDGE_INITIAL_DELAY_MS);
    this.timers.add(timer1);
  }

  // --- Frame buffering ---

  private bufferFrame(connectionId: string, message: Buffer | string): void {
    const existing = this.pendingFrames.get(connectionId) ?? [];
    existing.push(message);
    if (existing.length > MAX_BUFFER_FRAMES) {
      existing.splice(0, existing.length - MAX_BUFFER_FRAMES);
    }
    this.pendingFrames.set(connectionId, existing);
  }

  private flushFrames(connectionId: string, serverWs: WebSocket): void {
    const frames = this.pendingFrames.get(connectionId);
    if (!frames || frames.length === 0) return;
    this.pendingFrames.delete(connectionId);

    // Deduplicate e2ee_hello: client retries hello while waiting for server
    // data socket. Daemon expects exactly ONE hello. Keep only the last one.
    const deduped = this.dedupeHelloFrames(frames);

    for (const frame of deduped) {
      if (!this.sendToSocket(serverWs, frame)) {
        this.bufferFrame(connectionId, frame);
        break;
      }
    }
  }

  private dedupeHelloFrames(frames: Array<Buffer | string>): Array<Buffer | string> {
    let lastHelloIndex = -1;
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i];
      if (typeof f === "string" && f.includes('"e2ee_hello"')) {
        lastHelloIndex = i;
        break;
      }
    }
    if (lastHelloIndex <= 0) return frames;

    // Drop all hello frames except the last one
    const result: Array<Buffer | string> = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (i < lastHelloIndex && typeof f === "string" && f.includes('"e2ee_hello"')) {
        this.log(`[flush] dropping duplicate e2ee_hello frame ${i}`);
        continue;
      }
      result.push(f);
    }
    return result;
  }

  // --- Helpers ---

  private hasServerDataSocket(connectionId: string): boolean {
    return this.getSocketsByTag(`server:${connectionId}`).length > 0;
  }

  private hasClientSocket(connectionId: string): boolean {
    return this.getSocketsByTag(`client:${connectionId}`).length > 0;
  }

  private listConnectedConnectionIds(): string[] {
    const ids = new Set<string>();
    for (const attachment of this.sockets.values()) {
      if (attachment.role === "client" && attachment.connectionId) {
        ids.add(attachment.connectionId);
      }
    }
    return Array.from(ids);
  }

  private notifyControls(message: ControlMessage): void {
    const text = JSON.stringify(message);
    for (const ws of this.getSocketsByTag("server-control")) {
      if (!this.sendToSocket(ws, text)) {
        this.closeSocket(ws, 1011, "Control send failed");
      }
    }
  }

  private sendToSocket(ws: WebSocket, data: Buffer | string): boolean {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
        return true;
      }
    } catch {
      // Ignore send errors
    }
    return false;
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Ignore close errors
    }
  }

  // --- Tag-based socket index ---

  private addSocket(ws: WebSocket, attachment: SocketAttachment): void {
    this.sockets.set(ws, attachment);
    for (const tag of attachment.tags) {
      let set = this.socketsByTag.get(tag);
      if (!set) {
        set = new Set();
        this.socketsByTag.set(tag, set);
      }
      set.add(ws);
    }
  }

  private removeSocket(ws: WebSocket): void {
    const attachment = this.sockets.get(ws);
    if (!attachment) return;
    this.sockets.delete(ws);
    for (const tag of attachment.tags) {
      const set = this.socketsByTag.get(tag);
      if (set) {
        set.delete(ws);
        if (set.size === 0) this.socketsByTag.delete(tag);
      }
    }
  }

  private getSocketsByTag(tag: string): WebSocket[] {
    const set = this.socketsByTag.get(tag);
    return set ? Array.from(set) : [];
  }
}

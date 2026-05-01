# tiny-paseo-relay

Lightweight WebSocket relay for Paseo network nodes. Self-hosted relay for remote Claude Code control via mobile app within a private network.

> 中文用户请阅读 [README.zh.md](./README.zh.md)

## Architecture

```
Phone(VPN) → self-hosted relay(LAN) → Paseo daemon(LAN) → Claude Code
```

## Why Self-Hosted Relay

### Pain Points

When traveling (trains, airports, etc.), you want to control Claude Code from your phone (multi-tasking, notifications), but:

- **Unstable network**: Cellular signal drops frequently on trains. VPN reconnects disrupt sessions, and remote CC task latency is unpredictable.
- **Security compliance**: Only company VPN-authorized machines and devices are allowed. Any public VPN or relay outside the boundary is non-compliant.
- **Daemon direct mode is insecure**: In direct mode, the daemon listens on a port. Internal port scans can discover it, and there is no access control, risking unauthorized access.

### Comparison

| Mode | Daemon port open | Auth control | External dependency | Use case |
|------|:---:|:---:|:---:|------|
| Daemon direct | Yes | None | None | Local dev, same subnet |
| 3rd-party public relay | No | Relay decides | Yes | Quick trial, low security |
| **Self-hosted relay** | No | Network boundary | No | Production, compliance |

### Security Model

- **Daemon has no inbound ports**: In relay mode, daemon connects outbound to the relay as a WebSocket client. Zero inbound exposure.
- **E2E encryption**: All traffic between App and daemon is encrypted end-to-end. The relay only forwards ciphertext.
- **No public exposure**: Both relay and daemon run inside the private network. Phones connect via VPN.
- **No changes to Paseo**: Implements the Paseo relay v2 protocol. The daemon and App work natively.

## Project Structure

```
src/
  types.ts          # Type definitions
  relay-room.ts     # Core routing logic (Node.js port of Paseo Cloudflare relay)
  relay-server.ts   # HTTP + WebSocket server
  index.ts          # Entry point
```

## Quick Start

```bash
cd tiny-paseo-relay
npm install
npm run build
node dist/index.js --port 8443
```

Dev mode (no build needed):

```bash
npm run dev -- --port 8443 --host 0.0.0.0
```

## Docker

### Build

```bash
docker build -t tiny-paseo-relay .
```

### Run

```bash
# Default port 39217
docker run -d --name relay -p 39217:39217 tiny-paseo-relay

# Custom port and log directory
docker run -d --name relay \
  -p 39217:39217 \
  -e PORT=39217 \
  -e RELAY_LOG=/app/log/relay.log \
  -v /path/to/log:/app/log \
  tiny-paseo-relay
```

### Configuration

| Argument | Env variable | Default | Description |
|------|---------|--------|------|
| `--port` | `PORT` | `39217` | Listening port |
| `--host` | `HOST` | `0.0.0.0` | Listening address |
| `--log` | `RELAY_LOG` | `~/.paseo/relay.log` | Log file path |

> ⚠️ Default `HOST=0.0.0.0` binds to all network interfaces. On multi-NIC machines (e.g., one internal and one public interface), specify a private IP (e.g., `--host 192.168.1.100`) to avoid unintended network exposure. The relay has no built-in authentication; security relies on network boundary control.

## Using with Paseo Daemon

```bash
# 1. Start the relay
cd tiny-paseo-relay
node dist/index.js --port 8443

# 2. Start the daemon (in another terminal), replacing with your LAN IP
PASEO_RELAY_ENDPOINT=192.168.x.x:8443 paseo daemon start --foreground

# 3. Generate a pairing QR code (another terminal)
PASEO_RELAY_ENDPOINT=192.168.x.x:8443 paseo daemon pair

# 4. Phone → VPN → Paseo App → paste the pairing link from step 3
```

Using Paseo from source:

```bash
cd /path/to/paseo
PASEO_RELAY_ENDPOINT=192.168.x.x:8443 npm run cli -- daemon start --foreground
PASEO_RELAY_ENDPOINT=192.168.x.x:8443 npm run cli -- daemon pair
```

## Deploy

```bash
cd ~/tiny-paseo-relay
npm run build
nohup node dist/index.js --port 39217 --host <YOUR_HOST_IP> --log ~/relay.log > ~/relay-stdout.log 2>&1 &
echo $! > ~/relay.pid
```

Stop:

```bash
kill $(cat ~/relay.pid)
```

## Logs

| File | Content |
|------|---------|
| `~/relay.log` | Structured relay events |
| `~/relay-stdout.log` | stdout/stderr |

## Endpoints

- Health: `http://<host>:39217/health`
- WebSocket: `ws://<host>:39217/ws`

## Verified

- Relay bidirectional forwarding: OK
- Daemon connecting to relay: OK
- Mobile app connecting to daemon via relay: OK
- E2E encryption handshake: OK
- Agent creation and prompt sending: OK

## Security Model

```
Phone(VPN) ──E2E──→ relay:39217 ←──E2E── daemon (no inbound ports)
                      ↑
            Port scans only see relay.
            All traffic is encrypted — no MITM possible.
```

- **Daemon has no listening port**: In relay mode, daemon connects outbound. No inbound ports are opened.
- **E2E encryption**: The relay only forwards ciphertext. It cannot decrypt or tamper with communications.
- **Single point of exposure**: Only relay port 39217 is exposed, and it only forwards encrypted traffic.

### Mode Comparison

| Mode | Daemon behavior | Port exposure | Use case |
|------|------------|---------|---------|
| Direct (no relay) | Daemon runs its own HTTP/WebSocket server | Yes, accessible within LAN | Local dev, same subnet |
| Relay mode | Daemon connects to relay as WebSocket client | None | Remote access via VPN, multi-node mesh |

## Protocol Reference

Paseo relay protocol details:
- Official Paseo relay implementation (`packages/relay/src/cloudflare-adapter.ts`) — Cloudflare Durable Object version
- Daemon-to-relay connection logic (`packages/server/src/server/relay-transport.ts`)
- Security model and E2E encryption (`SECURITY.md`)

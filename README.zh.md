# tiny-paseo-relay

轻量级 WebSocket relay，Paseo 网络节点的自建中继服务器。用于在内网通过手机 App 远程控制 Claude Code。

> English version: [README.md](./README.md)

## 架构

```
手机(VPN) → 自建relay(内网) → Paseo daemon(内网) → Claude Code
```

## 为什么需要自建 Relay

### 场景痛点

出差途中（高铁、机场等场景）想随时用手机操控 Claude Code（多任务窗口与提醒），但：

- **网络不稳定**：高铁/地铁信号断断续续，VPN 频繁断开重连，本机 CC 任务延迟不可控
- **安全合规要求**：仅限公司 VPN 范围内的机器与授权设备，其他任何走公网的 VPN 或中继均不合规
- **daemon 直连模式不安全**：直连模式下 daemon 自己监听端口，内网端口扫描即可发现，无认证接入控制，存在被未授权访问的风险

### 方案对比

| 方式 | daemon 端口暴露 | 认证控制 | 外部依赖 | 适用场景 |
|------|:---:|:---:|:---:|------|
| daemon 直连 | 是 | 无 | 无 | 本地开发、同网段可直连 |
| 第三方公网 relay | 否 | relay 决定 | 有 | 快速体验、无安全要求 |
| **自建 relay** | 否 | 网络边界控制 | 无 | 生产使用、有安全合规要求 |

### 自建 relay 的安全闭环

- **daemon 不监听端口**：relay 模式下 daemon 作为 WebSocket 客户端主动连接 relay，零入站端口
- **E2E 加密**：App 和 daemon 之间全程加密，relay 只转发密文
- **零公网暴露**：relay + daemon 都在内网，手机通过 VPN 接入
- **无需改 Paseo 代码**：实现了 Paseo relay v2 协议，daemon 和 App 原生兼容

## 项目结构

```
src/
  types.ts          # 类型定义
  relay-room.ts     # 核心路由逻辑（Paseo cloudflare relay 的 Node.js 移植）
  relay-server.ts   # HTTP + WebSocket 服务器
  index.ts          # 入口
```

## Quick Start

```bash
cd tiny-paseo-relay
npm install
npm run build
node dist/index.js --port 8443
```

Dev 模式（免构建）：

```bash
npm run dev -- --port 8443 --host 0.0.0.0
```

## Docker

### 构建

```bash
docker build -t tiny-paseo-relay .
```

### 运行

```bash
# 默认端口 39217
docker run -d --name relay -p 39217:39217 tiny-paseo-relay

# 指定端口和日志目录
docker run -d --name relay \
  -p 39217:39217 \
  -e PORT=39217 \
  -e RELAY_LOG=/app/log/relay.log \
  -v /path/to/log:/app/log \
  tiny-paseo-relay
```

### 配置参数

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `--port` | `PORT` | `39217` | 监听端口 |
| `--host` | `HOST` | `0.0.0.0` | 监听地址 |
| `--log` | `RELAY_LOG` | `~/.paseo/relay.log` | 日志文件路径 |

> ⚠️ `HOST` 默认为 `0.0.0.0`（监听所有网卡）。如果宿主机有多网卡（例如一张内网、一张公网），建议指定内网 IP（如 `--host 192.168.1.100`），避免 relay 被非预期网络访问到。relay 本身无认证机制，安全依赖网络边界控制。

## 配合 Paseo daemon 使用

```bash
# 1. 启动 relay
cd tiny-paseo-relay
node dist/index.js --port 8443

# 2. 启动 daemon（另一个终端），用你的内网 IP 替换
PASEO_RELAY_ENDPOINT=192.168.x.x:8443 paseo daemon start --foreground

# 3. 生成手机配对二维码（另一个终端）
PASEO_RELAY_ENDPOINT=192.168.x.x:8443 paseo daemon pair

# 4. 手机连 VPN → Paseo App → 粘贴步骤3输出的链接
```

如果用 Paseo 源码运行 daemon：

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

停止：

```bash
kill $(cat ~/relay.pid)
```

## Logs

| 文件 | 内容 |
|------|---------|
| `~/relay.log` | 结构化 relay 事件 |
| `~/relay-stdout.log` | stdout/stderr |

## Endpoints

- Health: `http://<host>:39217/health`
- WebSocket: `ws://<host>:39217/ws`

## 已验证状态

- relay 双向转发：通过
- daemon 连接 relay：通过
- 手机 App 通过 relay 连接 daemon：通过
- E2E 加密握手：通过
- Agent 创建和 prompt 发送：通过

## 安全模型

```
手机(VPN) ──E2E──→ relay:39217 ←──E2E── daemon (无入站端口)
                      ↑
            端口扫描只能看到 relay
            流量全程加密，无法介入
```

- **daemon 不监听端口**：relay 模式下 daemon 作为 WebSocket 客户端主动连接 relay，无入站端口
- **E2E 加密**：relay 只转发密文，无法解密或篡改通信内容
- **单点暴露**：仅 relay 39217 端口对外开放，且只转发加密流量

### 两种模式对比

| 模式 | daemon 行为 | 端口暴露 | 适用场景 |
|------|------------|---------|---------|
| 直连模式（无 relay） | daemon 自己起 HTTP/WebSocket 服务 | 有，内网可直连 | 本地开发、同网段使用 |
| Relay 模式 | daemon 作为 WebSocket 客户端连 relay | 无 | 手机 VPN 远程访问、多节点组网 |

## 原理参考

Paseo relay 协议详见：
- Paseo 官方 relay 实现（`packages/relay/src/cloudflare-adapter.ts`）— Cloudflare Durable Object 版本
- Daemon 连接 relay 的逻辑（`packages/server/src/server/relay-transport.ts`）
- 安全模型和 E2E 加密说明（`SECURITY.md`）

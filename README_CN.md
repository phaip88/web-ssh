# WebSSH Agent Console (中文说明)

[English](README.md) · **中文**

基于浏览器的 SSH 终端平台，内置**策略管控的 AI 运维 Agent**。Agent 的所有操作均经过声明式工具注册表、Shell 语法感知策略引擎、人工审批流以及具备防篡改特性的审计日志。

> 当前状态：**垂直切片可用**（登录认证 → 主机与凭证管理 → Web SSH → AI 分析诊断 → 人工审批 → 命令执行 → 审计日志）。

---

## 快速上手（本地开发）

```bash
# 1. 复制环境变量配置文件（开发环境 APP_MASTER_KEY 可暂留空）
cp .env.example .env

# 2. 启动 PostgreSQL 16 数据库
docker compose -f docker-compose.dev.yml up -d postgres

# 3. 安装依赖
npm ci

# 4. 初始化数据库表结构
npx drizzle-kit push

# 5. 注入测试数据（租户、用户、模拟主机、模拟 LLM、审计触发器）
npx tsx scripts/seed.ts

# 6. 启动开发服务器（访问 http://localhost:3000，内置模拟 SSH 监听 127.0.0.1:2222）
npm run dev
```

### 内置测试账号（仅限开发环境）：

| 账号 | 密码 | 角色与权限 |
|---|---|---|
| `admin@example.com` | `ChangeMe-Admin-2026` | 组织所有者 / 工作区管理员 / 平台管理员 |
| `dev@example.com` | `ChangeMe-Dev-2026` | 开发者（禁止访问生产环境主机） |
| `auditor@example.com` | `ChangeMe-Dev-2026` | 审计员（仅限审计日志与会话回放） |

---

## 常用开发命令

| 任务 | 命令 |
|---|---|
| 启动开发服务器 | `npm run dev` |
| 类型检查与代码规范检查 | `npx tsc --noEmit` / `npm run lint` |
| 运行单元测试与集成测试 | `npx vitest run` |
| 推送数据库表结构 | `npx drizzle-kit push` |
| 注入测试数据种子 | `npx tsx scripts/seed.ts` |
| 生产环境构建与启动 | `npm run build && npm start` |

---

## 核心已实现功能

- **身份认证与多租户隔离**：基于 scrypt 的本地账户、HttpOnly/SameSite Cookie 会话机制、账户防爆破锁定、Origin 来源 CSRF 防护、多组织与多工作区模型、RBAC（7 种内置角色）+ ABAC 访问控制。
- **安全 SSH 管理**：主机资产维护（支持标签、环境分类、收藏夹、JSON 导入导出）、AES-256-GCM 信封加密凭证管理（结合 AAD 绑定）、严格的主机密钥指纹比对与告警（支持首次连接确认 TOFU 机制）、空闲断开与超时保护。
- **终端流控网关**：基于 `ssh2` 与 Xterm.js、统一通信协议封装、基于 Server-Sent Events (SSE) 与环形缓冲区断线重连、背压流量控制、包含敏感输入掩码（如密码输入脱敏）的追加式会话录像与回放、管理员强制切断会话。
- **策略级运维 Agent**：支持 ask / suggest / approval / auto / plan 多种交互模式（默认审批模式）；声明式工具注册表（JSON Schema 校验、执行时限与输出截断）；基于 Shell AST 语法的危险指令分级判定引擎（R0–R4 分级、针对管道、重定向、sudo、编码绕过、反弹 shell 与数据外发等进行阻断与拦截）；带有效期的审批工单；滑动窗口上下文与用量核算。
- **LLM 网关与安全防护**：统一适配器架构（内置 Mock、OpenAI 兼容接口与 Anthropic）；严密的 SSRF 防护（拦截私有网段、本地链路、云元数据地址并执行重定向防绕过校验）；凭证密文存储；熔断与指数退避重试。
- **不可篡改审计链路**：基于 PostgreSQL 触发器强制拦截针对审计表的 UPDATE 与 DELETE 操作，事件写入通过哈希链（Hash Chain）连续签名，提供防篡改校验端点与 CSV 导出功能。
- **容器与交付工程化**：极简 Distroless 非 root 运行时 Dockerfile、Docker Compose 配置、Helm Chart 支持、以及集成 CodeQL、Trivy、SBOM 与 Cosign 签名的 GitHub Actions CI/CD 流水线。

---

## 架构与深入文档

- 架构设计：[ARCHITECTURE.md](ARCHITECTURE.md)
- 安全与威胁模型：[SECURITY.md](SECURITY.md) · [THREAT_MODEL.md](THREAT_MODEL.md)
- 部署与开发指南：[DEPLOYMENT.md](DEPLOYMENT.md) · [DEVELOPMENT.md](DEVELOPMENT.md)
- 协议与扩展规范：[docs/WEBSOCKET_PROTOCOL.md](docs/WEBSOCKET_PROTOCOL.md) · [docs/openapi.yaml](docs/openapi.yaml) · [docs/SKILL_SDK.md](docs/SKILL_SDK.md) · [docs/MCP.md](docs/MCP.md) · [docs/PLUGIN_SDK.md](docs/PLUGIN_SDK.md)
- 运维故障排查手册：[docs/RUNBOOK.md](docs/RUNBOOK.md)

# Persistent SSH Operations

Persistent SSH Operations 是一个面向 Codex 的开源 Skill 与本地 Broker。它解决智能体执行连续远程命令时，每次调用都重新完成 SSH 握手所带来的延迟、限流和不稳定问题。Persistent SSH Operations is an open-source Codex skill and local broker. It solves the latency, throttling, and instability caused when agents perform a full SSH handshake for every remote command.

[English](README.en.md)

## 为什么需要这个 Skill

人在终端里登录服务器后，通常会在同一个 shell 中连续工作；智能体却经常把一次运维任务拆成许多彼此独立的工具调用：

```text
检查 Git 状态 → 查看服务状态 → 读取日志 → 执行部署 → 再次健康检查
```

如果每条命令都调用一次普通 `ssh`，就会重复经历 DNS、TCP 建连、SSH 密钥交换、host key 校验和用户认证。远程命令可能只运行几十毫秒，建立连接却可能花费数秒。

这会产生四类直接痛点：

| 痛点 | 实际影响 |
| --- | --- |
| 重复握手延迟 | 十几条短命令累积成明显等待，智能体反馈变慢。 |
| 云主机连接限流 | 高频新连接可能触发 SSH `MaxStartups`、安全策略或云平台限流。 |
| 长任务稳定性下降 | 部署、排障和验收过程中更容易遇到偶发握手失败。 |
| 粗糙复用带来安全倒退 | 自动接受新 host key、断线后盲目重试写命令，都可能把性能优化变成安全问题。 |

因此，核心问题不是“怎样再封装一次 SSH 命令”，而是：

> 怎样让智能体连续执行远程命令时复用已经认证的传输连接，同时不弱化主机身份验证、操作授权和失败处理？

## 它怎样解决问题

这个 Skill 把“如何安全使用”与“如何保持连接”分成两层：

- Codex Skill 负责判断何时值得复用连接，并约束 host key 核验、授权、秘密传递和失败恢复。
- 本地 Broker 为每个 profile 维持一条已认证的 `ssh2` 连接。
- 每条远程命令只在现有连接上新建一个 SSH channel，不再重新握手。
- keepalive 和指数退避负责恢复传输连接，但绝不自动重放结果不确定的命令。
- profile、host key、队列、结果和日志全部保存在仓库外。

实际效果是：第一次连接完成认证后，后续的状态检查、日志读取、部署步骤和健康验证可以继续使用同一条连接。复用的是 SSH 传输层，不是用户授权。

## 什么时候应该使用

适合：

- 同一个任务需要在同一台服务器上连续执行三条或更多命令。
- SSH 握手明显慢于远程命令本身。
- 云主机对短时间内的新连接数量敏感。
- Codex 正在执行部署、排障、日志检查、服务控制或连续验收。

不适合：

- 偶尔执行一条简单的远程命令。
- 需要交互式 shell、TTY 或在终端中输入秘密。
- 需要 SFTP/SCP、端口转发或密码认证。
- 希望断线后自动重试非幂等写操作。

## 关键特性

- 每个 profile 维持一条 `ssh2` 连接，每条命令只新建 channel。
- 30 秒 keepalive，断线后自动恢复传输连接。
- 首次或变化的 host key 必须核验并显式批准。
- 命令按 profile 串行执行，不因超时或断线自动重试。
- 配置、host key、队列、结果和日志全部保存在仓库外。
- 远程退出码原样返回，便于脚本和 Codex 判断结果。

## 要求

- Windows PowerShell 5.1+
- Node.js 20+
- npm
- 私钥认证，或通过 `SSH_AUTH_SOCK` 暴露的 SSH agent

## 快速开始

安装依赖：

```powershell
npm.cmd ci --ignore-scripts --omit=dev
```

查看本机配置路径：

```powershell
.\scripts\persistent-ssh.ps1 config-path
```

将 `config.example.json` 复制到该位置，填写本机 profile。首次连接会停在 `hostkey-pending`：

```powershell
.\scripts\persistent-ssh.ps1 start production
.\scripts\persistent-ssh.ps1 hostkey-show production
.\scripts\persistent-ssh.ps1 hostkey-approve production -Fingerprint 'SHA256:<verified-fingerprint>'
.\scripts\persistent-ssh.ps1 exec production 'uname -a' -TimeoutSec 60
```

必须通过云厂商控制台、已有可信 `known_hosts` 或独立管理员渠道核验指纹。不要把密码、Token 或私钥放入远程命令参数。

Codex 的完整操作规则见 [SKILL.md](SKILL.md)，配置和退出码见 [references/operations.md](references/operations.md)。

## 当前边界

首版不提供交互式 shell、SFTP/SCP、端口转发、密码认证或 MCP 接口。Broker 优化连接复用，不扩大任何远程操作授权。

## 验证

```powershell
npm.cmd test
npm.cmd run check:syntax
```

## 许可证

[MIT](LICENSE)

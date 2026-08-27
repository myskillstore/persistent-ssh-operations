# Persistent SSH Operations

Persistent SSH Operations 是一个面向 Codex 的开源 Skill 与本地 Broker，通过复用已认证 SSH 连接，让 Windows 上的连续远程运维更快、更稳定。Persistent SSH Operations is an open-source Codex skill and local broker that makes repeated Windows-to-server operations faster and more reliable by reusing authenticated SSH connections.

[English](README.en.md)

它适合部署检查、服务状态核验和多条顺序运维命令，尤其适用于重复 SSH 握手较慢或容易触发云主机限流的场景。

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

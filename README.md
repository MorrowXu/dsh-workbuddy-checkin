<div align="right">

**中文** · [English](#english)

</div>

# WorkBuddy 一键打卡 · dsh-workbuddy-checkin

> 在 DSH（DeepSeek Harness）的侧边栏里放一个 WorkBuddy 打卡入口：看得见登录状态，点一下领今天的积分，顺手看到连登天数和剩余余额。

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4d6bfe)
![dsh](https://img.shields.io/badge/DSH-bundle%20plugin-4d6bfe)
![node](https://img.shields.io/badge/node-%E2%89%A520-339933)
![license](https://img.shields.io/badge/license-MIT-green)

这是一个 DSH **bundle 插件**，不是独立应用。它复用你桌面上 WorkBuddy 国内版客户端**已经存在的登录**，不新开登录流程，不替你自动签到，只在你按下按钮时打这一次卡。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [功能](#功能)
- [界面与状态](#界面与状态)
- [工作原理](#工作原理)
- [安装](#安装)
- [配置](#配置)
- [HTTP 接口](#http-接口)
- [数据文件](#数据文件)
- [上游接口](#上游接口)
- [凭据与解密](#凭据与解密)
- [项目结构](#项目结构)
- [开发与测试](#开发与测试)
- [已知限制](#已知限制)
- [隐私](#隐私)
- [许可证](#许可证)

---

## 它解决什么问题

WorkBuddy 国内版有每日签到领积分，入口在客户端里，一天点一次，很容易忘。把它塞进 DSH 侧边栏之后，它就在你写代码的地方旁边：状态是常量可见的（今天打没打），动作是一次点击。

设计上刻意做小的三件事：

1. **不新开登录**。直接用客户端已经落盘的凭据，因此不存在"插件里再登一次"的账号割裂。
2. **不偷偷打卡**。默认只有你点按钮才发请求；`autoCheckinOnOpen` 打开后也只在你打开面板且跨天时补一次。
3. **不隐藏入口**。未登录、凭据坏掉、请求失败都保留入口并写清原因——一个会消失的入口既点不到也解释不了自己。

## 功能

- **登录状态检测**：读取 WorkBuddy 桌面客户端的共享登录目录，只读、不启动 App。
- **一键打卡**：多账号同时处理，同一天不重复请求，已完成/上游回「已签到」的账号直接跳过。
- **到账反馈**：本次到账积分、连登天数、剩余积分余额。
- **跨天自愈**：日历日按 `Asia/Shanghai` 算，面板开着不动也每 5 分钟核对一次日期；切回窗口或标签页立即重查。
- **凭据体检**：使用前在本地判定凭据是否可用（非生产环境域名、JWT 过期），不合格的直接拒绝，不多发一个 bearer。
- **中英双语**：跟随宿主界面语言（`document.documentElement.lang`），文案表内置在 `client.js`。
- **离线可测**：全部单元测试不发网络请求、不启动客户端、不碰真实 DSH 目录。

## 界面与状态

入口挂在宿主 `sidebar.footer.action` 槽位上（侧边栏底部、Settings 旁边），显示一个小圆点加一行状态字，点击展开 320px 宽的浮层。

**圆点颜色**

| 点 | 含义 |
|---|---|
| 🟢 绿 | 今日已打卡 |
| 🟡 黄 | 今日待打卡 |
| 🔴 红 | 无法打卡（有账号失败或登录失效） |
| ⚪ 灰 | 查询中 / 未登录 / 凭据不可读 / 没有可用账号 |

**面板状态**

| 状态 | 入口文案 | 面板内容 | 可执行动作 |
|---|---|---|---|
| 查询中 | 灰点「查询中」 | 正在查询 WorkBuddy 登录状态… | 等待（失败自动重试） |
| 待打卡 | 黄点「待打卡」 | N 个账号没打卡 + 账号列表 | **一键打卡** |
| 今日已完成 | 绿点「今日已完成」 | 今天已经打完卡了 + 到账、连登、余额 | 刷新余额 |
| 未登录 | 灰点「未登录」 | 为什么读不到 + 去客户端登录的引导 | 重新检测 |
| 凭据不可读 | 灰点「凭据异常」 | 找到凭据但解不开 + 具体解密错误 | 重新检测 |
| 没有可用账号 | 灰点「无账号」 | 逐个账号列出不能打卡的原因 | 重新检测 |
| 查询失败 | 红点「查询失败」 | 失败原因；有旧数据时保留旧内容 | 重试 |

轮询策略：未登录 / 无账号 / 查询失败每 60 秒重查；凭据不可读每 5 分钟（每次可能拉起一次客户端 Electron 取密钥，故意放慢）；跨天检查每 5 分钟 + 窗口聚焦/可见性变化时立即检查。

## 工作原理

```text
┌────────────────────────── DSH 桌面 / Web ──────────────────────────┐
│                                                                    │
│  Client half (client.js)                Host half (index.js)       │
│  ┌───────────────────────┐   HTTP      ┌────────────────────────┐  │
│  │ sidebar.footer.action │────────────▶│ GET  /status           │  │
│  │ 圆点 + 状态字 + 浮层   │  loopback   │ POST /checkin          │  │
│  │ 60s/5min 轮询、跨天核对 │◀────────────│ POST /refresh          │  │
│  └───────────────────────┘   JSON      └───────┬────────────────┘  │
└─────────────────────────────────────────────────┼──────────────────┘
                                                  │
            ┌─────────────────────────────────────┼──────────────────────┐
            ▼                                     ▼                      ▼
  credentials.js                          upstream.js            store.js
  读 %LOCALAPPDATA%\CodeBuddyExtension\   daily-checkin          .workbuddy-checkin.json
  Data\Public\auth\*.info                 checkin-activity-status（原子写，0600）
  取密钥 → AES-256-GCM 解封 accessToken   get-user-resource
```

- **Host 半**注册三条仅本机可访问的路由，负责读凭据、调上游、落盘。
- **Client 半**只做渲染与请求，所有状态都由 `viewOf()` 一个函数推导，保证"每种状态都有字"。
- 两侧的配置通过请求头 `x-workbuddy-checkin-config`（base64url 的 JSON）传递，所以改设置不需要重启 Host。

## 安装

### 方式一：作为 bundle 安装到当前 profile

```text
plugin_manager → install_bundle → target = <本目录绝对路径>
```

安装后如果提示需要重启，重启 DSH 桌面端；刷新页面后侧边栏 Settings 旁即出现入口。

### 方式二：手工挂进 profile

`cordis.patch.yml` 已经把 Host 半边注册成插件条目：

```yaml
- insert:
    - id: workbuddy-checkin
      name: dsh-workbuddy-checkin
```

把本包放进 profile 的 `node_modules`，再让 profile 的 patch 引用这条，效果与方式一相同。

### 环境要求

| 项 | 要求 |
|---|---|
| DSH | 带 `webServer` 服务的版本（桌面端或 Web GUI 均可） |
| Node | ≥ 20（用到 `AbortSignal.timeout`、`node:test`） |
| 宿主依赖 | `@deepseek-ai/cordis ^4.0.5`、`react ^18.2.0`（peer） |
| WorkBuddy | 国内版客户端 5.6+，且已在本机登录 |

## 配置

配置项写在 profile 的插件配置里，Host 与 Client 各读一次；默认值在两侧一致。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `autoCheckinOnOpen` | boolean | `false` | 打开面板且今天还没记录时自动补签一次 |
| `hideWhenSignedOut` | boolean | `true` | 未登录/凭据不可读时只显示图标不显示状态字（入口仍然可点） |
| `showBalance` | boolean | `true` | 显示剩余积分与刷新按钮 |

## HTTP 接口

三条路由都挂在 `/plugins/dsh-workbuddy-checkin/` 下，且**只信任本机页面**：

```text
Host 头必须是 localhost / 127.0.0.1 / [::1] / ::1
Origin 头若存在，同样必须是 loopback（无 Origin 视为同源导航或非浏览器客户端）
否则 403 request-not-trusted
```

| 方法 | 路径 | 说明 | 请求体 |
|---|---|---|---|
| `GET` | `/plugins/dsh-workbuddy-checkin/status` | 登录状态 + 今日结果，只读（`autoCheckinOnOpen` 打开且跨天时会触发一次补签，响应带 `auto: true`） | — |
| `POST` | `/plugins/dsh-workbuddy-checkin/checkin` | 对每个可用账号打卡，串行化，双击不会发两次 | 忽略（上限 16 KB） |
| `POST` | `/plugins/dsh-workbuddy-checkin/refresh` | 只重读今日已记录账号的余额，绝不签到 | 忽略 |

响应统一为 `panelState()` 的结构：

```json
{
  "login": "signed-in",
  "day": "2026-11-11",
  "checkedAt": "2026-11-11T06:40:12.000Z",
  "accounts": [
    {
      "uid": "u_xxx",
      "nickname": "nick",
      "domain": "www.workbuddy.cn",
      "enterprise": false,
      "live": true,
      "state": "signed",
      "credit": 30,
      "streakDays": 7,
      "balance": 1234,
      "balanceCheckedAt": "2026-11-11T06:40:12.000Z"
    }
  ],
  "canCheckin": false,
  "ready": 1,
  "total": 1,
  "settings": { "autoCheckinOnOpen": false, "hideWhenSignedOut": true, "showBalance": true }
}
```

`state` 取值：`pending` / `signed`（本次新领）/ `already`（上游说已领）/ `needRelogin` / `failed`。

## 数据文件

`<DSH_HOME 或 ~/.dsh>/.workbuddy-checkin.json`，权限 `0600`，临时文件 + rename 原子写入，**只存结果，不存令牌、不存密钥**：

```json
{
  "day": "2026-11-11",
  "checkedAt": "2026-11-11T06:40:12.000Z",
  "results": [
    { "uid": "u_xxx", "nickname": "nick", "state": "signed", "at": "2026-11-11T06:40:12.000Z", "credit": 30, "streakDays": 7, "balance": 1234 }
  ]
}
```

同一天内的合并规则：`failed` 不会覆盖已有成功记录；换天则整份重置。

## 上游接口

集中在 `upstream.js`，全部走账号自己 `domain` 上的 `https://<domain>/…`：

| 路径 | 用途 | 超时 |
|---|---|---|
| `POST /v2/billing/meter/daily-checkin` | 领取当日积分 | 15s |
| `POST /v2/billing/meter/checkin-activity-status` | 连登天数、今日是否已签 | 8s |
| `POST /v2/billing/meter/get-user-resource` | 积分余额（`ProductCode=p_tcaca`，`Status=[0,3]` 求和） | 10s |
| `POST /billing/meter/get-user-resource-summary` | 资源汇总（导出备用，当前面板未用） | — |

判定口径：`code === 0` → 签到成功；`code === 10001` 或 `msg` 含「已签到」→ `already`；HTTP 401 → `needRelogin`；其余 → `failed` 并带上游 `msg`。

## 凭据与解密

**发现的文件**（只认国内版）：

```text
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
%APPDATA%\CodeBuddyExtension\Data\Public\auth\...                 (老版本)
~/Library/Application Support/CodeBuddyExtension/Data/Public/auth  (macOS)
$XDG_CONFIG_HOME|~/.config / $XDG_DATA_HOME|~/.local/share        (Linux)
```

同目录下 `workbuddy-desktop.<timestamp>.info` 是每次登录留下的备份；文件名降序 = 新到旧，同一 `uid` 只取最新的可用凭据。`*-ai.info`（国际版）直接忽略——国际版没有签到接口。

**解封流程**（WorkBuddy 5.6+ 起令牌是封装的）：

1. 字段形如 `{ "$wbEncrypted": 1, "envelope": "<base64 of {suite,keyId,nonce,authTag,ciphertext}>" }`。
2. 用客户端自己的 Electron 取本机保护密钥：`ELECTRON_RUN_AS_NODE=1 <WorkBuddy.exe> -e 'process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()'`。
3. `protectorKey = sha256(atRestSecretKey 字符串)`；`keyId = sha256(key).hex.slice(0,16)`，与信封里的 `keyId` 比对。
4. `AES-256-GCM` 解封，AAD 由 `WBEV1|sym-v1|suite|keyId` 按长度前缀拼出（`buildAad()`）。

安全细节：

- 密钥**只在内存**，24 小时内存缓存；失败冷却 30 秒，避免每次开面板都拉起 Electron。
- Windows 下发现的 Electron 可执行必须同目录存在合法的 `version` 文件，否则不予执行；也可用 `WORKBUDDY_ELECTRON_BIN` 显式指定。
- 解密失败会明确报「凭据异常」而不是「未登录」——把 `unreadable` 误判成 `signed-out` 会静默丢掉当天的积分。

## 项目结构

```text
dsh-workbuddy-checkin/
├── index.js              # Host 半：三条 loopback 路由、面板状态推导、串行打卡
├── client.js             # Client 半：sidebar.footer.action 入口 + 浮层 + 轮询 + 双语文案
├── credentials.js        # 登录发现、Electron 取密钥、信封解封（只读、不落盘）
├── upstream.js           # 上游四个接口、JWT/域名体检、错误归一
├── store.js              # 当天记录：原子写、0600、跨天与合并规则
├── cordis.patch.yml      # bundle patch：把 Host 半边注册成插件条目
├── package.json          # exports / files / dsh.bundle / dsh.client
├── locale/{zh,en}.json   # 插件元信息（标题、描述）
├── icon.svg              # 侧边栏图标
└── test/
    ├── checkin.test.mjs     # 23 个用例：加解密、发现、上游、store、loopback、设置头
    └── client-smoke.mjs     # 客户端冒烟：把每种状态真的渲染一遍
```

## 开发与测试

```sh
node --test test/checkin.test.mjs   # Host：状态计算、凭据加解密、loopback 校验、store 语义
node test/client-smoke.mjs          # Client：逐状态渲染并断言都有可见内容
```

测试完全离线：不访问网络、不启动桌面 App、不写真实 DSH 目录（临时目录 + 假 `fetch` + 假 `spawn`）。要接真实客户端调试时，建议设置 `WORKBUDDY_ELECTRON_BIN` 指向一个**副本**，避免和正在运行的客户端抢文件。

## 已知限制

- **仅国内版**：国际版（WorkBuddy AI）没有签到入口，代码里直接忽略其凭据。
- **不能补签**：上游只支持签当天，错过的天数补不回来。
- **依赖非官方接口**：走的是客户端自己在用的接口，客户端改版可能需要跟着改；端点与判定都集中在 `upstream.js`，改一处即可。
- **企业账号**：不支持每日签到，面板会直接标注而不是报错。
- **侧边栏收起时入口不可见**：宿主会整个隐藏底部功能区（`footArea`），展开侧边栏即可。
- **多账号只认本机凭据**：面板列出的是这台机器的客户端登录过的账号，其他设备上的账号看不到。

## 隐私

- 不发任何遥测，不连第三方服务，只在打卡/查余额时访问账号自己 `domain` 上的 WorkBuddy 接口。
- 令牌、保护密钥都不落盘、不进日志、不进状态文件；日志只有失败原因摘要。
- 非生产环境域名（`staging.` / `pre.` / `dev.` / `localhost` / 局域网 IP 等）的凭据一律拒绝使用，避免把真实令牌发到测试环境。
- 三条 HTTP 路由只接受 loopback 来源，远端的页面即使知道你本机的端口也拿不到状态。

## 许可证

[MIT](./LICENSE)

---

<div id="english"></div>

<div align="right">

[中文](#workbuddy-一键打卡--dsh-workbuddy-checkin) · **English**

</div>

# WorkBuddy One-Click Check-in · dsh-workbuddy-checkin

> A DSH sidebar entry that shows your WorkBuddy sign-in state, claims today's credits in one click, and tells you the streak and the remaining balance.

A **DSH bundle plugin**, not a standalone app. It reuses the sign-in your desktop WorkBuddy (China build) client already has, starts no second login flow, and never checks in behind your back — only when you press the button.

## Contents

- [Why](#why)
- [Features](#features)
- [UI and states](#ui-and-states)
- [How it works](#how-it-works)
- [Install](#install)
- [Configuration](#configuration)
- [HTTP routes](#http-routes)
- [State file](#state-file)
- [Upstream endpoints](#upstream-endpoints)
- [Credentials and decryption](#credentials-and-decryption)
- [Project layout](#project-layout)
- [Development and tests](#development-and-tests)
- [Known limits](#known-limits)
- [Privacy](#privacy)
- [License](#license)

## Why

WorkBuddy (China) hands out daily credits for a check-in that lives inside the client, once a day, easy to forget. Put it next to the place you actually work: the state is always visible, the action is one click.

Three deliberately small decisions:

1. **No second login.** It reads the credential the client already stored, so there is no split account.
2. **No silent check-in.** Requests only go out when you press the button; with `autoCheckinOnOpen` enabled it fires once when you open the panel on a new day.
3. **No hidden entry.** Signed out, broken credential, failed request — the entry stays, with the reason spelled out. An entry that vanishes can neither be clicked nor explain itself.

## Features

- **Sign-in detection** — reads the desktop client's shared auth directory. Read-only, never launches the app.
- **One-click check-in** — handles every account, skips accounts already done today, never double-claims.
- **Feedback** — credits claimed, streak days, remaining balance.
- **Cross-day self-healing** — the calendar day is `Asia/Shanghai`; a panel left open re-checks every 5 minutes and immediately on window focus or tab visibility change.
- **Local credential vetting** — non-production hosts and expired JWTs are refused before a single bearer is sent.
- **Bilingual UI** — follows the host locale (`document.documentElement.lang`); strings live in `client.js`.
- **Offline tests** — no network, no client spawn, no writes into a real DSH home.

## UI and states

The entry occupies the host slot `sidebar.footer.action` (bottom of the sidebar, next to Settings): a 7px dot plus a status word, opening a 320px popover.

**Dot colours**

| Dot | Meaning |
|---|---|
| 🟢 green | Checked in today |
| 🟡 amber | Not checked in yet |
| 🔴 red | Cannot check in (an account failed or its sign-in expired) |
| ⚪ grey | Loading / signed out / credential unreadable / no usable account |

**Panel states**

| State | Entry label | Panel body | Action |
|---|---|---|---|
| Loading | grey “Checking” | Reading the WorkBuddy sign-in state… | wait (auto-retried) |
| Pending | amber “Not checked in” | N account(s) still pending + account list | **Check in** |
| Done | green “Done for today” | Done for today + credits, streak, balance | refresh balance |
| Signed out | grey “Signed out” | why it is unreadable + sign in to the client | Recheck |
| Unreadable | grey “Credential unreadable” | found but could not decrypt + the exact error | Recheck |
| No usable account | grey “No account” | each account with its reason | Recheck |
| Load failed | red “Load failed” | the error; keeps the previous answer on screen | Retry |

Polling: signed out / no account / load failed every 60s; unreadable every 5 min (each read may spawn the client's Electron for the key, so it is deliberately slow); day rollover every 5 min plus on focus and visibility change.

## How it works

```text
┌────────────────────────── DSH desktop / web ───────────────────────┐
│                                                                    │
│  Client half (client.js)                Host half (index.js)       │
│  ┌───────────────────────┐   HTTP      ┌────────────────────────┐  │
│  │ sidebar.footer.action │────────────▶│ GET  /status           │  │
│  │ dot + label + popover │  loopback   │ POST /checkin          │  │
│  │ 60s/5min polls, day   │◀────────────│ POST /refresh          │  │
│  └───────────────────────┘   JSON      └───────┬────────────────┘  │
└─────────────────────────────────────────────────┼──────────────────┘
                                                  │
            ┌─────────────────────────────────────┼──────────────────────┐
            ▼                                     ▼                      ▼
  credentials.js                          upstream.js            store.js
  read %LOCALAPPDATA%\CodeBuddyExtension\  daily-checkin          .workbuddy-checkin.json
  Data\Public\auth\*.info                  checkin-activity-status (atomic, 0600)
  key via Electron → AES-256-GCM open      get-user-resource
```

- The **host half** registers three loopback-only routes and owns credential reading, upstream calls, and persistence.
- The **client half** only renders and requests. Every state comes out of one function, `viewOf()`, so no branch can be silent.
- Settings travel as the `x-workbuddy-checkin-config` header (base64url JSON), so a settings change reaches the host without a restart.

## Install

### As a bundle into the current profile

```text
plugin_manager → install_bundle → target = <absolute path to this directory>
```

Restart the DSH desktop app if it asks; after a page refresh the entry appears next to Settings in the sidebar.

### Manually into a profile

`cordis.patch.yml` registers the host half:

```yaml
- insert:
    - id: workbuddy-checkin
      name: dsh-workbuddy-checkin
```

Drop the package into the profile's `node_modules` and reference that patch entry — same result as above.

### Requirements

| Item | Requirement |
|---|---|
| DSH | a build that provides the `webServer` service (desktop or web GUI) |
| Node | ≥ 20 (`AbortSignal.timeout`, `node:test`) |
| Host peer deps | `@deepseek-ai/cordis ^4.0.5`, `react ^18.2.0` |
| WorkBuddy | China build 5.6+, signed in on this machine |

## Configuration

| Field | Type | Default | Meaning |
|---|---|---|---|
| `autoCheckinOnOpen` | boolean | `false` | check in once when the panel opens on a day with no record yet |
| `hideWhenSignedOut` | boolean | `true` | signed out / unreadable shows the icon only, no status word (still clickable) |
| `showBalance` | boolean | `true` | show the remaining credits and the refresh button |

## HTTP routes

All under `/plugins/dsh-workbuddy-checkin/`, and **loopback only**:

```text
Host must be localhost / 127.0.0.1 / [::1] / ::1
Origin, when present, must be loopback too (absent Origin = same-origin navigation or non-browser client)
otherwise 403 request-not-trusted
```

| Method | Path | Purpose | Body |
|---|---|---|---|
| `GET` | `/plugins/dsh-workbuddy-checkin/status` | sign-in state + today's outcome, read-only (with `autoCheckinOnOpen` and a stale day it performs one catch-up check-in and answers `auto: true`) | — |
| `POST` | `/plugins/dsh-workbuddy-checkin/checkin` | check in every usable account; serialized, so a double click cannot send two requests | ignored (16 KB cap) |
| `POST` | `/plugins/dsh-workbuddy-checkin/refresh` | re-read balances of today's accounts; never checks in | ignored |

Responses share the `panelState()` shape:

```json
{
  "login": "signed-in",
  "day": "2026-11-11",
  "checkedAt": "2026-11-11T06:40:12.000Z",
  "accounts": [
    {
      "uid": "u_xxx",
      "nickname": "nick",
      "domain": "www.workbuddy.cn",
      "enterprise": false,
      "live": true,
      "state": "signed",
      "credit": 30,
      "streakDays": 7,
      "balance": 1234
    }
  ],
  "canCheckin": false,
  "ready": 1,
  "total": 1,
  "settings": { "autoCheckinOnOpen": false, "hideWhenSignedOut": true, "showBalance": true }
}
```

`state` is one of `pending`, `signed`, `already`, `needRelogin`, `failed`.

## State file

`<DSH_HOME or ~/.dsh>/.workbuddy-checkin.json`, mode `0600`, written atomically (temp file + rename). Outcome data only — **no token, no key**:

```json
{
  "day": "2026-11-11",
  "checkedAt": "2026-11-11T06:40:12.000Z",
  "results": [
    { "uid": "u_xxx", "nickname": "nick", "state": "signed", "at": "2026-11-11T06:40:12.000Z", "credit": 30, "streakDays": 7, "balance": 1234 }
  ]
}
```

Same-day merge rule: a `failed` row never demotes an earlier success. A new day starts a fresh record.

## Upstream endpoints

All in `upstream.js`, always `https://<account.domain>/…`:

| Path | Purpose | Timeout |
|---|---|---|
| `POST /v2/billing/meter/daily-checkin` | claim today's credits | 15s |
| `POST /v2/billing/meter/checkin-activity-status` | streak, whether today is done | 8s |
| `POST /v2/billing/meter/get-user-resource` | credit balance (`ProductCode=p_tcaca`, sum over `Status=[0,3]`) | 10s |
| `POST /billing/meter/get-user-resource-summary` | resource summary (exported, unused by the panel) | — |

Verdicts: `code === 0` → signed; `code === 10001` or `msg` containing 已签到 → `already`; HTTP 401 → `needRelogin`; anything else → `failed` carrying the upstream `msg`.

## Credentials and decryption

**Files it looks at** (China build only):

```text
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info
%APPDATA%\CodeBuddyExtension\Data\Public\auth\...                  (older builds)
~/Library/Application Support/CodeBuddyExtension/Data/Public/auth  (macOS)
$XDG_CONFIG_HOME|~/.config / $XDG_DATA_HOME|~/.local/share        (Linux)
```

`workbuddy-desktop.<timestamp>.info` files are per-sign-in backups; descending filename order is newest-first, and only the newest usable credential per `uid` is kept. `*-ai.info` (international build) is ignored — it has no check-in endpoint.

**Unsealing** (since WorkBuddy 5.6 the token is sealed):

1. The field looks like `{ "$wbEncrypted": 1, "envelope": "<base64 of {suite,keyId,nonce,authTag,ciphertext}>" }`.
2. The machine key comes from the client's own Electron: `ELECTRON_RUN_AS_NODE=1 <WorkBuddy.exe> -e 'process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()'`.
3. `protectorKey = sha256(atRestSecretKey string)`; `keyId = sha256(key).hex.slice(0,16)`, compared with the envelope's `keyId`.
4. `AES-256-GCM` open, with the AAD built from `WBEV1|sym-v1|suite|keyId` using length-prefixed fields (`buildAad()`).

Safety details:

- The key lives **in memory only** (24h cache); failures cool down for 30s so opening the panel does not spawn Electron every time.
- On Windows a discovered Electron binary must sit next to a valid `version` file, otherwise it is not executed; `WORKBUDDY_ELECTRON_BIN` overrides discovery.
- A failed decryption is reported as “Credential unreadable”, never as “Signed out” — mistaking `unreadable` for `signed-out` would silently drop that day's credits.

## Project layout

```text
dsh-workbuddy-checkin/
├── index.js              # host: three loopback routes, panel state, serialized check-in
├── client.js             # client: sidebar.footer.action entry, popover, polling, i18n strings
├── credentials.js        # auth discovery, Electron key fetch, envelope unsealing (read-only)
├── upstream.js           # the four upstream calls, JWT/host vetting, error normalization
├── store.js              # per-day record: atomic write, 0600, day and merge rules
├── cordis.patch.yml      # bundle patch registering the host half
├── package.json          # exports / files / dsh.bundle / dsh.client
├── locale/{zh,en}.json   # plugin metadata (title, description)
├── icon.svg              # sidebar icon
└── test/
    ├── checkin.test.mjs     # 23 cases: crypto, discovery, upstream, store, loopback, config header
    └── client-smoke.mjs     # client smoke: renders every state and asserts it is visible
```

## Development and tests

```sh
node --test test/checkin.test.mjs   # host: state math, credential crypto, loopback guard, store semantics
node test/client-smoke.mjs          # client: render each state, assert none is blank
```

Everything is offline: no network, no client spawn, no writes into a real DSH home (temp dirs, fake `fetch`, fake `spawn`). When debugging against a real client, point `WORKBUDDY_ELECTRON_BIN` at a **copy** so you do not contend with a running instance.

## Known limits

- **China build only.** The international (WorkBuddy AI) build has no check-in endpoint; its credentials are ignored.
- **No backfill.** The upstream only accepts today; missed days cannot be recovered.
- **Unofficial endpoints.** These are the endpoints the client itself uses; a client update may need a follow-up patch. Paths and verdicts are all in `upstream.js`.
- **Enterprise accounts** have no daily check-in; the panel labels them instead of failing.
- **Collapsed sidebar hides the entry.** The host hides the whole footer area in that mode; expand the sidebar.
- **Local machine only.** The panel lists accounts this machine's client has signed in; other devices are invisible.

## Privacy

- No telemetry, no third-party services; it talks only to the WorkBuddy endpoints on the account's own domain.
- Tokens and protector keys never touch disk, logs, or the state file; logs carry failure summaries only.
- Credentials pointing at non-production hosts (`staging.`, `pre.`, `dev.`, `localhost`, LAN IPs, …) are refused, so a real token is never sent to a test environment.
- The three HTTP routes accept loopback origins only; a remote page that guesses the port still gets nothing.

## License

[MIT](./LICENSE)

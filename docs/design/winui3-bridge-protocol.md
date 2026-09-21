# WinUI 3 重构 · Node 侧车进程桥接协议（v1）

> **状态**：Lead 制定，冻结。Node 侧与 C# 侧必须严格照此实现。
> **背景**：本轮把前端整体替换为 WinUI 3（C#/XAML）。`src/core/**`（约 7 000 行纯 Node/TS 业务逻辑，零 Electron 依赖）**保留复用**，由 C# 进程以子进程方式拉起，经 stdio 通信。
> **替代关系**：本协议取代 Electron 的 `ipcMain.handle` / `contextBridge`。原有 39 条 IPC 通道的**语义与参数校验必须保留**，只换传输层。

---

## 1. 传输层

| 项 | 规定 |
|---|---|
| 进程模型 | C# 主进程 `Process.Start` 拉起 `node <bridge-entry> --home <dir>` |
| 上行（C# → Node） | 子进程 **stdin**，NDJSON |
| 下行（Node → C#） | 子进程 **stdout**，NDJSON |
| 日志 | 子进程 **stderr**，人类可读文本，**不参与协议** |
| 编码 | UTF-8，无 BOM |
| 分帧 | 每行一个完整 JSON 对象，以 `\n` 结尾。**单行内不得出现裸换行**；字符串内的换行必须 JSON 转义 |
| 载荷上限 | 单行 ≤ 8 MiB。更大数据一律传**文件路径**，不传内容 |

> **为什么用 NDJSON 而不是长度前缀**：可直接用 `ReadLineAsync` / `readline` 实现，两端零依赖，人类可抓包阅读。

---

## 2. 消息类型

### 2.1 请求（双向）

```json
{"id": "c1", "method": "instance:list", "params": []}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 必需。**命名空间隔离**：C# 发起用 `c` + 自增序号（`c1`、`c2`…）；Node 发起用 `n` + 自增序号（`n1`、`n2`…） |
| `method` | string | 必需。见 §3 |
| `params` | array | 必需（可为 `[]`）。**位置参数数组**，顺序与 §3 的方法表一致 |

### 2.2 成功响应

```json
{"id": "c1", "ok": true, "value": {...}}
```

### 2.3 失败响应

```json
{"id": "c1", "ok": false, "error": "实例不存在：KREA2"}
```

`error` 是**面向用户的中文文案**（沿用旧 `Result<T>` 的 `err()` 约定），不是堆栈。堆栈只进 stderr。

> **与旧契约的关系**：`src/shared/contracts.ts` 的 `Result<T> = {ok:true,value} | {ok:false,error}` 与本协议的成功/失败响应**同构**。桥接层必须保持这一映射，不得把 `Result` 再包一层。

### 2.4 事件（Node → C#，单向、无 id、无响应）

```json
{"event": "log:chunk", "data": {"instanceId": "KREA2", "stream": "stdout", "text": "..."}}
```

| 事件名 | 对应旧通道 | 说明 |
|---|---|---|
| `log:chunk` | `CH.log.chunk` | 日志流分片 |
| `log:state` | `CH.log.state` | 日志管线状态变更 |

> 其他旧的"推送"只有上述两条。**新增事件必须在本文档登记后方可使用。**

---

## 3. 方法表

### 3.1 Node 侧方法（C# → Node）

**方法名 = `src/shared/contracts.ts` 中 `CH` 常量的字面值**（含冒号），一路到底，不做大小写或分隔符转换。这样"方法名 ↔ 通道常量"是机械映射，不会漂移。

分组（与 `CH` 同构）：`launcher:`、`instance:`、`engine:`、`plugin:`、`settings:`、`saves:`、`pack:`、`app:`。

**唯一事实源**：`src/shared/contracts.ts` 的 `CH` 与 `WhalesApi`。
**参数校验的实现位置**：`desktop/bridge/validate.mjs`。这些校验原先来自 Electron 主进程的 `src/main/ipc.ts`（`must*` / `parseCreateInput` / `parseUpdatePatch` 白名单等），已**原样搬运、不放宽**。`src/main/**` 已于 commit `ed93af9` 物理删除；如需比对历史实现，用 `git show ed93af9^:src/main/ipc.ts`。

### 3.2 内建方法（`__` 前缀，非业务）

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `__handshake` | `[]` | `{protocol:1, appVersion:string, channels:string[], hostMethods:string[]}` | C# 启动后**必须首先调用**。`protocol` 不匹配则 C# 报错并终止 |
| `__ping` | `[]` | `{pong:true}` | 存活探测 |
| `__shutdown` | `[]` | `{ok:true}` | 优雅退出；Node 侧应在 flush 后自行 `process.exit(0)` |

### 3.3 宿主方法（Node → C#，`host:` 前缀）

这些能力原先由 Electron 主进程提供，Node 侧无法自行实现，必须**反向请求 C#**。

| 方法 | 参数 | 返回 | 原 Electron 出处 |
|---|---|---|---|
| `host:pickArchive` | `[{title}]` | `string \| null`（选中路径） | `dialog.showOpenDialog`（`plugin:pickArchive`，zip） |
| `host:pickFolder` | `[{title}]` | `string \| null` | `dialog.showOpenDialog`（`plugin:pickFolder`，目录） |
| `host:pickPackFile` | `[{title}]` | `string \| null` | `dialog.showOpenDialog`（`pack:pickFile`） |
| `host:saveFile` | `[{title, suggestedName, defaultDir}]` | `string \| null` | `dialog.showSaveDialog`（`pack:export`） |
| `host:downloadsDir` | `[]` | `string` | `app.getPath('downloads')` |
| `host:openPath` | `[{path}]` | `void` | `shell.openPath`（打开目录） |
| `host:openExternal` | `[{url}]` | `void` | `shell.openExternal`（**仅 http/https**） |
| `host:messageBox` | `[{title, message, detail, buttons}]` | `number`（按钮索引） | `dialog.showMessageBoxSync`（关闭前确认等） |

> **安全约束（沿用旧实现的硬边界）**：`host:openExternal` 只放行 `http` / `https`，其余协议一律拒绝并回 `ok:false`。C# 侧**必须独立再校验一次**，不信任 Node 传来的 scheme。

### 3.4 处理顺序与并发

- **允许并发**：C# 可同时发出多个请求（不同 id）。Node 侧必须并行处理，**不得**因为某个方法耗时（如 `engine:install` 下载）而阻塞其他请求的读取。
- **例外（必须串行）**：同一实例上的 `instance:launch` / `instance:stop`，以及端口台账写入 —— 沿用 `src/core/ports.ts` 既有的串行锁语义，桥接层不得绕过。
- `__shutdown` 之前应处理完所有在途请求。

---

## 4. 错误与退出

| 情形 | 行为 |
|---|---|
| 方法不存在 | `{"id":..., "ok":false, "error":"未知方法：<method>"}` |
| 参数不合法 | `ok:false`，`error` 为**既有校验逻辑产出的中文文案** |
| 业务失败 | `ok:false`，`error` 原样透传 core 的 `err()` 文案 |
| Node 侧未捕获异常 | 不得让进程崩溃：捕获后回 `ok:false` 并写 stderr；仅在无法恢复时退出 |
| **stdout 被污染** | **严禁**在 stdout 打印任何非协议内容（`console.log` 重定向到 stderr）。这是最常见的集成故障 |
| 子进程异常退出 | C# 侧检测 `Process.Exited`，向 UI 报"后端已断开"，禁用写操作并提示重启 |
| 启动失败（node 缺失） | C# 侧走既有的 Node 运行时探测逻辑（见 `src/core/node-runtime.ts`），失败时给出可操作提示 |

---

## 5. 实现约定

1. **Node 侧入口**：`desktop/bridge/server.mjs`（esbuild 打包为单文件，产物 `dist/bridge/server.cjs`）。
2. **复用而非重写**：Node 侧复用 `src/core`（`CoreApi`）；原 `src/main/ipc.ts` 的 handler 逻辑已搬运到 `desktop/bridge/validate.mjs` + `desktop/bridge/server.mjs`，**不得再复制粘贴出第二份实现**。桥接对 `src/core` 的运行时 import 只有 3 条（`config-store.mjs` / `events.mjs` / `server.mjs` 各一条），没有 Electron 适配层残留。
3. **契约漂移防护**：方法名列表由 `CH` 常量在运行时导出，`__handshake` 返回真实列表；C# 侧在开发期断言两边一致，不一致直接失败。
4. **C# 侧客户端**：`Services/CoreBridge.cs`，负责进程生命周期、NDJSON 读写、id 分配、请求-响应配对（`TaskCompletionSource`）、事件分发、宿主方法注册。
5. **测试**：桥接层必须具备可脱离 UI 的冒烟测试 —— 直接向 stdin 喂请求、读 stdout 断言。纳入 `scripts/audit/`。

---

## 6. 变更流程

本文档冻结。任何字段、方法名、语义变更须由 Lead 批准并**同时**更新本文档版本号与两端实现；禁止单侧先行修改。

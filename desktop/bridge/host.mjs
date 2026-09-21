/**
 * 宿主方法客户端（协议 §3.3）：Node → C# 的**反向请求**。
 *
 * 这些能力原先由 Electron 主进程提供（`dialog` / `shell` / `app.getPath`），
 * 侧车进程无法自行实现，必须反向请求 C# 宿主：
 *
 *   | 方法 | 参数 | 返回 | 原 Electron 出处 |
 *   |---|---|---|---|
 *   | host:pickArchive   | [{title}]                                   | string\|null | dialog.showOpenDialog（plugin:pickArchive，zip） |
 *   | host:pickFolder    | [{title}]                                   | string\|null | dialog.showOpenDialog（plugin:pickFolder，目录） |
 *   | host:pickPackFile  | [{title}]                                   | string\|null | dialog.showOpenDialog（pack:pickFile） |
 *   | host:saveFile      | [{title, suggestedName, defaultDir}]        | string\|null | dialog.showSaveDialog（pack:export） |
 *   | host:downloadsDir  | []                                          | string       | app.getPath('downloads') |
 *   | host:openPath      | [{path}]                                    | void         | shell.openPath |
 *   | host:openExternal  | [{url}]                                     | void         | shell.openExternal（仅 http/https） |
 *   | host:messageBox    | [{title, message, detail, buttons}]         | number       | dialog.showMessageBoxSync |
 *
 * id 采用协议 §2.1 的命名空间：Node 发起用 `n` + 自增序号，与 C# 的 `c` 前缀互不冲突。
 * 宿主响应形如 `{"id":"n1","ok":true,"value":...}` / `{"id":"n1","ok":false,"error":"…"}`，
 * 与 `Result<T>` 同构（协议 §2.2/§2.3）。
 */

/** 协议 §3.3 的宿主方法表（`__handshake.hostMethods` 如实返回这一份）。 */
export const HOST_METHODS = Object.freeze([
  'host:pickArchive',
  'host:pickFolder',
  'host:pickPackFile',
  'host:saveFile',
  'host:downloadsDir',
  'host:openPath',
  'host:openExternal',
  'host:messageBox',
]);

/**
 * 创建宿主客户端。
 * @param {object} options 选项。
 * @param {(value: unknown) => Promise<void>} options.writeLine 下行写入函数（注入以避免循环 import）。
 * @returns {object} 客户端（`call` + 8 个语义封装 + `settle` / `rejectAll`）。
 */
export function createHostClient({ writeLine }) {
  /** 已发出、等待宿主响应的请求：id → {resolve, reject, method}。 */
  const pending = new Map();
  let sequence = 0;

  const client = {
    /**
     * 发起一次宿主调用。
     *
     * **刻意不设超时**：宿主方法大多是用户手动操作的对话框（选文件、存文件），
     * 用户思考多久都合法；旧实现同样是无限等待（`await dialog.showOpenDialog(...)`）。
     * 进程退出路径由 {@link rejectAll} 收口，不会留下永远挂起的 Promise。
     * @param {string} method 宿主方法名（`host:` 前缀）。
     * @param {unknown[]} params 位置参数数组。
     * @returns {Promise<unknown>} 宿主返回值。
     */
    call(method, params) {
      sequence += 1;
      const id = `n${sequence}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        void writeLine({ id, method, params });
      });
    },

    /**
     * 处理一条**宿主响应**（由 `server.mjs` 在消息没有 `method` 字段时调用）。
     * @param {Record<string, unknown>} message 收到的消息。
     * @returns {boolean} 是否被当作宿主响应消费。
     */
    settle(message) {
      const id = message['id'];
      if (typeof id !== 'string' || !id.startsWith('n')) return false;

      const entry = pending.get(id);
      if (entry === undefined) {
        // 迟到的响应（例如宿主在我们放弃等待之后才回）：只记日志，不影响协议流。
        console.warn(`[bridge] 收到无法配对的宿主响应：${id}`);
        return true;
      }
      pending.delete(id);

      if (message['ok'] === true) {
        const value = message['value'];
        entry.resolve(value === undefined ? null : value);
        return true;
      }
      const text = message['error'];
      entry.reject(
        new Error(
          typeof text === 'string' && text.length > 0
            ? text
            : `${entry.method} 调用失败（宿主返回 ok:false 且未给出 error）。`,
        ),
      );
      return true;
    },

    /** 让所有在途宿主调用立即失败（进程退出路径用，避免请求永远挂起）。 */
    rejectAll(reason) {
      for (const [id, entry] of pending) {
        pending.delete(id);
        entry.reject(new Error(reason));
      }
    },

    /** 在途宿主调用数量（诊断用）。 */
    pendingCount() {
      return pending.size;
    },

    /* ---- 语义封装：参数形状严格按协议 §3.3 ---- */
    pickArchive: ({ title }) => client.call('host:pickArchive', [{ title }]),
    pickFolder: ({ title }) => client.call('host:pickFolder', [{ title }]),
    pickPackFile: ({ title }) => client.call('host:pickPackFile', [{ title }]),
    saveFile: ({ title, suggestedName, defaultDir }) =>
      client.call('host:saveFile', [{ title, suggestedName, defaultDir }]),
    downloadsDir: () => client.call('host:downloadsDir', []),
    openPath: ({ path: target }) => client.call('host:openPath', [{ path: target }]),
    openExternal: ({ url }) => client.call('host:openExternal', [{ url }]),
    messageBox: ({ title, message, detail, buttons }) =>
      client.call('host:messageBox', [{ title, message, detail, buttons }]),
  };

  return client;
}

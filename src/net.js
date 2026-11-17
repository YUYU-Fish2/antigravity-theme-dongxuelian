import { createHash, randomBytes } from 'node:crypto';
import { get as httpGet, request as httpRequest } from 'node:http';

/**
 * 轻量本地 HTTP / WebSocket 客户端（仅用于连接本机 CDP 调试端口）。
 *
 * 之所以不用 Node 内置的全局 `fetch` / `WebSocket`：二者基于 undici，首次访问即加载整套
 * undici 模块与 llhttp WebAssembly 实例，对一个常驻后台、每 2 秒只发一次小请求的守护进程
 * 来说开销偏大。这里只实现 CDP 需要的最小子集（文本帧、分片、ping/pong、close）。
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_JSON_BYTES = 8 * 1024 * 1024;

/**
 * 通过 `node:http` GET 并解析 JSON（替代 `fetch(url).then(r => r.json())`）。
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<any>}
 */
export function httpGetJson(url, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = httpGet(url, { agent: false, headers: { Accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish(reject, new Error(`返回异常状态码：${res.statusCode}`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_JSON_BYTES) {
          req.destroy(new Error('响应体过大'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          finish(resolve, JSON.parse(Buffer.concat(chunks, total).toString('utf8')));
        } catch (err) {
          finish(reject, new Error(`JSON 解析失败：${err.message}`));
        }
      });
      res.on('error', (err) => finish(reject, err));
    });
    const timer = setTimeout(() => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
    }, timeoutMs);
    req.on('error', (err) => finish(reject, err));
  });
}

function encodeClientFrame(opcode, payload) {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) headerLen += 2;
  else if (len > 0xffff) headerLen += 8;
  const frame = Buffer.allocUnsafe(headerLen + 4 + len);
  frame[0] = 0x80 | opcode;
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }
  // RFC 6455 要求客户端帧必须掩码
  const mask = randomBytes(4);
  mask.copy(frame, headerLen);
  const offset = headerLen + 4;
  for (let i = 0; i < len; i++) {
    frame[offset + i] = payload[i] ^ mask[i & 3];
  }
  return frame;
}

/**
 * 最小化 WebSocket 客户端，接口与浏览器 / Node 全局 `WebSocket` 的常用子集兼容：
 * `readyState`、`addEventListener(open|message|error|close)`、`send(text)`、`close()`。
 */
export class MiniWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this._listeners = new Map();
    this._socket = null;
    this._chunks = [];
    this._buffered = 0;
    this._fragments = [];
    this._closeEmitted = false;
    this._closeTimer = null;

    let target;
    try {
      target = new URL(this.url);
    } catch (err) {
      queueMicrotask(() => this._fail(new Error(`无效的 WebSocket 地址：${this.url}`)));
      return;
    }
    if (target.protocol !== 'ws:') {
      queueMicrotask(() => this._fail(new Error(`仅支持 ws:// 本地调试地址：${this.url}`)));
      return;
    }

    const key = randomBytes(16).toString('base64');
    this._expectedAccept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    const req = httpRequest({
      host: target.hostname.replace(/^\[|\]$/g, ''),
      port: target.port || 80,
      path: `${target.pathname}${target.search}`,
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });
    this._req = req;
    req.on('upgrade', (res, socket, head) => this._onUpgrade(res, socket, head));
    req.on('response', (res) => {
      res.resume();
      this._fail(new Error(`WebSocket 握手失败（HTTP ${res.statusCode}）`));
    });
    req.on('error', (err) => this._fail(err));
    req.end();
  }

  addEventListener(type, fn, options) {
    if (typeof fn !== 'function') return;
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push({ fn, once: Boolean(options?.once) });
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const idx = list.findIndex((item) => item.fn === fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  _emit(type, event) {
    const list = this._listeners.get(type);
    if (!list || list.length === 0) return;
    for (const item of [...list]) {
      if (item.once) this.removeEventListener(type, item.fn);
      try {
        item.fn(event);
      } catch {
        // 监听器异常不影响连接
      }
    }
  }

  _onUpgrade(res, socket, head) {
    if (res.headers['sec-websocket-accept'] !== this._expectedAccept) {
      socket.destroy();
      this._fail(new Error('WebSocket 握手校验失败（Sec-WebSocket-Accept 不匹配）'));
      return;
    }
    this._socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => {
      this._emit('error', { message: err.message, error: err });
    });
    socket.on('close', () => this._finalizeClose());
    this.readyState = 1;
    this._emit('open', {});
    if (head && head.length) this._onData(head);
  }

  _onData(chunk) {
    this._chunks.push(chunk);
    this._buffered += chunk.length;
    while (this._buffered >= 2) {
      const buf = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks, this._buffered);
      this._chunks = [buf];
      const b0 = buf[0];
      const b1 = buf[1];
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buf.length < offset + len) return;

      let payload = buf.subarray(offset, offset + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskOffset + (i & 3)];
      }
      const rest = buf.subarray(offset + len);
      this._chunks = rest.length ? [rest] : [];
      this._buffered = rest.length;
      this._handleFrame((b0 & 0x80) !== 0, b0 & 0x0f, payload);
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      if (this.readyState === 1) {
        this._writeFrame(0x8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
      }
      this.readyState = 2;
      this._socket?.end();
      return;
    }
    if (opcode === 0x9) {
      this._writeFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      // 复制分片，避免持有整个接收缓冲区
      this._fragments.push(fin && this._fragments.length === 0 ? payload : Buffer.from(payload));
      if (!fin) return;
      const data = this._fragments.length === 1 ? this._fragments[0] : Buffer.concat(this._fragments);
      this._fragments = [];
      this._emit('message', { data: data.toString('utf8') });
    }
  }

  _writeFrame(opcode, payload) {
    const socket = this._socket;
    if (!socket || socket.destroyed || !socket.writable) return false;
    socket.write(encodeClientFrame(opcode, payload));
    return true;
  }

  send(data) {
    if (this.readyState !== 1) {
      throw new Error('WebSocket 未处于 OPEN 状态');
    }
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this._writeFrame(0x1, payload);
  }

  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    if (this.readyState === 0) {
      this.readyState = 3;
      this._req?.destroy();
      this._finalizeClose();
      return;
    }
    this.readyState = 2;
    const reasonBuf = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const body = Buffer.allocUnsafe(2 + reasonBuf.length);
    body.writeUInt16BE(code, 0);
    reasonBuf.copy(body, 2);
    this._writeFrame(0x8, body);
    this._closeTimer = setTimeout(() => this._socket?.destroy(), 1000);
    this._closeTimer.unref?.();
  }

  _fail(err) {
    if (this.readyState === 3 && this._closeEmitted) return;
    this._emit('error', { message: err.message, error: err });
    this._socket?.destroy();
    this._req?.destroy();
    this._finalizeClose();
  }

  _finalizeClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.readyState = 3;
    clearTimeout(this._closeTimer);
    this._chunks = [];
    this._fragments = [];
    this._emit('close', {});
    this._listeners.clear();
  }
}

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeWsFrame(opcode, payloadBuf) {
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payloadBuf]);
}

function sendWsText(socket, text) {
  if (!socket.destroyed && socket.writable) {
    socket.write(encodeWsFrame(0x1, Buffer.from(text, 'utf8')));
  }
}

/**
 * 启动本地回环 Mock CDP 服务端（127.0.0.1:0），支持 `/json/list` 与 RFC 6455 WebSocket。
 * @param {object} [options]
 * @param {(page: any, expression: string) => any} [options.onEvaluate]
 * @returns {Promise<{
 *   port: number,
 *   addPage: (pageSpec: { id: string, title?: string, url?: string, type?: string }) => any,
 *   setRawTargets: (targets: any[]) => void,
 *   getPageState: (id: string) => any,
 *   close: () => Promise<void>
 * }>}
 */
export async function startMockCdpServer({ onEvaluate } = {}) {
  const pages = new Map();
  let extraRawTargets = [];
  let scriptSeq = 1;
  const activeSockets = new Set();

  const server = createServer((req, res) => {
    if (req.url === '/json/list') {
      const list = [
        ...Array.from(pages.values()).map((entry) => ({
          id: entry.id,
          type: entry.type,
          title: entry.title,
          url: entry.url,
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${entry.id}`,
        })),
        ...extraRawTargets,
      ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  server.on('upgrade', (req, socket) => {
    const match = req.url?.match(/^\/devtools\/page\/([^/?]+)$/);
    const pageId = match ? match[1] : null;
    const pageState = pageId ? pages.get(pageId) : null;
    const key = req.headers['sec-websocket-key'];
    if (!pageState || !key) {
      socket.destroy();
      return;
    }

    const accept = createHash('sha1').update(`${key}${WS_MAGIC}`).digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );

    activeSockets.add(socket);
    let rxBuf = Buffer.alloc(0);
    let fragments = [];

    const handleJsonRpc = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      const { id, method, params = {} } = msg;
      pageState.commands.push({ method, params });

      const reply = (result) => {
        sendWsText(socket, JSON.stringify({ id, result }));
      };
      const replyError = (code, message) => {
        sendWsText(socket, JSON.stringify({ id, error: { code, message } }));
      };

      if (method === 'Page.enable') {
        reply({});
        return;
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        const identifier = `script-${scriptSeq++}`;
        pageState.docScripts.set(identifier, params.source || '');
        reply({ identifier });
        return;
      }
      if (method === 'Page.removeScriptToEvaluateOnNewDocument') {
        pageState.docScripts.delete(params.identifier);
        reply({});
        return;
      }
      if (method === 'Runtime.evaluate') {
        pageState.evaluations.push(params.expression || '');
        try {
          const value = onEvaluate ? onEvaluate(pageState, params.expression) : { ok: true };
          reply({ result: { type: typeof value, value } });
        } catch (err) {
          reply({
            exceptionDetails: {
              text: err.message,
              exception: { description: err.stack || err.message },
            },
          });
        }
        return;
      }
      replyError(-32601, `Method not found: ${method}`);
    };

    socket.on('data', (chunk) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      while (rxBuf.length >= 2) {
        const b0 = rxBuf[0];
        const b1 = rxBuf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;

        if (len === 126) {
          if (rxBuf.length < offset + 2) break;
          len = rxBuf.readUInt16BE(offset);
          offset += 2;
        } else if (len === 127) {
          if (rxBuf.length < offset + 8) break;
          len = Number(rxBuf.readBigUInt64BE(offset));
          offset += 8;
        }

        const maskOffset = offset;
        const payloadOffset = offset + (masked ? 4 : 0);
        if (rxBuf.length < payloadOffset + len) break;

        let payload = Buffer.from(rxBuf.subarray(payloadOffset, payloadOffset + len));
        if (masked) {
          const mask = rxBuf.subarray(maskOffset, maskOffset + 4);
          for (let i = 0; i < payload.length; i++) {
            payload[i] ^= mask[i & 3];
          }
        }
        rxBuf = rxBuf.subarray(payloadOffset + len);

        if (opcode === 0x8) {
          if (!socket.destroyed && socket.writable) {
            socket.end(encodeWsFrame(0x8, Buffer.alloc(0)));
          }
          break;
        }
        if (opcode === 0x9) {
          if (!socket.destroyed && socket.writable) {
            socket.write(encodeWsFrame(0xa, payload));
          }
          continue;
        }
        if (opcode === 0xa) {
          continue;
        }
        if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
          fragments.push(payload);
          if (fin) {
            const fullText = Buffer.concat(fragments).toString('utf8');
            fragments = [];
            handleJsonRpc(fullText);
          }
        }
      }
    });

    socket.on('close', () => {
      activeSockets.delete(socket);
    });
  });

  await new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const addPage = ({ id, title = `Antigravity (${id})`, url = `https://antigravity.local/${id}`, type = 'page' }) => {
    const state = {
      id,
      type,
      title,
      url,
      commands: [],
      evaluations: [],
      docScripts: new Map(),
    };
    pages.set(id, state);
    return state;
  };

  return {
    port,
    addPage,
    setRawTargets: (targets) => {
      extraRawTargets = targets;
    },
    getPageState: (id) => pages.get(id),
    close: async () => {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      activeSockets.clear();
      await new Promise((resolveClose) => {
        server.close(() => resolveClose());
      });
    },
  };
}

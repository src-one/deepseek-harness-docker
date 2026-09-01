const http = require('http');
const httpProxy = require('http-proxy');
const crypto = require('crypto');

// DSH Source Port (Internal) and Proxy Port (External)
const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const LISTEN_PORT = Number(process.env.PROXY_PORT) || 3080;
const TARGET_ORIGIN = `http://127.0.0.1:${DSH_PORT}`;
const AUTH_REALM = 'dsh-proxy';

// Optional Basic Auth
const AUTH_USER = process.env.PROXY_USERNAME || '';
const AUTH_PASS = process.env.PROXY_PASSWORD || '';

// Public asset paths exempt from Basic Auth
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/favicon.svg', '/favicon.ico']);

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function checkAuth(req) {
  if (!AUTH_USER || !AUTH_PASS) return true; // Auth not configured -> allow
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const i = decoded.indexOf(':');
  if (i === -1) return false;
  return safeEqual(decoded.slice(0, i), AUTH_USER) && safeEqual(decoded.slice(i + 1), AUTH_PASS);
}

function rejectUnauthorized(res) {
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${AUTH_REALM}"`,
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('401 Unauthorized');
}

function rejectUpgrade(socket) {
  socket.end(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="${AUTH_REALM}"\r\nConnection: close\r\n\r\n`);
}

const proxy = httpProxy.createProxyServer({
  target: TARGET_ORIGIN,
  ws: true,
  changeOrigin: true,
});

proxy.on('error', (err, req, res) => {
  console.error('[proxy error]', err.message);
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('502 Bad Gateway - DSH is starting or unavailable');
  }
});

// Polyfill for crypto.randomUUID for non-HTTPS / LAN IP access (ZimaOS / CasaOS)
const POLYFILL = '<script>(function(){try{if(typeof crypto!=="undefined"&&crypto&&typeof crypto.randomUUID!=="function"){crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h="";for(var i=0;i<16;i++){h+=b[i].toString(16).padStart(2,"0")}return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}}catch(e){}})();</script>';

// Make loopback checks return true so settings / admin features work over LAN IP in ZimaOS
const LOOPBACK_JS_NEEDLE = 'isLoopbackHostname(pageLocation.hostname)';
const LOOPBACK_JS_REPLACEMENT = 'true';

proxy.on('proxyRes', (proxyRes, req, res) => {
  const ct = String(proxyRes.headers['content-type'] || '');
  if (proxyRes.headers['content-encoding']) return;

  if (ct.includes('text/html')) {
    delete proxyRes.headers['content-length'];
    res.removeHeader('content-length');
    let injected = false;
    const origWrite = res.write.bind(res);
    res.write = function (chunk, ...rest) {
      if (!injected) {
        injected = true;
        let str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const i = str.toLowerCase().indexOf('<head');
        if (i !== -1) {
          const e = str.indexOf('>', i);
          str = e !== -1 ? str.slice(0, e + 1) + POLYFILL + str.slice(e + 1) : POLYFILL + str;
        } else {
          str = POLYFILL + str;
        }
        chunk = Buffer.from(str);
      }
      return origWrite(chunk, ...rest);
    };
    return;
  }

  if (ct.includes('javascript')) {
    delete proxyRes.headers['content-length'];
    res.removeHeader('content-length');
    const chunks = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    res.write = function (chunk, ...rest) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return true;
    };
    res.end = function (chunk, ...rest) {
      if (chunk !== undefined && chunk !== null) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      res.write = origWrite;
      res.end = origEnd;
      let body = Buffer.concat(chunks).toString('utf8');
      if (body.includes(LOOPBACK_JS_NEEDLE)) {
        body = body.split(LOOPBACK_JS_NEEDLE).join(LOOPBACK_JS_REPLACEMENT);
      }
      origEnd(Buffer.from(body), ...rest);
    };
  }
});

// Align Origin for DSH /api CSRF checks and WebSocket handshake
function alignOrigin(req) {
  if (req.headers.origin) req.headers.origin = TARGET_ORIGIN;
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://proxy').pathname;
  if (!PUBLIC_PATHS.has(pathname) && !checkAuth(req)) {
    rejectUnauthorized(res);
    return;
  }
  alignOrigin(req);
  proxy.web(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (!checkAuth(req)) {
    rejectUpgrade(socket);
    return;
  }
  alignOrigin(req);
  proxy.ws(req, socket, head);
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[proxy] Proxy listening on 0.0.0.0:${LISTEN_PORT} -> ${TARGET_ORIGIN}${AUTH_USER && AUTH_PASS ? ' (Basic Auth enabled)' : ' (No Auth)'}`);
});

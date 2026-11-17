// The HTTP server: routing, Bearer auth, deterministic request ids, and the
// JSON error envelope. Every response is application/json with a non-empty
// x-github-request-id, including errors and unknown routes. Hot paths serve
// pre-serialised buffers with an explicit Content-Length (no chunked encoding).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { FIXED_ISO, Store, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME } from './store.ts';
import { HttpError, handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Constant-time bearer comparison; false when no token is configured. */
function isAuthorized(req: IncomingMessage): boolean {
  const configured = process.env.MAKEFUN_SHOP_TOKEN;
  if (!configured) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(configured, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: Buffer, contentType: string, extra?: Record<string, string>): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  send(res, status, Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), 'application/json', extra);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body. An empty body is undefined; malformed JSON is a 400. */
function parseJsonBody(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'malformed JSON body');
  }
}

const API_ROOT = {
  current_user_url: '{/api/v3/user}',
  repository_url: '{/api/v3/repos/{owner}/{repo}}',
  user_repositories_url: '{/api/v3/user/repos}',
  meta_url: '{/api/v3/meta}',
};

/** The route handler. `store` is the process-wide in-memory forge. */
async function handle(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const segments = pathname.split('/').filter((segment) => segment !== '');

  // Health and the unauthenticated API root/meta: no token needed.
  if (pathname === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if ((pathname === '/api/v3' || pathname === '/api/v3/') && method === 'GET') {
    sendJson(res, 200, API_ROOT, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (pathname === '/api/v3/meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return;
  }

  // Everything else needs the shop token.
  if (!isAuthorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  if (pathname === '/api/v3/user' && method === 'GET') {
    sendJson(res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      created_at: FIXED_ISO,
    });
    return;
  }

  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const body = parseJsonBody(raw);
    const result = handleGraphQL(store, body);
    send(res, result.status, result.body, 'application/json');
    return;
  }

  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      send(res, 200, Buffer.alloc(0), 'application/json');
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(store, raw);
    send(res, result.status, result.body, 'application/json');
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/info/refs and the two RPC endpoints.
  if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
    const owner = segments[0]!;
    const repoName = segments[1]!.slice(0, -'.git'.length);
    const suffix = segments.slice(2).join('/');
    const repo = store.getRepo(owner, repoName);
    if (suffix === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      const protocol = req.headers['git-protocol'];
      const result = handleInfoRefs(repo, service, typeof protocol === 'string' ? protocol : undefined);
      send(res, result.status, result.body, result.contentType);
      return;
    }
    if (suffix === 'git-upload-pack' && method === 'POST') {
      const raw = await readBody(req);
      const result = handleUploadPack(repo, raw);
      send(res, result.status, result.body, result.contentType);
      return;
    }
    if (suffix === 'git-receive-pack' && method === 'POST') {
      const raw = await readBody(req);
      const result = handleReceivePack(repo, raw);
      send(res, result.status, result.body, result.contentType);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'v3') {
    const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const body = parseJsonBody(raw);
    const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
    const result = handleRest({
      store,
      method,
      segments: segments.slice(2),
      query: url.searchParams,
      body,
      origin,
    });
    if (result === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    send(res, result.status, result.body, 'application/json', result.headers);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    req.socket.setNoDelay(true);
    handle(store, req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { message: err.message });
        return;
      }
      process.stderr.write(`[entry] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 6_000;
  return server;
}

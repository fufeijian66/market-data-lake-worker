// Cloudflare Access JWT 校验中间件（架构红线 #9）
// - 读 Cf-Access-Jwt-Assertion 头
// - 拉 https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs 的 JWKS（带本地缓存）
// - 验签 + aud + exp
// - 失败：/admin/* 重定向到 Access 登录页；/api/* 返回 401 JSON
// - ENVIRONMENT === 'development' 时跳过（用于 wrangler dev）

import type { Env } from './types';

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

// 每个 isolate 独立的内存缓存；Cloudflare 会复用 isolate
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 小时

async function getJwks(teamDomain: string): Promise<Jwk[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const resp = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!resp.ok) throw new Error(`JWKS fetch failed: HTTP ${resp.status}`);
  const json = (await resp.json()) as { keys: Jwk[] };
  jwksCache = { keys: json.keys, fetchedAt: now };
  return json.keys;
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
}

async function importJwk(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg ?? 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

export interface AccessIdentity {
  email?: string;
  sub: string;
  aud: string | string[];
  exp: number;
}

/** 校验 JWT，失败抛 Error；成功返回 payload */
async function verifyAccessJwt(token: string, env: Env): Promise<AccessIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT');
  const [headerB64, payloadB64, sigB64] = parts;

  const header = b64urlToJson<{ kid: string; alg: string }>(headerB64);
  const payload = b64urlToJson<AccessIdentity>(payloadB64);

  const jwks = await getJwks(env.ACCESS_TEAM_DOMAIN);
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error(`unknown kid ${header.kid}`);

  const key = await importJwk(jwk);
  const sig = b64urlToBytes(sigB64);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!ok) throw new Error('signature verification failed');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error('token expired');

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(env.ACCESS_AUD)) throw new Error('aud mismatch');

  return payload;
}

/**
 * Worker 路由中间件：成功 resolve identity；失败 throw Response（401 JSON 或 302 重定向）
 * 调用方用 try/catch 捕获，把 Response 直接返回给客户端。
 */
export async function requireAccess(req: Request, env: Env): Promise<AccessIdentity> {
  // 本地开发跳过（在 .dev.vars 里设 ENVIRONMENT=development）
  if (env.ENVIRONMENT === 'development') {
    return { sub: 'dev', aud: env.ACCESS_AUD, exp: 9_999_999_999, email: 'dev@local' };
  }

  const token = req.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/admin')) {
      // 重定向到 Access 登录页（Access 会带回当前路径）
      throw Response.redirect(`https://${env.ACCESS_TEAM_DOMAIN}/`, 302);
    }
    throw new Response(JSON.stringify({ error: 'missing access token' }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  try {
    return await verifyAccessJwt(token, env);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Response(JSON.stringify({ error: 'invalid access token', detail }), {
      status: 401,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}

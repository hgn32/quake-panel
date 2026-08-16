/**
 * 上流 (kmoni / P2P) へプロキシ経由で出ていくための設定。
 *
 * UPSTREAM_API_PROXY_URL が無ければ何もしない (直接接続のまま)。
 * HTTP 取得も WebSocket も同じプロキシを使う。
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/** 上流 API に使うプロキシ URL を指定する環境変数。 */
export const UPSTREAM_PROXY_ENV = 'UPSTREAM_API_PROXY_URL';

/**
 * 上流 API に使うプロキシ URL。未設定 (または空白だけ) なら null。
 *
 * 値が URL として壊れている場合はここでは弾かず、agent の生成時にエラーにする。
 * 黙って直接接続に落ちると設定ミスに気付けないため。
 */
export function resolveProxyUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = (env[UPSTREAM_PROXY_ENV] ?? '').trim();
  return value === '' ? null : value;
}

/**
 * fetch 全体をプロキシ経由に切り替える。
 * 設定したときはプロキシ URL を、何もしなかったときは null を返す (ログ用)。
 */
export function applyGlobalProxy(env: NodeJS.ProcessEnv = process.env): string | null {
  const proxyUrl = resolveProxyUrl(env);
  if (proxyUrl === null) return null;
  // 周囲の HTTP_PROXY / NO_PROXY に左右されないよう、値は明示的に渡す。
  setGlobalDispatcher(
    new EnvHttpProxyAgent({ httpProxy: proxyUrl, httpsProxy: proxyUrl, noProxy: '' }),
  );
  return proxyUrl;
}

/** WebSocket 用のプロキシ agent。ws は環境変数を見ないので明示的に渡す必要がある。 */
export function createWsProxyAgent(
  env: NodeJS.ProcessEnv = process.env,
): HttpsProxyAgent<string> | null {
  const proxyUrl = resolveProxyUrl(env);
  return proxyUrl === null ? null : new HttpsProxyAgent(proxyUrl);
}

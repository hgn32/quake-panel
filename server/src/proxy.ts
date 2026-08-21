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

/** EnvHttpProxyAgent に渡す設定。 */
export interface ProxyAgentOptions {
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
  proxyTunnel: boolean;
}

/**
 * EnvHttpProxyAgent に渡すオプションを組み立てる。
 *
 * `proxyTunnel: false` が必要な理由:
 * undici は既定で宛先が平文 http であっても CONNECT でトンネルを張る。
 * しかし Squid (UPSTREAM_API_PROXY_URL の先) は既定で :80 への CONNECT を
 * 拒否する。kmoni (http://www.kmoni.bosai.go.jp) は平文 http のみを提供し
 * https を持たないため、このままでは kmoni への全リクエストが
 * `TypeError: fetch failed (cause: Request was cancelled.)` で即失敗する。
 * `proxyTunnel: false` を渡すと undici は平文 http 宛にだけ CONNECT を使わず
 * 絶対 URI 形式の forward proxy でリクエストするようになり、Squid の制限を
 * 迂回できる。https 宛 (p2p 地震情報など) はこの設定でも従来どおり CONNECT
 * トンネルのままなので、p2p 側の挙動には影響しない。
 */
export function buildProxyAgentOptions(proxyUrl: string): ProxyAgentOptions {
  return {
    httpProxy: proxyUrl,
    httpsProxy: proxyUrl,
    // 周囲の HTTP_PROXY / NO_PROXY に左右されないよう、値は明示的に渡す。
    noProxy: '',
    proxyTunnel: false,
  };
}

/**
 * fetch 全体をプロキシ経由に切り替える。
 * 設定したときはプロキシ URL を、何もしなかったときは null を返す (ログ用)。
 */
export function applyGlobalProxy(env: NodeJS.ProcessEnv = process.env): string | null {
  const proxyUrl = resolveProxyUrl(env);
  if (proxyUrl === null) return null;
  setGlobalDispatcher(new EnvHttpProxyAgent(buildProxyAgentOptions(proxyUrl)));
  return proxyUrl;
}

/** WebSocket 用のプロキシ agent。ws は環境変数を見ないので明示的に渡す必要がある。 */
export function createWsProxyAgent(
  env: NodeJS.ProcessEnv = process.env,
): HttpsProxyAgent<string> | null {
  const proxyUrl = resolveProxyUrl(env);
  return proxyUrl === null ? null : new HttpsProxyAgent(proxyUrl);
}

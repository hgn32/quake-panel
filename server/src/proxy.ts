/**
 * 社内プロキシ配下で上流 (kmoni / P2P) へ出ていくための設定。
 *
 * プロキシ環境変数が無ければ何もしない。Home Assistant アドオンとして動く本番では
 * 変数が無いので、これまで通り直接接続になる。
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/** プロキシ系の環境変数は大文字・小文字のどちらも使われるため両方を見る。 */
const pickEnv = (env: NodeJS.ProcessEnv, name: string): string =>
  (env[name.toUpperCase()] ?? env[name.toLowerCase()] ?? '').trim();

const parseUrlOrNull = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * NO_PROXY の 1 エントリがホスト名に当たるか。
 * `*` は全除外、`example.com` / `.example.com` はサフィックス一致 (curl と同じ扱い)。
 */
const matchesNoProxyEntry = (hostname: string, entry: string): boolean => {
  const trimmed = entry.trim().toLowerCase();
  if (trimmed === '') return false;
  if (trimmed === '*') return true;
  // `example.com:443` のようにポートが付く書き方も許す
  const withoutPort = trimmed.split(':')[0] ?? '';
  const host = withoutPort.startsWith('.') ? withoutPort.slice(1) : withoutPort;
  if (host === '') return false;
  return hostname === host || hostname.endsWith(`.${host}`);
};

/** NO_PROXY によってプロキシを迂回すべきホストか。 */
export function isProxyBypassed(hostname: string, noProxy: string): boolean {
  const target = hostname.toLowerCase();
  return noProxy.split(',').some((entry) => matchesNoProxyEntry(target, entry));
}

/**
 * 対象 URL に使うプロキシ URL。プロキシを通さない場合は null。
 *
 * https / wss は HTTPS_PROXY、http / ws は HTTP_PROXY を見る (curl・undici と同じ規則)。
 */
export function resolveProxyUrl(targetUrl: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const parsed = parseUrlOrNull(targetUrl);
  if (parsed === null) return null;
  if (isProxyBypassed(parsed.hostname, pickEnv(env, 'NO_PROXY'))) return null;
  const isSecure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const proxyUrl = isSecure ? pickEnv(env, 'HTTPS_PROXY') : pickEnv(env, 'HTTP_PROXY');
  return proxyUrl === '' ? null : proxyUrl;
}

/**
 * fetch 全体をプロキシ経由に切り替える。NO_PROXY は undici 側が解釈する。
 * 設定したときはプロキシ URL を、何もしなかったときは null を返す (ログ用)。
 */
export function applyGlobalProxy(env: NodeJS.ProcessEnv = process.env): string | null {
  const httpProxy = pickEnv(env, 'HTTP_PROXY');
  const httpsProxy = pickEnv(env, 'HTTPS_PROXY');
  if (httpProxy === '' && httpsProxy === '') return null;
  setGlobalDispatcher(new EnvHttpProxyAgent());
  return httpsProxy === '' ? httpProxy : httpsProxy;
}

/** WebSocket 用のプロキシ agent。ws は環境変数を見ないので明示的に渡す必要がある。 */
export function createWsProxyAgent(
  wsUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): HttpsProxyAgent<string> | null {
  const proxyUrl = resolveProxyUrl(wsUrl, env);
  return proxyUrl === null ? null : new HttpsProxyAgent(proxyUrl);
}

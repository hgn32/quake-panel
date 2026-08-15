/** 上流 (kmoni / P2P) への HTTP アクセス。タイムアウトと 404 の扱いをここへ集約する。 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

export interface FetchOptions {
  timeoutMs: number;
  /**
   * 固定 URL を叩くリクエスト向け。
   * kmoni は latest.json にも `cache-control: public, max-age=10800` を付けてくるため、
   * 間に透過プロキシがいると古い時刻を掴まされる (実測: docs/kmoni-endpoints.md)。
   */
  noStore?: boolean;
  /**
   * リダイレクトを「その画像は無い」と解釈する。
   *
   * 生成されていない予測円・予想震度の画像は 404 ではなく nodata.gif への
   * 302 が返る (実測、docs/kmoni-endpoints.md)。追従すると中身のない
   * プレースホルダを掴んでしまうので、画像取得ではこれを有効にする。
   */
  missingOnRedirect?: boolean;
  signal?: AbortSignal;
}

function request(url: string, opts: FetchOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), opts.timeoutMs);
  const onAbort = (): void => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  // 成否によらずタイマーと購読を必ず外す (finally 相当)
  const cleanup = (): void => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  };
  return fetch(url, {
    signal: controller.signal,
    headers: {
      'user-agent': 'quake-panel/0.1 (private household display)',
      ...(opts.noStore ? { 'cache-control': 'no-cache', pragma: 'no-cache' } : {}),
    },
    redirect: opts.missingOnRedirect ? 'manual' : 'follow',
  }).then(
    (res) => {
      cleanup();
      return res;
    },
    (error: Error) => {
      cleanup();
      return Promise.reject(error);
    },
  );
}

export function fetchJson<T>(url: string, opts: FetchOptions): Promise<T> {
  return request(url, opts).then((res) => {
    if (!res.ok) return Promise.reject(new HttpError(res.status, url));
    return res.json() as Promise<T>;
  });
}

export interface BinaryResponse {
  body: Buffer;
  contentType: string;
  /** 上流の Last-Modified (取得遅延の実測に使う) */
  lastModified: string | null;
}

/** 画像取得。存在しない (まだ生成されていない) 場合は null を返す。 */
export function fetchBinary(url: string, opts: FetchOptions): Promise<BinaryResponse | null> {
  return request(url, { ...opts, missingOnRedirect: opts.missingOnRedirect ?? true }).then((res) => {
    if (res.status === 404) return null;
    if (res.status >= 300 && res.status < 400) return null;
    if (!res.ok) return Promise.reject(new HttpError(res.status, url));
    return res.arrayBuffer().then((buffer) => ({
      body: Buffer.from(buffer),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      lastModified: res.headers.get('last-modified'),
    }));
  });
}

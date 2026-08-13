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

async function request(url: string, opts: FetchOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), opts.timeoutMs);
  const onAbort = (): void => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'quake-panel/0.1 (private household display)',
        ...(opts.noStore ? { 'cache-control': 'no-cache', pragma: 'no-cache' } : {}),
      },
      redirect: opts.missingOnRedirect ? 'manual' : 'follow',
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

export async function fetchJson<T>(url: string, opts: FetchOptions): Promise<T> {
  const res = await request(url, opts);
  if (!res.ok) throw new HttpError(res.status, url);
  return (await res.json()) as T;
}

export interface BinaryResponse {
  body: Buffer;
  contentType: string;
  /** 上流の Last-Modified (取得遅延の実測に使う) */
  lastModified: string | null;
}

/** 画像取得。存在しない (まだ生成されていない) 場合は null を返す。 */
export async function fetchBinary(url: string, opts: FetchOptions): Promise<BinaryResponse | null> {
  const res = await request(url, { ...opts, missingOnRedirect: opts.missingOnRedirect ?? true });
  if (res.status === 404) return null;
  if (res.status >= 300 && res.status < 400) return null;
  if (!res.ok) throw new HttpError(res.status, url);
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    body: buf,
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    lastModified: res.headers.get('last-modified'),
  };
}

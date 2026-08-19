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

/**
 * fetch() の Response と、その後始末 (タイマー解除・abort 購読解除) をひとまとめにしたもの。
 * cleanup はヘッダ受信時点では呼ばない (呼び出し側が本文を読み終えてから呼ぶ)。
 * こうしないと、ヘッダだけ返して本文を止める上流に対して timeoutMs が効かなくなる
 * (本文読み取り = res.json()/res.arrayBuffer() が undici 既定の約 300 秒まで pend する)。
 */
interface RequestResult {
  res: Response;
  cleanup: () => void;
}

function request(url: string, opts: FetchOptions): Promise<RequestResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), opts.timeoutMs);
  const onAbort = (): void => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  // 本文読み取りが終わるまでタイマーと購読を外さない。呼び出し側が cleanup() を呼ぶ。
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
    (res) => ({ res, cleanup }),
    (error: Error) => {
      cleanup();
      return Promise.reject(error);
    },
  );
}

/** 使わない応答の body を読み捨てて接続資源を解放する (404/3xx/エラー応答向け)。 */
function discardBody(res: Response): Promise<void> {
  if (!res.body) return Promise.resolve();
  return res.body.cancel().then(
    () => undefined,
    () => undefined,
  );
}

export function fetchJson<T>(url: string, opts: FetchOptions): Promise<T> {
  return request(url, opts).then(({ res, cleanup }) => {
    if (!res.ok) {
      return discardBody(res)
        .finally(cleanup)
        .then(() => Promise.reject(new HttpError(res.status, url)));
    }
    return res.json().finally(cleanup) as Promise<T>;
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
  return request(url, { ...opts, missingOnRedirect: opts.missingOnRedirect ?? true }).then(({ res, cleanup }) => {
    if (res.status === 404) {
      return discardBody(res).finally(cleanup).then(() => null);
    }
    if (res.status >= 300 && res.status < 400) {
      return discardBody(res).finally(cleanup).then(() => null);
    }
    if (!res.ok) {
      return discardBody(res)
        .finally(cleanup)
        .then(() => Promise.reject(new HttpError(res.status, url)));
    }
    return res
      .arrayBuffer()
      .finally(cleanup)
      .then((buffer) => ({
        body: Buffer.from(buffer),
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        lastModified: res.headers.get('last-modified'),
      }));
  });
}

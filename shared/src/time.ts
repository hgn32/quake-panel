/**
 * kmoni / P2P はどちらも日本時間の文字列しか返さない。
 * サーバーの TZ 設定に依存しないよう、JST(+09:00) 固定で相互変換する。
 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const pad = (n: number, len = 2): string => String(n).padStart(len, '0');

/** Date → kmoni の URL に使う "YYYYMMDDhhmmss" (JST) */
export function toKmoniTimestamp(date: Date): string {
  const j = new Date(date.getTime() + JST_OFFSET_MS);
  return (
    `${j.getUTCFullYear()}${pad(j.getUTCMonth() + 1)}${pad(j.getUTCDate())}` +
    `${pad(j.getUTCHours())}${pad(j.getUTCMinutes())}${pad(j.getUTCSeconds())}`
  );
}

/** kmoni タイムスタンプの日付部分 (画像 URL のディレクトリ名) */
export function kmoniDatePart(timestamp: string): string {
  return timestamp.slice(0, 8);
}

/**
 * 年月日時分秒 (+ ミリ秒) が実在する日時かどうか。
 *
 * `d <= 31` や `h <= 23` のような桁数だけの範囲チェックだと、存在しない日付
 * (例: 2月30日) や範囲外の時刻 (例: 25時) を `Date.UTC` がそのまま翌日・翌月へ
 * ロールオーバーさせて通してしまう。`Date.UTC` で組み立てた結果を分解し直して
 * 入力の各成分と一致するかを確かめれば、ロールオーバーしたかどうかを
 * 取りこぼしなく検出できる。
 */
function isValidDateComponents(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
): boolean {
  const rebuilt = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  return (
    rebuilt.getUTCFullYear() === y &&
    rebuilt.getUTCMonth() === mo - 1 &&
    rebuilt.getUTCDate() === d &&
    rebuilt.getUTCHours() === h &&
    rebuilt.getUTCMinutes() === mi &&
    rebuilt.getUTCSeconds() === s &&
    rebuilt.getUTCMilliseconds() === ms
  );
}

/** "YYYYMMDDhhmmss" (JST) → Date。不正なら null。 */
export function fromKmoniTimestamp(timestamp: string): Date | null {
  if (!/^\d{14}$/.test(timestamp)) return null;
  const y = Number(timestamp.slice(0, 4));
  const mo = Number(timestamp.slice(4, 6));
  const d = Number(timestamp.slice(6, 8));
  const h = Number(timestamp.slice(8, 10));
  const mi = Number(timestamp.slice(10, 12));
  const s = Number(timestamp.slice(12, 14));
  if (!isValidDateComponents(y, mo, d, h, mi, s, 0)) return null;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - JST_OFFSET_MS);
}

/**
 * "YYYY/MM/DD hh:mm:ss" 形式 (kmoni latest.json / P2P の time) を JST として解釈する。
 * P2P は "2026/08/13 11:09:55.123" のようにミリ秒が付くことがある。
 * ミリ秒は 1〜3 桁で来ることがあり、これは絶対値ではなく小数部の表記
 * (".5" は 500ms, ".76" は 760ms) なので、末尾を '0' で埋めてから数値化する。
 */
export function parseJstDateTime(text: string | null | undefined): Date | null {
  if (!text) return null;
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(
    text.trim(),
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  const yNum = Number(y);
  const moNum = Number(mo);
  const dNum = Number(d);
  const hNum = Number(h);
  const miNum = Number(mi);
  const sNum = Number(s);
  const msNum = ms ? Number(ms.padEnd(3, '0')) : 0;
  if (!isValidDateComponents(yNum, moNum, dNum, hNum, miNum, sNum, msNum)) return null;
  return new Date(Date.UTC(yNum, moNum - 1, dNum, hNum, miNum, sNum, msNum) - JST_OFFSET_MS);
}

/** Date → ISO8601。null 安全。 */
export function toIso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** ISO/Date → JST の "HH:MM:SS" */
export function formatJstClock(value: Date | string | number, withSeconds = true): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  const base = `${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
  return withSeconds ? `${base}:${pad(j.getUTCSeconds())}` : base;
}

/** ISO/Date → JST の "M/D HH:MM" */
export function formatJstDateTime(value: Date | string | number | null | undefined): string {
  if (value == null) return '--';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '--';
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
}

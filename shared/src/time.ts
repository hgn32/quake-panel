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

/** "YYYYMMDDhhmmss" (JST) → Date。不正なら null。 */
export function fromKmoniTimestamp(timestamp: string): Date | null {
  if (!/^\d{14}$/.test(timestamp)) return null;
  const y = Number(timestamp.slice(0, 4));
  const mo = Number(timestamp.slice(4, 6));
  const d = Number(timestamp.slice(6, 8));
  const h = Number(timestamp.slice(8, 10));
  const mi = Number(timestamp.slice(10, 12));
  const s = Number(timestamp.slice(12, 14));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - JST_OFFSET_MS);
}

/**
 * "YYYY/MM/DD hh:mm:ss" 形式 (kmoni latest.json / P2P の time) を JST として解釈する。
 * P2P は "2026/08/13 11:09:55.123" のようにミリ秒が付くことがある。
 */
export function parseJstDateTime(text: string | null | undefined): Date | null {
  if (!text) return null;
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(
    text.trim(),
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms] = m;
  return new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms ?? 0)) -
      JST_OFFSET_MS,
  );
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

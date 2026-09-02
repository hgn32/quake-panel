/**
 * 通知をいつ止めるか。
 *
 * 緊急地震速報は続報が途切れるまで「発表中」が続くため、遠方の地震でも
 * 数分間、明滅と警報状態が残ることがある。実際に台湾付近の地震で長く光り続けた。
 * 気づかせるのが目的なので、**気づいた後も鳴り続ける・光り続ける必要はない**。
 * 発表そのものは画面のパネルに出たままにして、音と明滅だけを打ち切る。
 */

/** 音を出し続ける上限 (秒) の既定値。最初のこれだけ鳴らして黙る。 */
export const DEFAULT_SOUND_SECONDS = 10;

/** 音の上限として選べる範囲 (0 は「パターンどおり鳴らし切る」) */
export const SOUND_SECONDS_RANGE = { min: 0, max: 120 } as const;

export function clampSoundSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SOUND_SECONDS;
  return Math.round(Math.min(Math.max(value, SOUND_SECONDS_RANGE.min), SOUND_SECONDS_RANGE.max));
}

/** 明滅を続ける上限 (秒) の既定値 */
export const DEFAULT_FLASH_SECONDS = 60;

/** 明滅の上限として選べる範囲 (0 は「止めない」) */
export const FLASH_SECONDS_RANGE = { min: 0, max: 600 } as const;

export function clampFlashSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FLASH_SECONDS;
  return Math.round(Math.min(Math.max(value, FLASH_SECONDS_RANGE.min), FLASH_SECONDS_RANGE.max));
}

/**
 * これから明滅させる残り時間 (ms)。0 なら「もう光らせない」、null なら「止めない」。
 *
 * 上限を「その画面が受け取った時刻」から数えると、発表から数分後に開いた画面が
 * また最初から光り直してしまう (実際に発表 5 分後に開いた画面で発生)。事象の
 * 発表時刻から数えることで、いつ開いても同じ時点で止まるようにする。
 *
 * @param startedAt 事象の発表時刻 (ISO)。取れなければ null (その場合は上限いっぱい光らせる)
 * @param now       いまの時刻 (ms)
 * @param flashSeconds 明滅の上限 (秒)。0 は「止めない」
 */
export function remainingFlashMs(
  startedAt: string | null,
  now: number,
  flashSeconds: number,
): number | null {
  if (flashSeconds <= 0) return null;
  const limit = flashSeconds * 1000;
  if (startedAt === null) return limit;
  const parsed = Date.parse(startedAt);
  if (Number.isNaN(parsed)) return limit;
  // 端末時計が事象の発表より前を指していても (now - parsed < 0)、
  // 上限いっぱい光らせるだけで済ませる (負の残り時間にしない)。
  return Math.max(0, limit - Math.max(0, now - parsed));
}

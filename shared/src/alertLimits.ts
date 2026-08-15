/**
 * 通知をいつ止めるか。
 *
 * 緊急地震速報は続報が途切れるまで「発表中」が続くため、遠方の地震でも
 * 数分間、明滅と警報状態が残ることがある。実際に台湾付近の地震で長く光り続けた。
 * 気づかせるのが目的なので、**気づいた後も鳴り続ける・光り続ける必要はない**。
 * 発表そのものは画面のパネルに出たままにして、音と明滅だけを打ち切る。
 */

/** 音を出し続ける上限 (秒)。最初のこれだけ鳴らして黙る。 */
export const ALERT_SOUND_SECONDS = 10;

/** 明滅を続ける上限 (秒) の既定値 */
export const DEFAULT_FLASH_SECONDS = 60;

/** 明滅の上限として選べる範囲 (0 は「止めない」) */
export const FLASH_SECONDS_RANGE = { min: 0, max: 600 } as const;

export function clampFlashSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FLASH_SECONDS;
  return Math.round(Math.min(Math.max(value, FLASH_SECONDS_RANGE.min), FLASH_SECONDS_RANGE.max));
}

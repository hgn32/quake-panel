import type { EewState } from '@quake-panel/shared';
import { intensityLabel } from '@quake-panel/shared';
import type { Config } from '../config.js';
import type { Hub } from '../hub.js';
import { createLogger } from '../logger.js';
import type { KmoniEewReport } from '../sources/kmoniEew.js';

const log = createLogger('eew');

/** キャンセル報を表示し続ける時間。誤報と分かった直後に消えると気づけないため少し残す。 */
const CANCEL_RETENTION_MS = 20_000;

/** 発震時刻がこの範囲で一致すれば、ID 表記が違っても同じ地震とみなす */
const SAME_EVENT_TOLERANCE_MS = 3000;

/** EEW の状態が動いた種別。'expired' は続報が途切れて表示を終了したとき。 */
export type EewEventKind = 'new' | 'update' | 'cancel' | 'expired';

export interface EewEvent {
  kind: EewEventKind;
  eew: EewState;
}

export interface EewCoordinatorDeps {
  config: Config;
  hub: Hub;
  /** EEW 発表中だけ予測円・予想震度レイヤを取りに行かせる */
  onActiveChange: (active: boolean) => void;
  /** EEW の状態が動くたびに呼ばれる (外部 webhook 通知など)。未設定なら何もしない。 */
  onEewEvent?: (event: EewEvent) => void;
}

/**
 * kmoni EEW JSON と P2P 556 をひとつの現況にまとめる。
 *
 * 役割分担:
 *   - kmoni: 予報から拾える (無償でこれが取れるのはここだけ)。地域別の予想震度は持たない。
 *   - P2P  : 警報のみだが、警報対象地域と気象庁配信の到達予測時刻を持つ。
 * 両方来る場合は kmoni の速報性と P2P の詳細を合成する。
 *
 * ここでは独自の到達予測・震度予測は一切行わない (§2(3) 気象業務法)。
 * 配信された値をそのまま保持して表示側へ渡すだけ。
 */
export class EewCoordinator {
  private current: EewState | null = null;
  private lastUpdateAt = 0;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly deps: EewCoordinatorDeps) {}

  start(): void {
    this.sweeper = setInterval(() => this.sweep(), 1000);
    this.sweeper.unref?.();
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  /** kmoni EEW JSON のポーリング結果。発表なしのときは null が来る。 */
  acceptKmoni(report: KmoniEewReport | null): void {
    if (!report) return;
    this.accept(kmoniToState(report));
  }

  /** P2P 556 (緊急地震速報 警報) */
  acceptP2P(state: EewState): void {
    this.accept(state);
  }

  private accept(incoming: EewState): void {
    const merged =
      this.current && isSameEvent(this.current, incoming)
        ? mergeStates(this.current, incoming)
        : this.pickNewer(incoming);
    if (!merged) return;

    const previous = this.current;
    const isNew = !previous || !isSameEvent(previous, merged);
    const cancelRising = merged.isCancel && !previous?.isCancel;
    if (isNew) {
      log.info(formatEewLogLine(merged));
    }
    if (cancelRising) {
      log.info(`EEW cancelled: ${merged.id}`);
    }

    this.current = merged;
    this.lastUpdateAt = Date.now();
    this.deps.hub.publishEew(merged);
    this.deps.onActiveChange(true);
    // kmoni EEW は毎秒ポーリングされ、発表中は同一報でもここまで来る。内容が実質的に
    // 変わっていないときまで webhook (onEewEvent) へ 'update' を流すと、発表中ずっと
    // 同一内容を秒間隔で POST し続けることになるため、Hub.hasEewChanged (hub.ts) と
    // 同じ基準の変化判定を挟んで抑止する。新規発表・キャンセル・内容変化は必ず通知する。
    const kind: EewEventKind = cancelRising ? 'cancel' : isNew ? 'new' : 'update';
    if (!previous || hasMeaningfulChange(previous, merged)) {
      this.deps.onEewEvent?.({ kind, eew: merged });
    }
  }

  /**
   * 別の地震が届いた場合。連続地震では新しい方を出す。
   * ただし、すでに表示中のものより明らかに古い電文は無視する。
   */
  private pickNewer(incoming: EewState): EewState | null {
    if (!this.current) return incoming;
    const a = timeOf(this.current);
    const b = timeOf(incoming);
    return b >= a ? incoming : null;
  }

  private sweep(): void {
    if (!this.current) return;
    const age = Date.now() - this.lastUpdateAt;
    const limit = this.current.isCancel ? CANCEL_RETENTION_MS : this.deps.config.eewRetentionMs;
    if (age < limit) return;
    log.debug(`EEW ${this.current.id} expired after ${Math.round(age / 1000)}s`);
    const expired = this.current;
    this.current = null;
    this.deps.hub.publishEew(null);
    this.deps.onActiveChange(false);
    this.deps.onEewEvent?.({ kind: 'expired', eew: expired });
  }
}

/**
 * 続報として意味のある差があるか (webhook への 'update' を抑止するための判定)。
 *
 * hub.ts の hasEewChanged と同じ基準にすること、という要件があるが hub.ts は
 * 編集禁止・関数も非公開のため、ここに同等のロジックを複製して持つ。
 * (フィールドを増減する際は両方を揃えて直すこと)
 */
function hasMeaningfulChange(a: EewState, b: EewState): boolean {
  return (
    a.id !== b.id ||
    a.reportNumber !== b.reportNumber ||
    a.isCancel !== b.isCancel ||
    a.isFinal !== b.isFinal ||
    a.alert !== b.alert ||
    a.maxIntensity !== b.maxIntensity ||
    a.source !== b.source ||
    a.hypocenter.name !== b.hypocenter.name ||
    a.hypocenter.lat !== b.hypocenter.lat ||
    a.hypocenter.lon !== b.hypocenter.lon ||
    a.hypocenter.depthKm !== b.hypocenter.depthKm ||
    a.hypocenter.magnitude !== b.hypocenter.magnitude ||
    a.regions.length !== b.regions.length
  );
}

/**
 * 新規発表時のログ 1 行を整形する。
 * `EewState.maxIntensity` は P2P 互換の整数コード (10=震度1, 45=5弱 …) であり、
 * そのままログへ出すと数字だけの読めない表示になるため、必ず `intensityLabel`
 * を通して「震度2」のような表示ラベルに変換してから出力する。
 */
export function formatEewLogLine(eew: EewState): string {
  const label = intensityLabel(eew.maxIntensity) ?? '?';
  return (
    `EEW ${eew.alert} ${eew.hypocenter.name} M${eew.hypocenter.magnitude ?? '?'} ` +
    `最大震度${label} (${eew.source})`
  );
}

function timeOf(state: EewState): number {
  const t = state.announcedAt ?? state.receivedAt;
  return new Date(t).getTime();
}

export function isSameEvent(a: EewState, b: EewState): boolean {
  if (a.id === b.id) return true;
  // kmoni の report_id と P2P の eventId は表記が異なるため、発震時刻でも突き合わせる
  if (a.originTime && b.originTime) {
    const diff = Math.abs(new Date(a.originTime).getTime() - new Date(b.originTime).getTime());
    if (diff <= SAME_EVENT_TOLERANCE_MS) return true;
  }
  return false;
}

/**
 * 同一地震の 2 電文を合成する。
 * 新しい報を土台にしつつ、片方にしか無い情報 (P2P の地域別予想震度など) を残す。
 */
export function mergeStates(current: EewState, incoming: EewState): EewState {
  const newer = timeOf(incoming) >= timeOf(current) ? incoming : current;
  const older = newer === incoming ? current : incoming;
  return {
    ...newer,
    // 警報は取り消されない限り降格させない (kmoni 予報の続報で警報表示が消えるのを防ぐ)
    alert: current.alert === 'warning' || incoming.alert === 'warning' ? 'warning' : newer.alert,
    isCancel: current.isCancel || incoming.isCancel,
    isTraining: current.isTraining || incoming.isTraining,
    reportNumber: Math.max(current.reportNumber, incoming.reportNumber),
    maxIntensity: newer.maxIntensity ?? older.maxIntensity,
    originTime: newer.originTime ?? older.originTime,
    regions: newer.regions.length > 0 ? newer.regions : older.regions,
    hypocenter: {
      name: newer.hypocenter.name !== '不明' ? newer.hypocenter.name : older.hypocenter.name,
      lat: newer.hypocenter.lat ?? older.hypocenter.lat,
      lon: newer.hypocenter.lon ?? older.hypocenter.lon,
      depthKm: newer.hypocenter.depthKm ?? older.hypocenter.depthKm,
      magnitude: newer.hypocenter.magnitude ?? older.hypocenter.magnitude,
    },
    source: current.source === incoming.source ? current.source : 'both',
  };
}

export function kmoniToState(report: KmoniEewReport): EewState {
  return {
    id: report.id,
    reportNumber: report.reportNumber,
    isFinal: report.isFinal,
    isCancel: report.isCancel,
    isTraining: report.isTraining,
    isAssumption: false,
    alert: report.alert,
    hypocenter: report.hypocenter,
    maxIntensity: report.maxIntensity,
    originTime: report.originTime ? report.originTime.toISOString() : null,
    announcedAt: report.announcedAt ? report.announcedAt.toISOString() : null,
    receivedAt: new Date().toISOString(),
    regions: [],
    source: 'kmoni',
  };
}

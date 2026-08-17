import {
  isDemoEventId,
  toKmoniTimestamp,
  type DemoScenario,
  type EewRegion,
  type EewState,
  type ServerEvent,
  type TsunamiArea,
  type TsunamiInfo,
} from '@quake-panel/shared';
import type { EewEvent, EewEventKind } from '../eew/coordinator.js';
import type { Hub } from '../hub.js';
import { createLogger } from '../logger.js';

const log = createLogger('demo');

/** デモのイベントだと分かるようにする接頭辞。isDemoEventId (shared) と揃えること。 */
const DEMO_ID_PREFIX = 'demo-';

const SCENARIOS: readonly DemoScenario[] = ['forecast', 'warning', 'cancel', 'tsunami'];

function isDemoScenario(value: string): value is DemoScenario {
  return (SCENARIOS as readonly string[]).includes(value);
}

/** デモの震源 (日向灘)。EewState.hypocenter と同じ形。 */
const DEMO_HYPOCENTER = { name: '日向灘', lat: 32.2, lon: 132.0, depthKm: 30, magnitude: 5.0 };

/** warning/cancel シナリオで警報へ格上げしたときの対象地域 */
const WARNING_REGIONS: EewRegion[] = [
  { pref: '宮崎', name: '宮崎県南部平野部', scaleFrom: 45, scaleTo: 45, arrivalTime: null, condition: null },
  { pref: '宮崎', name: '宮崎県北部平野部', scaleFrom: 45, scaleTo: 45, arrivalTime: null, condition: null },
];

/** 続報の間隔 (ms)。第1報 (offset 0) を含めて 11 報、最後が T0+20s になる。 */
const REPORT_OFFSETS_SEC = Array.from({ length: 11 }, (_, i) => i * 2);

/** T0 は「トリガ受信の 1 秒後」。以降のオフセットはすべてここからの経過秒で数える。 */
const T0_DELAY_MS = 1000;

interface EewSeriesOptions {
  /** この経過秒 (T0 起点) 以降、警報へ格上げする。未指定なら格上げしない。 */
  upgradeAtSec?: number;
  /** この経過秒以降、キャンセル報にする。未指定なら取り消さない。 */
  cancelAtSec?: number;
  /** この経過秒で eew:null を配信し、表示を終了する。 */
  clearAtSec: number;
}

/**
 * 本番パネルのデモ再生。
 *
 * 実電文と同形の EewState / TsunamiInfo を組み立て、Hub の通常配信経路
 * (hub.publishEew / hub.publishTsunami → 'event' → WebSocket 全端末) にそのまま乗せる。
 * こうすることで、Pi4 のキオスクを含む全端末で本物と全く同じ経路 (鳴動・明滅判定も含む) を
 * 確認できる。id は必ず `demo-` 接頭辞を付け、実電文とは判定で区別できるようにする。
 *
 * EewCoordinator との整合について:
 *   EewCoordinator は自分専用の `current` フィールドで実電文の続報合成・保持期限を
 *   管理しており、Hub の中身は読みに行かない (accept() の中でしか参照しない)。
 *   ここでは Hub の publishEew/publishTsunami を直接呼ぶだけで coordinator.current には
 *   一切触れないため、
 *     - デモ配信が coordinator の sweep() (保持期限切れの null 配信) に消されることはない
 *       (sweep は coordinator.current だけを見る。デモは current を書き換えない)。
 *     - デモの後に来た本物の続報も、coordinator.current が汚れていないので通常どおり
 *       合成される。
 *   唯一 Hub 側で共有されるのは「最後に配信した内容」のキャッシュ (hello/resync 用) だけで、
 *   これは実電文が来れば coordinator.accept() が publishEew() を呼び直すので上書きされる。
 *   ただし「本物の EEW/津波が現在進行中のときにデモを開始する」ケースだけは、
 *   coordinator の保持期限切れタイミングとデモの配信が競合しうるので、trigger() の時点で
 *   実イベント進行中なら開始そのものを見送ることで競合を無くしている (下記 realEewActive 等)。
 *
 * デモも実電文と同様に onEewEvent (webhook 連携) へ流す。id は demo- 接頭辞付きなので
 * 受信側で区別できる。津波デモは webhook 対象外 (EewEvent は EEW 専用) のため送らない。
 */
export class DemoRunner {
  private timers: NodeJS.Timeout[] = [];
  /** 本物の (demo- でない) EEW が現在表示中か */
  private realEewActive: boolean;
  /** 本物の (demo- でない) 津波予報が現在表示中 (解除されていない) か */
  private realTsunamiActive: boolean;

  constructor(
    private readonly hub: Hub,
    private readonly onEewEvent?: (event: EewEvent) => void,
  ) {
    this.realEewActive = hub.getEew() !== null;
    const tsunami = hub.getSnapshot().tsunami;
    this.realTsunamiActive = tsunami !== null && !tsunami.cancelled;
    hub.on('event', (event) => this.onHubEvent(event));
  }

  /** 設定画面のボタンから呼ばれる。scenario は JSON 由来なので実行時に検証する。 */
  trigger(scenario: string): void {
    if (!isDemoScenario(scenario)) {
      log.warn(`未知のデモシナリオを無視しました: ${scenario}`);
      return;
    }
    if (scenario === 'tsunami' ? this.realTsunamiActive : this.realEewActive) {
      log.warn(`実イベントが進行中のため、デモ (${scenario}) の開始を見送りました`);
      return;
    }

    // 前のデモが進行中なら止めて上書きする
    this.cancelTimers();

    const t0 = Date.now() + 1000;
    const id = `${DEMO_ID_PREFIX}${toKmoniTimestamp(new Date(t0))}`;
    log.info(`デモ再生を開始します: ${scenario} (id=${id})`);

    switch (scenario) {
      case 'forecast':
        this.runEewSeries(id, t0, { clearAtSec: 35 });
        break;
      case 'warning':
        this.runEewSeries(id, t0, { upgradeAtSec: 8, clearAtSec: 35 });
        break;
      case 'cancel':
        this.runEewSeries(id, t0, { upgradeAtSec: 8, cancelAtSec: 14, clearAtSec: 25 });
        break;
      case 'tsunami':
        this.runTsunami(id, t0);
        break;
      default:
        break;
    }
  }

  /** 実イベント優先。デモ以外の EEW/津波を受けたら、進行中のデモのタイマーを即中止する。 */
  private onHubEvent(event: ServerEvent): void {
    if (event.type === 'eew') {
      if (event.eew === null) {
        this.realEewActive = false;
        return;
      }
      if (isDemoEventId(event.eew.id)) return;
      this.realEewActive = true;
      if (this.timers.length > 0) {
        log.info('実際の EEW を受信したため、進行中のデモを中止します');
        this.cancelTimers();
      }
      return;
    }
    if (event.type === 'tsunami') {
      if (isDemoEventId(event.tsunami.id)) return;
      this.realTsunamiActive = !event.tsunami.cancelled;
      if (!event.tsunami.cancelled && this.timers.length > 0) {
        log.info('実際の津波予報を受信したため、進行中のデモを中止します');
        this.cancelTimers();
      }
    }
  }

  private runEewSeries(id: string, t0: number, options: EewSeriesOptions): void {
    // clearAtSec のタイマーで expired イベントを発火するために、最後に配信した状態を控えておく。
    let lastState: EewState | null = null;
    REPORT_OFFSETS_SEC.forEach((offsetSec, index) => {
      this.after(T0_DELAY_MS + offsetSec * 1000, () => {
        const isFinal = index === REPORT_OFFSETS_SEC.length - 1;
        const upgraded = options.upgradeAtSec !== undefined && offsetSec >= options.upgradeAtSec;
        const cancelled = options.cancelAtSec !== undefined && offsetSec >= options.cancelAtSec;
        const reportNumber = index + 1;
        log.info(
          `デモ EEW 第${reportNumber}報 ${upgraded ? '警報' : '予報'}${cancelled ? ' (取消)' : ''} を配信`,
        );
        const state = buildEewState(id, t0, offsetSec, reportNumber, isFinal, upgraded, cancelled);
        this.hub.publishEew(state);
        // coordinator.accept() の cancelRising/isNew 判定 (eew/coordinator.ts) を模した簡易版。
        const prevOffsetSec = index > 0 ? REPORT_OFFSETS_SEC[index - 1] : undefined;
        const prevCancelled =
          options.cancelAtSec !== undefined && prevOffsetSec !== undefined && prevOffsetSec >= options.cancelAtSec;
        const cancelRising = cancelled && !prevCancelled;
        const kind: EewEventKind = cancelRising ? 'cancel' : index === 0 ? 'new' : 'update';
        lastState = state;
        this.onEewEvent?.({ kind, eew: state });
      });
    });
    this.after(T0_DELAY_MS + options.clearAtSec * 1000, () => {
      log.info(`デモ EEW ${id} の表示を終了します`);
      this.hub.publishEew(null);
      if (lastState !== null) {
        this.onEewEvent?.({ kind: 'expired', eew: lastState });
      }
    });
  }

  private runTsunami(id: string, t0: number): void {
    this.after(T0_DELAY_MS, () => {
      log.info(`デモ津波予報 ${id} を配信`);
      this.hub.publishTsunami(buildTsunamiInfo(id, t0));
    });
    this.after(T0_DELAY_MS + 40_000, () => {
      log.info(`デモ津波予報 ${id} の解除を配信`);
      this.hub.publishTsunami({ ...buildTsunamiInfo(id, t0), cancelled: true, areas: [] });
    });
    // T0+50s: 仕様上は「現況から消す」タイミングだが、ServerEvent の tsunami は
    // EewState と違って null を持てず、Hub.publishTsunami も解除後の状態を
    // areas: [] のまま snapshot に残し続ける設計になっている (hub.ts 参照)。
    // つまり T0+40s の解除がそのまま最終状態であり、+50s の時点で追加に配信すべき
    // ものは無い。クライアントも cancelled/areas 空を見て非表示にするので、
    // ここでは何も送らない。
  }

  private cancelTimers(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers = [];
  }

  private after(delayMs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== timer);
      fn();
    }, delayMs);
    this.timers.push(timer);
  }
}

function buildEewState(
  id: string,
  t0: number,
  offsetSec: number,
  reportNumber: number,
  isFinal: boolean,
  upgraded: boolean,
  cancelled: boolean,
): EewState {
  const announcedAt = new Date(t0 + offsetSec * 1000).toISOString();
  return {
    id,
    reportNumber,
    isFinal,
    isCancel: cancelled,
    isTraining: false,
    isAssumption: false,
    alert: upgraded ? 'warning' : 'forecast',
    hypocenter: { ...DEMO_HYPOCENTER },
    maxIntensity: upgraded ? 45 : 40,
    originTime: new Date(t0).toISOString(),
    announcedAt,
    receivedAt: announcedAt,
    regions: upgraded ? WARNING_REGIONS.map((region) => ({ ...region })) : [],
    source: upgraded ? 'both' : 'kmoni',
  };
}

function buildTsunamiInfo(id: string, t0: number): TsunamiInfo {
  const areas: TsunamiArea[] = [
    {
      name: '宮崎県',
      grade: 'Warning',
      immediate: true,
      firstHeightCondition: '津波到達中と推測',
      firstHeightArrivalTime: null,
      maxHeightDescription: '3m',
      maxHeightValue: 3,
      isHome: false,
    },
    {
      name: '大分県瀬戸内海沿岸',
      grade: 'Watch',
      immediate: false,
      firstHeightCondition: null,
      firstHeightArrivalTime: null,
      maxHeightDescription: '1m',
      maxHeightValue: 1,
      isHome: false,
    },
  ];
  const issuedAt = new Date(t0).toISOString();
  return {
    id,
    issuedAt,
    cancelled: false,
    areas,
    affectsHome: false,
    receivedAt: issuedAt,
  };
}

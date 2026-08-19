import {
  DEFAULT_FLASH_SECONDS,
  type EewRelevance,
  type EewState,
  type TsunamiInfo,
} from '@quake-panel/shared';
import { AlertAudio, type AlertSound } from './audio.js';

export type FlashLevel = 'none' | 'forecast' | 'warning' | 'tsunami';

/**
 * 「モニターを注視していなくても気づける」ための層 (§1)。
 *
 * 明滅は CSS アニメーションに任せる。requestAnimationFrame で色を書き換えると
 * 描画スレッドを常時起こすことになり、非力な表示端末では地図描画と食い合う (§4)。
 */
export class AlertPresenter {
  readonly audio = new AlertAudio();
  private level: FlashLevel = 'none';
  /**
   * 同じ事象で鳴らし直さないための記録。
   * 系統ごとに分けておかないと、再接続で現況一括を受け直したときに鳴り直す。
   */
  private lastSound = { eew: '', detection: '' };
  /** 津波で前回鳴らした (自分にとっての) ランク。0 は未発表・対象外 */
  private lastTsunamiRank = 0;
  /** いま津波の事象が続いているか。解除・対象消滅で false に戻す */
  private tsunamiActive = false;
  /**
   * 津波の「事象の通し番号」。
   * 発表 (552) の id は続報のたびに変わってしまい鳴動の区切りに使えないため、
   * 事象が始まる (active になる) たびにここを進めて、明滅の打ち切り単位に使う。
   */
  private tsunamiSeries = 0;
  /** 明滅を続ける上限 (秒)。0 なら止めない。 */
  private flashSeconds = DEFAULT_FLASH_SECONDS;
  private flashTimer: number | null = null;
  /** 打ち切った事象。同じ事象では光らせ直さない (続報のたびに再点灯しないため) */
  private mutedKey: string | null = null;

  constructor(private readonly flashElement: HTMLElement) {}

  /** 端末ごとの設定から上限を受け取る */
  setFlashSeconds(seconds: number): void {
    this.flashSeconds = seconds;
  }

  setFlash(level: FlashLevel): void {
    if (this.level === level) return;
    this.level = level;
    this.flashElement.dataset['level'] = level;
    this.flashElement.classList.toggle('flash--active', level !== 'none');
  }

  getFlash(): FlashLevel {
    return this.level;
  }

  /**
   * 明滅の反映。上限を過ぎた事象は光らせない。
   *
   * 「発表中はずっと光る」だと、遠方の地震で数分間光り続ける。気づいた後まで
   * 光らせる意味は無いので、上限を過ぎたら **その事象については** 消す。
   * 続報で震度や警報種別が変われば別の事象として光り直す。
   *
   * 呼び出しは applyTsunamiSound の後であること (tsunamiSeries の更新順に依存する)。
   */
  applyFlash(
    eew: EewState | null,
    eewRelevance: EewRelevance,
    tsunami: TsunamiInfo | null,
    tsunamiRank: number,
    notifyForecast: boolean,
  ): void {
    const level = this.resolveFlash(eew, eewRelevance, tsunami, tsunamiRank, notifyForecast);
    if (level === 'none') {
      this.clearFlashTimer();
      this.setFlash('none');
      return;
    }

    const key = this.flashKey(eew, eewRelevance, tsunamiRank, level);
    if (key === this.mutedKey) {
      this.setFlash('none');
      return;
    }
    // 別の事象になったらタイマーを引き直す
    if (this.flashTimer === null || key !== this.timerKey) {
      this.clearFlashTimer();
      this.timerKey = key;
      if (this.flashSeconds > 0) {
        this.flashTimer = window.setTimeout(() => {
          this.flashTimer = null;
          this.mutedKey = key;
          this.setFlash('none');
        }, this.flashSeconds * 1000);
      }
    }
    this.setFlash(level);
  }

  private timerKey: string | null = null;

  private clearFlashTimer(): void {
    if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
    this.flashTimer = null;
    this.timerKey = null;
  }

  /**
   * いま出すべき明滅の強さ。EEW と津波が同時に出ているときは EEW を優先する。
   *
   * 訓練報とキャンセル報では明滅しない。キャンセル報が来たら即座に止まることが
   * 受け入れ条件 (§6「誤報時に明滅を止める」)。
   * 「予報まで明滅させるか」は端末ごとの設定 (§3)。
   * どちらも「利用地にとっての関わり (relevance / rank)」で絞る。表示は常に全国分。
   */
  resolveFlash(
    eew: EewState | null,
    eewRelevance: EewRelevance,
    tsunami: TsunamiInfo | null,
    tsunamiRank: number,
    notifyForecast: boolean,
  ): FlashLevel {
    if (eew && !eew.isCancel && !eew.isTraining) {
      if (eewRelevance === 'warning') return 'warning';
      if (eewRelevance === 'forecast' && notifyForecast) return 'forecast';
    }
    if (tsunamiRank > 0) return 'tsunami';
    return 'none';
  }

  /**
   * EEW の受信に対する鳴動判断。明滅の更新は resolveFlash + setFlash 側で行う。
   *
   * 従来は「全国のどこかで警報」なら警報音を鳴らしていたが、遠方の警報のたびに
   * 鳴っては本当に自分に関わる警報を聞き逃す。警報音は relevance が 'warning'
   * (利用地の県が警報対象) のときだけにする。
   */
  applyEewSound(eew: EewState | null, notifyForecast: boolean, relevance: EewRelevance): void {
    if (!eew) return;
    if (eew.isCancel) {
      // 誤報と分かった時点で即座に黙らせる。EEW 系統だけを止め、
      // 同時に鳴っているかもしれない津波警報 (別事象) は止めない。
      this.audio.stop('eew');
      this.lastSound.eew = `${eew.id}:cancelled`;
      return;
    }
    if (eew.isTraining) return;
    if (relevance === 'none') return;
    if (relevance !== 'warning' && !notifyForecast) return;

    // 第一報と、自分にとってのランクが上がった瞬間だけ鳴らす。続報ごとには鳴らさない。
    // 全国モードでは呼び出し側が relevance = eew.alert を渡すので、従来どおり
    // 警報種別が変わった瞬間に鳴る。
    const key = `${eew.id}:${relevance}`;
    if (key === this.lastSound.eew) return;
    this.lastSound.eew = key;
    this.play(relevance === 'warning' ? 'warning' : 'forecast');
  }

  /**
   * 津波の鳴動判断。rank は shared の tsunamiAlertRank の結果 (0 なら鳴らさない)。
   *
   * 従来は発表 (552) の id が変わるたびに鳴り直していたが、id は続報でも毎回
   * 変わるため、同じ強さの続報でも鳴り続けてしまっていた。ここでは
   * 「自分にとってのランクが前回より上がったときだけ」鳴らす。
   */
  applyTsunamiSound(tsunami: TsunamiInfo | null, rank: number): void {
    const active = tsunami !== null && !tsunami.cancelled && tsunami.areas.length > 0;
    if (!active) {
      // 事象の終わり。解除や表示終了で状態を畳み、次の事象で鳴れるようにする。
      this.tsunamiActive = false;
      this.lastTsunamiRank = 0;
      return;
    }
    if (!this.tsunamiActive) {
      // 事象の始まり。通し番号を進めて明滅の打ち切りを引き直す。
      this.tsunamiActive = true;
      this.tsunamiSeries += 1;
      this.lastTsunamiRank = 0;
    }
    if (rank > this.lastTsunamiRank) this.play('tsunami');
    // 下がった場合も追従させる。こうしておくと、いったん下がったあとの
    // 再格上げ (例: 注意報→警報) でまた鳴らせる。
    this.lastTsunamiRank = rank;
  }

  /** 詳細不明の発表検出 (P2P 554)。第一報として短く鳴らすだけ。 */
  applyDetection(id: string): void {
    if (id === this.lastSound.detection) return;
    this.lastSound.detection = id;
    this.play('detection');
  }

  private play(sound: AlertSound): void {
    this.audio.play(sound);
  }

  /**
   * 明滅を打ち切る単位。
   * EEW は同じ地震の続報では変わらず、利用地にとってのランクや震度が上がれば変わる。
   * 津波は id ではなく tsunamiSeries を使う (id は続報ごとに変わるので、
   * 事象の切れ目 (series の増加) だけで打ち切りを引き直す)。
   */
  private flashKey(
    eew: EewState | null,
    eewRelevance: EewRelevance,
    tsunamiRank: number,
    level: FlashLevel,
  ): string {
    if (level === 'tsunami') return `tsunami:${this.tsunamiSeries}:${tsunamiRank}`;
    return `eew:${eew ? eew.id : ''}:${eewRelevance}:${eew ? eew.maxIntensity : ''}`;
  }
}

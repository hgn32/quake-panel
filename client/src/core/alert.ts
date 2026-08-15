import { DEFAULT_FLASH_SECONDS, type EewState, type TsunamiInfo } from '@quake-panel/shared';
import { AlertAudio, type AlertSound } from './audio.js';

export type FlashLevel = 'none' | 'forecast' | 'warning' | 'tsunami';

/**
 * 「モニターを注視していなくても気づける」ための層 (§1)。
 *
 * 明滅は CSS アニメーションに任せる。requestAnimationFrame で色を書き換えると
 * 描画スレッドを常時起こすことになり、Pi4 では地図描画と食い合う (§4)。
 */
export class AlertPresenter {
  readonly audio = new AlertAudio();
  private level: FlashLevel = 'none';
  /**
   * 同じ事象で鳴らし直さないための記録。
   * 系統ごとに分けておかないと、再接続で現況一括を受け直したときに鳴り直す。
   */
  private lastSound = { eew: '', tsunami: '', detection: '' };
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
   */
  applyFlash(eew: EewState | null, tsunami: TsunamiInfo | null, notifyForecast: boolean): void {
    const level = this.resolveFlash(eew, tsunami, notifyForecast);
    if (level === 'none') {
      this.clearFlashTimer();
      this.setFlash('none');
      return;
    }

    const key = flashKey(eew, tsunami, level);
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
   */
  resolveFlash(
    eew: EewState | null,
    tsunami: TsunamiInfo | null,
    notifyForecast: boolean,
  ): FlashLevel {
    if (eew && !eew.isCancel && !eew.isTraining) {
      if (eew.alert === 'warning') return 'warning';
      if (notifyForecast) return 'forecast';
    }
    if (tsunami && !tsunami.cancelled && tsunami.areas.length > 0) return 'tsunami';
    return 'none';
  }

  /** EEW の受信に対する鳴動判断。明滅の更新は resolveFlash + setFlash 側で行う。 */
  applyEewSound(eew: EewState | null, notifyForecast: boolean): void {
    if (!eew) return;
    if (eew.isCancel) {
      // 誤報と分かった時点で即座に黙らせる
      this.audio.stop();
      this.lastSound.eew = `${eew.id}:cancelled`;
      return;
    }
    if (eew.isTraining) return;
    if (eew.alert !== 'warning' && !notifyForecast) return;

    // 第一報と、予報から警報へ格上げされた瞬間だけ鳴らす。続報ごとには鳴らさない。
    const key = `${eew.id}:${eew.alert}`;
    if (key === this.lastSound.eew) return;
    this.lastSound.eew = key;
    this.play(eew.alert === 'warning' ? 'warning' : 'forecast');
  }

  applyTsunamiSound(tsunami: TsunamiInfo | null): void {
    if (!tsunami || tsunami.cancelled || tsunami.areas.length === 0) return;
    if (tsunami.id === this.lastSound.tsunami) return;
    this.lastSound.tsunami = tsunami.id;
    this.play('tsunami');
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
}

/**
 * 明滅を打ち切る単位。
 * 同じ地震の続報では変わらず、震度や警報種別が上がれば変わる。
 */
function flashKey(eew: EewState | null, tsunami: TsunamiInfo | null, level: FlashLevel): string {
  if (level === 'tsunami') return `tsunami:${tsunami ? tsunami.id : ''}`;
  return `eew:${eew ? eew.id : ''}:${eew ? eew.alert : ''}:${eew ? eew.maxIntensity : ''}`;
}

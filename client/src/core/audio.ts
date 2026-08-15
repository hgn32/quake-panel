import { DEFAULT_SOUND_SECONDS } from '@quake-panel/shared';

/**
 * 通知音。
 *
 * 音源ファイルを同梱せず WebAudio で合成する。素材の配布条件を持ち込まずに済み、
 * 起動時のダウンロードも無くなる。気象庁のチャイム音を模した音は使わない
 * (紛らわしいうえ、配布条件も別途あるため)。
 *
 * ブラウザの自動再生制限があるので、初回のユーザー操作で `unlock()` を呼ぶ。
 * Chromium キオスクなら `--autoplay-policy=no-user-gesture-required` でも回避できる (§4)。
 */
export type AlertSound = 'warning' | 'forecast' | 'detection' | 'tsunami';

interface Tone {
  freq: number;
  start: number;
  duration: number;
  gain: number;
  type: OscillatorType;
}

const PATTERNS: Record<AlertSound, { repeat: number; interval: number; tones: Tone[] }> = {
  // 警報: 強い二音の繰り返し
  warning: {
    repeat: 4,
    interval: 0.62,
    tones: [
      { freq: 880, start: 0, duration: 0.26, gain: 0.5, type: 'square' },
      { freq: 660, start: 0.3, duration: 0.26, gain: 0.5, type: 'square' },
    ],
  },
  // 予報: 警報より控えめな三音
  forecast: {
    repeat: 2,
    interval: 0.75,
    tones: [
      { freq: 784, start: 0, duration: 0.18, gain: 0.32, type: 'triangle' },
      { freq: 988, start: 0.22, duration: 0.18, gain: 0.32, type: 'triangle' },
      { freq: 784, start: 0.44, duration: 0.22, gain: 0.28, type: 'triangle' },
    ],
  },
  // 発表検出 (詳細不明): 一声だけ
  detection: {
    repeat: 1,
    interval: 0,
    tones: [{ freq: 660, start: 0, duration: 0.22, gain: 0.28, type: 'sine' }],
  },
  // 津波: 低く長い音を繰り返す
  tsunami: {
    repeat: 5,
    interval: 0.9,
    tones: [
      { freq: 440, start: 0, duration: 0.4, gain: 0.45, type: 'sawtooth' },
      { freq: 330, start: 0.44, duration: 0.4, gain: 0.45, type: 'sawtooth' },
    ],
  },
};

export class AlertAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume = 0.7;
  private active: AudioScheduledSourceNode[] = [];
  /** 鳴り始めてから maxSeconds で黙らせるためのタイマー */
  private silenceTimer: number | null = null;
  /** 鳴らし続ける上限 (秒)。0 ならパターンどおり鳴らし切る。 */
  private maxSeconds = DEFAULT_SOUND_SECONDS;

  get isUnlocked(): boolean {
    return this.context !== null && this.context.state === 'running';
  }

  /** 初回のユーザー操作から呼ぶ */
  unlock(): Promise<boolean> {
    try {
      if (!this.context) {
        const Ctor =
          window.AudioContext ??
          (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return Promise.resolve(false);
        this.context = new Ctor();
        this.master = this.context.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.context.destination);
      }
      const context = this.context;
      const resumed =
        context.state === 'suspended' ? context.resume() : Promise.resolve();
      return resumed.then(
        () => context.state === 'running',
        // 解錠できなくても表示は続ける (音だけ出ない)
        () => false,
      );
    } catch {
      return Promise.resolve(false);
    }
  }

  /** 端末ごとの設定から上限を受け取る */
  setMaxSeconds(seconds: number): void {
    this.maxSeconds = seconds;
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master) this.master.gain.value = this.volume;
  }

  getVolume(): number {
    return this.volume;
  }

  /** 動作確認用に 1 回だけ鳴らす */
  test(sound: AlertSound = 'forecast'): void {
    this.play(sound, 1);
  }

  /**
   * 鳴らす。
   *
   * 気づかせるのが目的なので、鳴り続ける必要はない。**最初の maxSeconds 秒**を
   * 超える分は鳴らさず、超えた時点で黙らせる (既定 10 秒、設定で変更可)。
   * 遠方の地震で長時間鳴り続けた、という実際の指摘に対する打ち切り。
   */
  play(sound: AlertSound, repeatOverride?: number): void {
    const ctx = this.context;
    const master = this.master;
    if (!ctx || !master || this.volume <= 0) return;

    const pattern = PATTERNS[sound];
    const repeat = repeatOverride ?? pattern.repeat;
    const base = ctx.currentTime + 0.02;
    const deadline = this.maxSeconds > 0 ? base + this.maxSeconds : Number.POSITIVE_INFINITY;

    // 上限を超える繰り返しは最初から鳴らさない
    Array.from({ length: repeat }, (_, r) => base + r * pattern.interval)
      .filter((cycleStart) => cycleStart < deadline)
      .forEach((cycleStart) => {
        pattern.tones.forEach((tone) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = tone.type;
        osc.frequency.value = tone.freq;
        const at = cycleStart + tone.start;
        // 立ち上がり・立ち下がりを付けないとプチッというクリック音が入る
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(tone.gain, at + 0.012);
        gain.gain.setValueAtTime(tone.gain, at + tone.duration - 0.03);
        gain.gain.linearRampToValueAtTime(0, at + tone.duration);
        osc.connect(gain);
        gain.connect(master);
        osc.start(at);
        osc.stop(at + tone.duration + 0.02);
        this.track(osc);
      });
    });

    // 予定より長引いた場合 (連続で鳴らされた場合を含む) の保険
    if (this.silenceTimer !== null) window.clearTimeout(this.silenceTimer);
    if (this.maxSeconds > 0) {
      this.silenceTimer = window.setTimeout(() => {
        this.silenceTimer = null;
        this.stop();
      }, this.maxSeconds * 1000);
    }
  }

  /** キャンセル報などで即座に黙らせる */
  stop(): void {
    if (this.silenceTimer !== null) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    this.active.forEach((node) => {
      try {
        node.stop();
      } catch {
        // すでに終了しているノードは無視
      }
    });
    this.active = [];
  }

  private track(node: AudioScheduledSourceNode): void {
    this.active.push(node);
    node.addEventListener('ended', () => {
      this.active = this.active.filter((n) => n !== node);
    });
  }
}

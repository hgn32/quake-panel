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

/**
 * 鳴動の系統。EEW (warning/forecast/detection) と津波 (tsunami) は別事象なので、
 * 一方のキャンセル・打ち切りでもう一方まで止めないよう分けて管理する。
 */
export type AlertCategory = 'eew' | 'tsunami';

function categoryFor(sound: AlertSound): AlertCategory {
  return sound === 'tsunami' ? 'tsunami' : 'eew';
}

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
  private active: Array<{ node: AudioScheduledSourceNode; category: AlertCategory }> = [];
  /** 鳴り始めてから maxSeconds で黙らせるためのタイマー (系統ごと) */
  private silenceTimers: Record<AlertCategory, number | null> = { eew: null, tsunami: null };
  /** 鳴らし続ける上限 (秒)。0 ならパターンどおり鳴らし切る。 */
  private maxSeconds = DEFAULT_SOUND_SECONDS;
  /**
   * unlock (resume) 待ちの間に要求された最新の 1 件。
   * suspended のままオシレータを積んでも `currentTime` が進まず鳴らないうえ
   * 'ended' も発火しないため無限に溜まってしまう。running に戻った瞬間に
   * この 1 件だけ鳴らし、それより前の分は捨てる (過去の警報が resume 時に
   * まとめて再生されるのを防ぐ)。
   */
  private pendingSound: { sound: AlertSound; repeatOverride: number | undefined } | null = null;

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
        () => {
          const running = context.state === 'running';
          // running に戻った瞬間、待たせていた最新の 1 件があれば鳴らす
          if (running) this.flushPendingSound();
          return running;
        },
        // 解錠できなくても表示は続ける (音だけ出ない)
        () => false,
      );
    } catch {
      return Promise.resolve(false);
    }
  }

  /** suspended 中に溜めておいた最新の要求を鳴らす (無ければ何もしない) */
  private flushPendingSound(): void {
    const pending = this.pendingSound;
    this.pendingSound = null;
    if (pending) this.play(pending.sound, pending.repeatOverride);
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

    if (ctx.state !== 'running') {
      // unlock 前 (あるいは何らかの理由で再び suspended になった) は
      // currentTime が凍結したままオシレータだけが積み上がり、resume した
      // 瞬間に過去分がまとめて鳴ってしまう。ここでは鳴らさず、最新の 1 件
      // だけ憶えておいて running に戻ってから鳴らす (flushPendingSound)。
      this.pendingSound = { sound, repeatOverride };
      return;
    }
    this.pendingSound = null;

    const category = categoryFor(sound);
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
        this.track(osc, category);
      });
    });

    // 予定より長引いた場合 (連続で鳴らされた場合を含む) の保険。
    // 系統ごとに持つので、片方の系統の再生が他方のタイマーを引き直さない。
    const prevTimer = this.silenceTimers[category];
    if (prevTimer !== null) window.clearTimeout(prevTimer);
    if (this.maxSeconds > 0) {
      this.silenceTimers[category] = window.setTimeout(() => {
        this.silenceTimers[category] = null;
        this.stop(category);
      }, this.maxSeconds * 1000);
    } else {
      this.silenceTimers[category] = null;
    }
  }

  /**
   * 即座に黙らせる。
   * `category` を指定するとその系統だけ止める (例: EEW キャンセル報では
   * 'eew' だけを止め、鳴っている津波警報は続ける)。省略時は全系統を止める。
   */
  stop(category?: AlertCategory): void {
    const categories: AlertCategory[] = category ? [category] : ['eew', 'tsunami'];
    categories.forEach((cat) => {
      const timer = this.silenceTimers[cat];
      if (timer !== null) {
        window.clearTimeout(timer);
        this.silenceTimers[cat] = null;
      }
    });
    this.active
      .filter((entry) => categories.includes(entry.category))
      .forEach((entry) => {
        try {
          entry.node.stop();
        } catch {
          // すでに終了しているノードは無視
        }
      });
    this.active = this.active.filter((entry) => !categories.includes(entry.category));
    // 止めた系統を待っていたかもしれない pending 分も捨てる
    if (this.pendingSound && categories.includes(categoryFor(this.pendingSound.sound))) {
      this.pendingSound = null;
    }
  }

  private track(node: AudioScheduledSourceNode, category: AlertCategory): void {
    this.active.push({ node, category });
    node.addEventListener('ended', () => {
      this.active = this.active.filter((entry) => entry.node !== node);
    });
  }
}

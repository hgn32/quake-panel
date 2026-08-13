import {
  formatJstClock,
  intensityColor,
  intensityLabel,
  type EewState,
  type HealthState,
  type QuakeInfo,
  type ServerEvent,
  type StateSnapshot,
  type TsunamiInfo,
} from '@quake-panel/shared';
import { AlertPresenter } from './core/alert.js';
import { ServerConnection, type ConnectionState } from './core/connection.js';
import { FrameStream } from './core/frameStream.js';
import { MapView } from './core/mapView.js';
import { loadSettings, saveSettings, type Settings } from './settings.js';
import { h, replaceChildren, requireElement } from './ui/dom.js';
import { EewPanel } from './ui/eewPanel.js';
import { QuakeList } from './ui/quakeList.js';
import { SettingsPanel } from './ui/settingsPanel.js';
import { StatusBar } from './ui/statusBar.js';
import { TsunamiPanel } from './ui/tsunamiPanel.js';

const LEGEND_STEPS = [10, 20, 30, 40, 45, 50, 55, 60, 70];

/**
 * 画面全体の取りまとめ。
 *
 * 毎秒更新される描画は MapView / FrameStream が担い、ここは
 * 「たまにしか変わらない UI」だけを触る (§5 推奨構成)。
 */
export class App {
  private settings: Settings = loadSettings();
  private readonly alert: AlertPresenter;
  private readonly mapView: MapView;
  private readonly frames: FrameStream;
  private readonly connection: ServerConnection;
  private readonly statusBar: StatusBar;
  private readonly eewPanel: EewPanel;
  private readonly tsunamiPanel: TsunamiPanel;
  private readonly quakeList: QuakeList;
  private readonly settingsPanel: SettingsPanel;

  private quakes: QuakeInfo[] = [];
  private tsunami: TsunamiInfo | null = null;
  private eew: EewState | null = null;
  private home = { name: '', lat: 35, lon: 135 };
  private clockTimer: number | null = null;

  constructor() {
    this.alert = new AlertPresenter(requireElement('flash'));
    this.alert.audio.setVolume(this.settings.volume);

    this.mapView = new MapView(requireElement<HTMLCanvasElement>('map'), {
      glow: this.settings.glow,
      hideCaption: this.settings.hideCaption,
      mode: this.settings.mapMode,
      home: this.home,
    });
    this.frames = new FrameStream((frame) => {
      this.mapView.setFrame(frame);
      this.statusBar.setFrameTime(frame.notice.isoTime, frame.notice.latencyMs);
    });

    this.statusBar = new StatusBar(
      requireElement('status-link'),
      requireElement('status-kmoni'),
      requireElement('status-p2p'),
      requireElement('frame-time'),
      requireElement('map-notice'),
    );
    this.eewPanel = new EewPanel(requireElement('eew-panel'));
    this.tsunamiPanel = new TsunamiPanel(requireElement('tsunami-panel'));
    this.quakeList = new QuakeList(requireElement('quake-list'), []);
    this.settingsPanel = new SettingsPanel({
      modal: requireElement('settings'),
      form: requireElement('settings-form'),
      openButton: requireElement('settings-open'),
      closeButton: requireElement('settings-close'),
      getSettings: () => this.settings,
      onChange: (patch) => this.applySettings(patch),
      onTestSound: () => this.alert.audio.test(),
    });

    this.connection = new ServerConnection({
      onEvent: (event) => this.handleEvent(event),
      onStateChange: (state) => this.handleConnectionState(state),
    });
  }

  async start(): Promise<void> {
    this.renderLegend();
    this.startClock();
    this.setupAudioGate();
    await this.mapView.init();
    this.connection.start();

    // タブが再表示されたときは取りこぼしを疑って現況を取り直す
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.connection.requestResync();
    });
  }

  private handleConnectionState(state: ConnectionState): void {
    this.statusBar.setConnection(state);
  }

  private handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'hello':
        this.applySnapshot(event.snapshot);
        break;
      case 'frame':
        this.frames.accept(event.frame);
        break;
      case 'eew':
        this.applyEew(event.eew);
        break;
      case 'eewDetection':
        // 詳細不明の第一報。EEW 本体が来ていないときだけ短く鳴らす。
        if (!this.eew) this.alert.applyDetection(event.detection.id);
        break;
      case 'quake':
        this.quakes = [event.quake, ...this.quakes.filter((q) => q.id !== event.quake.id)];
        this.renderQuakes();
        break;
      case 'tsunami':
        this.applyTsunami(event.tsunami);
        break;
      case 'health':
        this.applyHealth(event.health);
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  private applySnapshot(snapshot: StateSnapshot): void {
    this.home = snapshot.home;
    this.mapView.setOptions({ home: snapshot.home });
    this.quakeList.setHomeHints(homeHints(snapshot.home.name));
    this.quakes = snapshot.quakes;
    this.renderQuakes();
    this.applyHealth(snapshot.health);
    this.applyTsunami(snapshot.tsunami);
    this.applyEew(snapshot.eew);
    if (snapshot.frame) this.frames.accept(snapshot.frame);
    else this.statusBar.setFrameTime(null, 0);
  }

  private applyHealth(health: HealthState): void {
    this.statusBar.setHealth(health);
  }

  private applyEew(eew: EewState | null): void {
    this.eew = eew;
    this.eewPanel.update(eew);
    this.mapView.setEew(eew);
    this.alert.applyEewSound(eew, this.settings.notifyForecast);
    this.refreshFlash();
  }

  private applyTsunami(tsunami: TsunamiInfo | null): void {
    this.tsunami = tsunami;
    this.tsunamiPanel.update(tsunami);
    this.mapView.setTsunami(tsunami);
    this.alert.applyTsunamiSound(tsunami);
    this.refreshFlash();
  }

  /**
   * 明滅の強さは EEW と津波の両方から決まるので、片方だけを見て切り替えない。
   * (EEW が消えたあとに津波の明滅へ戻す、といった遷移をここで一括して扱う)
   */
  private refreshFlash(): void {
    this.alert.setFlash(
      this.alert.resolveFlash(this.eew, this.tsunami, this.settings.notifyForecast),
    );
  }

  private renderQuakes(): void {
    this.quakeList.update(this.quakes, this.settings.historyCount);
  }

  private applySettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    this.alert.audio.setVolume(this.settings.volume);
    this.mapView.setOptions({
      glow: this.settings.glow,
      hideCaption: this.settings.hideCaption,
      mode: this.settings.mapMode,
    });
    this.refreshFlash();
    this.renderQuakes();
  }

  private startClock(): void {
    const clock = requireElement('clock');
    const date = requireElement('clock-date');
    const tick = (): void => {
      const now = new Date();
      clock.textContent = formatJstClock(now);
      const jst = new Date(now.getTime() + 9 * 3600 * 1000);
      date.textContent = `${jst.getUTCFullYear()}/${String(jst.getUTCMonth() + 1).padStart(2, '0')}/${String(
        jst.getUTCDate(),
      ).padStart(2, '0')}`;
    };
    tick();
    this.clockTimer = window.setInterval(tick, 250);
  }

  /**
   * 自動再生制限の解除。Chromium キオスクなら起動フラグでも回避できるが、
   * 普通のブラウザで開いたときのために操作待ちの案内を出す (§4)。
   */
  private setupAudioGate(): void {
    const gate = requireElement('audio-gate');
    void this.alert.audio.unlock().then((ok) => {
      if (ok) return;
      gate.hidden = false;
      const dismiss = async (): Promise<void> => {
        const unlocked = await this.alert.audio.unlock();
        if (!unlocked) return;
        gate.hidden = true;
        document.removeEventListener('pointerdown', handler);
        document.removeEventListener('keydown', handler);
      };
      const handler = (): void => void dismiss();
      document.addEventListener('pointerdown', handler);
      document.addEventListener('keydown', handler);
    });
  }

  private renderLegend(): void {
    const legend = requireElement('map-legend');
    replaceChildren(
      legend,
      h('span', { class: 'map-legend__title', text: '震度' }),
      ...LEGEND_STEPS.filter((s) => s !== 46).map((scale) => {
        const chip = h('span', { class: 'map-legend__chip', text: intensityLabel(scale) ?? '' });
        chip.style.background = intensityColor(scale);
        return chip;
      }),
    );
  }

  dispose(): void {
    if (this.clockTimer !== null) window.clearInterval(this.clockTimer);
    this.connection.stop();
    this.frames.dispose();
    this.mapView.dispose();
    this.eewPanel.dispose();
  }
}

/** "宮崎県延岡市" のような表記から、観測点名との照合に使う手掛かりを作る */
function homeHints(name: string): string[] {
  const hints: string[] = [];
  const match = /^(.+?[都道府県])(.*)$/.exec(name);
  if (match) {
    const [, pref, rest] = match;
    const city = (rest ?? '').replace(/[市区町村].*$/, '');
    if (city) hints.push(city);
    if (pref) hints.push(pref);
  } else if (name) {
    hints.push(name);
  }
  return hints;
}

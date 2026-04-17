/**
 * 中文音节峰值检测器
 * 原理：中文单音节语言，1 字 ≈ 1 个能量峰。
 * 通过 Web Audio API 分析麦克风音频的短时能量包络，
 * 用"局部极小 → 局部极大"跟踪检测音节峰，近似得到"说了多少字"。
 *
 * 纯前端本地计算，不联网、不上传、不依赖任何模型。
 */

export interface SyllableDetectorOptions {
  /** 音节之间最小间隔（毫秒），人类最快 ~8 字/秒 → 125ms；设 70ms 留余量 */
  minSyllableGapMs?: number;
  /** 静默自动归零阈值（毫秒），连续无峰超过此时间则语速归零 */
  silenceResetMs?: number;
  /** 每个时间戳保留的滚动窗口长度（毫秒） */
  windowMs?: number;
  /** 峰值绝对阈值（相对噪声基线的倍数）：低于此不算音节，防背景噪声 */
  peakAbsRatio?: number;
  /** 字间峰谷比阈值：peak / valley 必须 ≥ 此值才算一个音节（字间起伏） */
  syllableRatio?: number;
  /** RMS 包络平滑系数（EMA），越大越平滑，0.3~0.5 合适 */
  smoothAlpha?: number;
}

export interface SyllableDetectorCallbacks {
  /** 每次计算结果更新时回调（每 ~100ms 一次） */
  onUpdate: (state: {
    /** 当前语速（字/分钟） */
    cpm: number;
    /** 窗口内实际音节数 */
    windowCount: number;
    /** 是否处于静默 */
    silent: boolean;
    /** 当前瞬时音量 0-1，用于显示电平 */
    level: number;
  }) => void;
  /** 出错回调（麦克风权限拒绝等） */
  onError?: (err: Error) => void;
}

type PhaseState = "searching" | "rising" | "falling";

export class SyllableDetector {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rafId: number | null = null;
  private timerId: number | null = null;

  /** 每个检测到的音节的时间戳（毫秒） */
  private syllableTimestamps: number[] = [];

  /** 平滑后的 RMS 包络，上一帧 */
  private prevEnv = 0;
  /** 最近的局部谷（字间最低点） */
  private valley = Infinity;
  /** 当前上升段累计的峰 */
  private peak = 0;
  /** 相位状态 */
  private phase: PhaseState = "searching";
  /** 上次计数时间，最小间隔保护 */
  private lastPeakTime = 0;
  /** 自适应噪声基线（EMA） */
  private noiseFloor = 0.005;
  /** 当前 UI 电平 */
  private currentLevel = 0;

  private opts: Required<SyllableDetectorOptions>;
  private callbacks: SyllableDetectorCallbacks;

  constructor(callbacks: SyllableDetectorCallbacks, opts: SyllableDetectorOptions = {}) {
    this.callbacks = callbacks;
    this.opts = {
      minSyllableGapMs: opts.minSyllableGapMs ?? 70,
      silenceResetMs: opts.silenceResetMs ?? 5000,
      windowMs: opts.windowMs ?? 10000,
      peakAbsRatio: opts.peakAbsRatio ?? 2.0,
      syllableRatio: opts.syllableRatio ?? 1.35,
      smoothAlpha: opts.smoothAlpha ?? 0.35,
    };
  }

  async start(): Promise<void> {
    try {
      // 关键：关闭 AGC 和 NS，否则浏览器会把语音包络压平+抹掉弱音节
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new Ctx();

      this.source = this.audioCtx.createMediaStreamSource(this.stream);

      // 带通滤波：人声主能量在 300-3400Hz
      const highpass = this.audioCtx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 300;

      const lowpass = this.audioCtx.createBiquadFilter();
      lowpass.type = "lowpass";
      lowpass.frequency.value = 3400;

      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0;

      this.source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(this.analyser);

      this.loop();
      this.timerId = window.setInterval(() => this.emit(), 100);
    } catch (err) {
      this.callbacks.onError?.(err as Error);
      throw err;
    }
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.timerId !== null) clearInterval(this.timerId);
    this.rafId = null;
    this.timerId = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.audioCtx?.close();
    this.stream = null;
    this.source = null;
    this.analyser = null;
    this.audioCtx = null;
    this.syllableTimestamps = [];
    this.prevEnv = 0;
    this.valley = Infinity;
    this.peak = 0;
    this.phase = "searching";
    this.lastPeakTime = 0;
  }

  reset(): void {
    this.syllableTimestamps = [];
  }

  private loop = (): void => {
    if (!this.analyser) return;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);

    // 短时 RMS 能量
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);

    // EMA 平滑，作为能量包络
    const env = this.prevEnv * (1 - this.opts.smoothAlpha) + rms * this.opts.smoothAlpha;
    this.currentLevel = Math.min(1, env * 5);

    const now = performance.now();

    // 自适应噪声基线：能量较低时缓慢更新
    if (env < this.noiseFloor * 1.5) {
      this.noiseFloor = this.noiseFloor * 0.99 + env * 0.01;
    }
    if (this.noiseFloor < 0.003) this.noiseFloor = 0.003;

    const absThreshold = this.noiseFloor * this.opts.peakAbsRatio;

    // === 局部极值状态机 ===
    // 比较当前帧 env 和上一帧 prevEnv：
    // - env > prevEnv：上升中 → prevEnv 可能是局部谷（上一轮 falling 刚结束）
    // - env < prevEnv：下降中 → prevEnv 可能是局部峰（上一轮 rising 刚结束）
    if (env > this.prevEnv) {
      // 上升
      if (this.phase !== "rising") {
        // 刚从下降/搜索转为上升，prevEnv 就是一个局部谷
        this.valley = Math.min(this.valley === Infinity ? this.prevEnv : this.valley, this.prevEnv);
        this.phase = "rising";
        this.peak = env;
      } else {
        this.peak = Math.max(this.peak, env);
      }
    } else if (env < this.prevEnv) {
      // 下降
      if (this.phase === "rising") {
        // 刚过峰：prevEnv 是峰
        const peakVal = this.prevEnv;
        const valleyVal = this.valley === Infinity ? this.noiseFloor : this.valley;
        const passAbs = peakVal >= absThreshold;
        const passRatio = peakVal >= valleyVal * this.opts.syllableRatio;
        const passGap = now - this.lastPeakTime > this.opts.minSyllableGapMs;

        if (passAbs && passRatio && passGap) {
          this.syllableTimestamps.push(now);
          this.lastPeakTime = now;
        }
        // 不管计没计数，进入下降阶段，重新追踪新谷
        this.phase = "falling";
        this.valley = env;
      } else {
        // 持续下降：持续刷新局部最低
        this.valley = Math.min(this.valley, env);
      }
    }
    // env === prevEnv：不变，维持当前 phase

    this.prevEnv = env;
    this.rafId = requestAnimationFrame(this.loop);
  };

  private emit(): void {
    const now = performance.now();
    const cutoff = now - this.opts.windowMs;
    this.syllableTimestamps = this.syllableTimestamps.filter((t) => t >= cutoff);

    const windowCount = this.syllableTimestamps.length;
    const windowSec = this.opts.windowMs / 1000;

    const last = this.syllableTimestamps[this.syllableTimestamps.length - 1] ?? 0;
    const silent = windowCount === 0 || now - last > this.opts.silenceResetMs;

    const cpm = silent ? 0 : Math.round((windowCount / windowSec) * 60);

    this.callbacks.onUpdate({
      cpm,
      windowCount,
      silent,
      level: this.currentLevel,
    });
  }
}

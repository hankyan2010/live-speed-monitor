/**
 * 中文音节峰值检测器
 * 原理：中文单音节语言，1 字 ≈ 1 个能量峰。
 * 通过 Web Audio API 分析麦克风音频的短时能量包络，
 * 检测局部峰值并计数，近似得到"说了多少字"。
 *
 * 纯前端本地计算，不联网、不上传、不依赖任何模型。
 */

export interface SyllableDetectorOptions {
  /** 音节之间最小间隔（毫秒），人类最快 ~8 字/秒 → 120ms；设 80ms 留余量 */
  minSyllableGapMs?: number;
  /** 静默自动归零阈值（毫秒），连续无峰超过此时间则语速归零 */
  silenceResetMs?: number;
  /** 每个时间戳保留的滚动窗口长度（毫秒） */
  windowMs?: number;
  /** 峰值检测触发比例（相对动态噪声基线），越小越灵敏 */
  peakRatio?: number;
}

export interface SyllableDetectorCallbacks {
  /** 每次计算结果更新时回调（每 ~100ms 一次） */
  onUpdate: (state: {
    /** 当前语速（字/分钟） */
    cpm: number;
    /** 10 秒窗口内实际音节数 */
    windowCount: number;
    /** 是否处于静默（5 秒无音节） */
    silent: boolean;
    /** 当前瞬时音量 0-1，用于显示电平 */
    level: number;
  }) => void;
  /** 出错回调（麦克风权限拒绝等） */
  onError?: (err: Error) => void;
}

export class SyllableDetector {
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rafId: number | null = null;
  private timerId: number | null = null;

  /** 记录每个检测到的音节的时间戳（毫秒） */
  private syllableTimestamps: number[] = [];
  /** 上一帧的能量值，用于判断"是否过了波峰" */
  private prevEnergy = 0;
  /** 峰前最低能量（谷底），用于确认"出了谷再上峰" */
  private valleyEnergy = 0;
  /** 是否正在上升（在谷之后） */
  private rising = false;
  /** 上次计数时间，用于最小间隔 */
  private lastPeakTime = 0;
  /** 自适应噪声基线（EMA） */
  private noiseFloor = 0.005;

  private opts: Required<SyllableDetectorOptions>;
  private callbacks: SyllableDetectorCallbacks;

  constructor(callbacks: SyllableDetectorCallbacks, opts: SyllableDetectorOptions = {}) {
    this.callbacks = callbacks;
    this.opts = {
      minSyllableGapMs: opts.minSyllableGapMs ?? 80,
      silenceResetMs: opts.silenceResetMs ?? 5000,
      windowMs: opts.windowMs ?? 10000,
      peakRatio: opts.peakRatio ?? 2.5,
    };
  }

  async start(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Safari 需要 webkitAudioContext
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
      this.analyser.smoothingTimeConstant = 0.2;

      this.source.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(this.analyser);

      // 开始循环采样
      this.loop();
      // 定时上报 UI
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
    this.prevEnergy = 0;
    this.valleyEnergy = 0;
    this.rising = false;
    this.lastPeakTime = 0;
  }

  /** 重置计数，用于切换阈值后立即生效 */
  reset(): void {
    this.syllableTimestamps = [];
  }

  private currentLevel = 0;

  private loop = (): void => {
    if (!this.analyser) return;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);

    // 计算 RMS 短时能量
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    this.currentLevel = Math.min(1, rms * 5);

    const now = performance.now();

    // 自适应噪声基线：能量低时缓慢更新（EMA α=0.01）
    if (rms < this.noiseFloor * 1.5) {
      this.noiseFloor = this.noiseFloor * 0.99 + rms * 0.01;
    }
    // 设一个下限避免过低
    if (this.noiseFloor < 0.003) this.noiseFloor = 0.003;

    const threshold = this.noiseFloor * this.opts.peakRatio;

    // 峰值检测状态机：
    // 1) 能量下穿到接近噪声基线 → 记录谷底，rising=true
    // 2) 从谷底爬升超过 threshold，并出现"当前帧 < 前一帧"（即过了波峰） → 计一次音节
    if (rms < this.noiseFloor * 1.5) {
      this.rising = true;
      this.valleyEnergy = Math.min(this.valleyEnergy === 0 ? rms : this.valleyEnergy, rms);
    }

    if (
      this.rising &&
      this.prevEnergy >= threshold &&
      rms < this.prevEnergy &&
      this.prevEnergy > this.valleyEnergy * 2 &&
      now - this.lastPeakTime > this.opts.minSyllableGapMs
    ) {
      // 记录一次音节
      this.syllableTimestamps.push(now);
      this.lastPeakTime = now;
      this.rising = false;
      this.valleyEnergy = rms;
    }

    this.prevEnergy = rms;
    this.rafId = requestAnimationFrame(this.loop);
  };

  private emit(): void {
    const now = performance.now();
    // 裁剪窗口外的时间戳
    const cutoff = now - this.opts.windowMs;
    this.syllableTimestamps = this.syllableTimestamps.filter((t) => t >= cutoff);

    const windowCount = this.syllableTimestamps.length;
    const windowSec = this.opts.windowMs / 1000;

    // 是否静默：最后一个音节距今 > silenceResetMs
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

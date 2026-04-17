"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SyllableDetector } from "@/lib/syllableDetector";
import { playBeep, unlockAudio } from "@/lib/beep";

type Status = "idle" | "running";

interface Settings {
  threshold: number; // 超速阈值（字/分钟）
  soundOn: boolean;
  // 检测引擎参数
  syllableRatio: number;   // 字间峰谷比（核心灵敏度）
  peakAbsRatio: number;    // 峰值相对噪声基线的倍数
  minSyllableGapMs: number; // 最小字间隔 ms
  smoothAlpha: number;     // RMS 平滑系数 0~1
  windowMs: number;        // 计算语速的滚动窗口 ms
  showDebug: boolean;      // 显示调试面板
}

const DEFAULT_SETTINGS: Settings = {
  threshold: 240,
  soundOn: true,
  syllableRatio: 1.05,
  peakAbsRatio: 1.8,
  minSyllableGapMs: 60,
  smoothAlpha: 0.35,
  windowMs: 10000,
  showDebug: true,
};

const LS_KEY = "live-speed-monitor-settings";

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [cpm, setCpm] = useState(0);
  const [silent, setSilent] = useState(true);
  const [level, setLevel] = useState(0);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 调试数据
  const [dbgNoise, setDbgNoise] = useState(0);
  const [dbgLastPeak, setDbgLastPeak] = useState(0);
  const [dbgLastRatio, setDbgLastRatio] = useState(0);
  const [dbgWindowCount, setDbgWindowCount] = useState(0);
  const [dbgTotal, setDbgTotal] = useState(0);

  const detectorRef = useRef<SyllableDetector | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const lastBeepRef = useRef<number>(0);
  // 用 ref 让回调始终读到最新 threshold/soundOn
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // 初始化：从 localStorage 读设置
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
    } catch {
      /* ignore */
    }
  }, []);

  // 保存设置
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  // 参数实时下发给引擎
  useEffect(() => {
    detectorRef.current?.setOptions({
      syllableRatio: settings.syllableRatio,
      peakAbsRatio: settings.peakAbsRatio,
      minSyllableGapMs: settings.minSyllableGapMs,
      smoothAlpha: settings.smoothAlpha,
      windowMs: settings.windowMs,
    });
  }, [
    settings.syllableRatio,
    settings.peakAbsRatio,
    settings.minSyllableGapMs,
    settings.smoothAlpha,
    settings.windowMs,
  ]);

  const acquireWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (t: "screen") => Promise<WakeLockSentinel> };
      };
      if (nav.wakeLock) {
        wakeLockRef.current = await nav.wakeLock.request("screen");
      }
    } catch {
      /* ignore */
    }
  }, []);

  const releaseWakeLock = useCallback(async () => {
    try {
      await wakeLockRef.current?.release();
    } catch {
      /* ignore */
    }
    wakeLockRef.current = null;
  }, []);

  const handleStart = async () => {
    setErrorMsg(null);
    unlockAudio();
    const s = settingsRef.current;
    const detector = new SyllableDetector(
      {
        onUpdate: (state) => {
          setCpm(state.cpm);
          setSilent(state.silent);
          setLevel(state.level);
          setDbgNoise(state.noiseFloor);
          setDbgLastPeak(state.lastPeak);
          setDbgLastRatio(state.lastRatio);
          setDbgWindowCount(state.windowCount);
          setDbgTotal(state.totalCount);

          const cur = settingsRef.current;
          if (state.cpm > cur.threshold && cur.soundOn) {
            const now = performance.now();
            if (now - lastBeepRef.current > 2000) {
              playBeep();
              lastBeepRef.current = now;
            }
          }
        },
        onError: (err) => {
          setErrorMsg(
            err.name === "NotAllowedError"
              ? "麦克风权限被拒绝，请在浏览器设置中允许"
              : `启动失败：${err.message}`
          );
          setStatus("idle");
        },
      },
      {
        windowMs: s.windowMs,
        silenceResetMs: 5000,
        syllableRatio: s.syllableRatio,
        peakAbsRatio: s.peakAbsRatio,
        minSyllableGapMs: s.minSyllableGapMs,
        smoothAlpha: s.smoothAlpha,
      }
    );
    try {
      await detector.start();
      detectorRef.current = detector;
      setStatus("running");
      acquireWakeLock();
    } catch {
      /* onError 已处理 */
    }
  };

  const handleStop = () => {
    detectorRef.current?.stop();
    detectorRef.current = null;
    setStatus("idle");
    setCpm(0);
    setLevel(0);
    setSilent(true);
    releaseWakeLock();
  };

  useEffect(() => {
    return () => {
      detectorRef.current?.stop();
      releaseWakeLock();
    };
  }, [releaseWakeLock]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && status === "running") {
        acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [status, acquireWakeLock]);

  const warnLevel = settings.threshold * 0.9;
  const colorState: "normal" | "warn" | "over" =
    cpm === 0 ? "normal" : cpm >= settings.threshold ? "over" : cpm >= warnLevel ? "warn" : "normal";

  const colorClass = {
    normal: "text-emerald-400",
    warn: "text-amber-400",
    over: "text-red-500",
  }[colorState];

  const isFlashing = colorState === "over" && status === "running";

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
  };

  const resetParams = () => {
    setSettings((s) => ({
      ...s,
      syllableRatio: DEFAULT_SETTINGS.syllableRatio,
      peakAbsRatio: DEFAULT_SETTINGS.peakAbsRatio,
      minSyllableGapMs: DEFAULT_SETTINGS.minSyllableGapMs,
      smoothAlpha: DEFAULT_SETTINGS.smoothAlpha,
      windowMs: DEFAULT_SETTINGS.windowMs,
    }));
  };

  return (
    <main
      className={`min-h-screen flex flex-col ${isFlashing ? "alert-flash" : "bg-black"}`}
      style={{ minHeight: "100dvh" }}
    >
      <header className="flex items-center justify-between px-5 pt-5">
        <div className="text-sm text-neutral-400">
          直播语速告警器
          <span className="ml-2 text-xs text-neutral-600">· 纯本地运行</span>
        </div>
        <button
          onClick={() => setShowSettings(true)}
          className="w-10 h-10 rounded-full bg-neutral-800 active:bg-neutral-700 flex items-center justify-center"
          aria-label="设置"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </header>

      <section className="flex-1 flex flex-col items-center justify-center px-4">
        <div className="text-neutral-500 text-sm mb-3">当前语速（字 / 分钟）</div>
        <div className={`font-black leading-none tabular-nums ${colorClass}`} style={{ fontSize: "min(44vw, 320px)" }}>
          {cpm}
        </div>
        <div className="mt-4 text-neutral-400 text-base">
          阈值 {settings.threshold} 字 / 分钟
          {status === "running" && silent && <span className="ml-3 text-neutral-600">· 等待说话…</span>}
          {status === "running" && !silent && colorState === "warn" && (
            <span className="ml-3 text-amber-400">· 接近上限</span>
          )}
          {status === "running" && colorState === "over" && (
            <span className="ml-3 text-red-400 font-bold">· 语速过快！</span>
          )}
        </div>

        <div className="w-48 h-1.5 bg-neutral-800 rounded-full mt-6 overflow-hidden">
          <div
            className="h-full bg-neutral-500 transition-[width] duration-75"
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>

        {/* 调试面板（可在设置里关掉） */}
        {settings.showDebug && (
          <div className="mt-6 w-full max-w-sm bg-neutral-900/60 rounded-xl px-4 py-3 text-xs text-neutral-300 tabular-nums">
            <div className="grid grid-cols-2 gap-y-1 gap-x-3">
              <div>窗口内字数</div>
              <div className="text-right text-emerald-400">{dbgWindowCount}</div>
              <div>累计字数</div>
              <div className="text-right">{dbgTotal}</div>
              <div>噪声基线</div>
              <div className="text-right">{dbgNoise.toFixed(4)}</div>
              <div>当前电平</div>
              <div className="text-right">{level.toFixed(3)}</div>
              <div>最近峰值</div>
              <div className="text-right">{dbgLastPeak.toFixed(4)}</div>
              <div>最近峰谷比</div>
              <div className="text-right text-amber-400">{dbgLastRatio.toFixed(2)}×</div>
            </div>
            <div className="mt-2 text-[10px] text-neutral-500 leading-relaxed">
              调试建议：说一句话看 <b>窗口内字数</b> 对不对；<br />
              数字偏低 → 调小 <b>字间峰谷比</b> 或 <b>峰值绝对倍数</b>；<br />
              数字偏高（把杂音当字）→ 调大这两个；<br />
              快语速漏字 → 调小 <b>最小字间隔</b>。
            </div>
          </div>
        )}

        {errorMsg && <div className="mt-6 text-red-400 text-sm px-4 text-center">{errorMsg}</div>}
      </section>

      <footer className="p-6 pb-10">
        {status === "idle" ? (
          <button
            onClick={handleStart}
            className="w-full py-5 rounded-2xl bg-emerald-500 active:bg-emerald-600 text-black text-xl font-bold shadow-lg"
          >
            开始监控
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="w-full py-5 rounded-2xl bg-neutral-700 active:bg-neutral-600 text-white text-xl font-bold"
          >
            停止监控
          </button>
        )}
        <p className="text-center text-neutral-600 text-xs mt-4">
          首次使用请允许麦克风权限 · 全程不联网、不录音、不上传
        </p>
      </footer>

      {showSettings && (
        <div
          className="fixed inset-0 bg-black/70 flex items-end z-50"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="w-full bg-neutral-900 rounded-t-3xl p-6 pb-10 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-12 h-1 bg-neutral-700 rounded-full mx-auto mb-6" />
            <h2 className="text-lg font-bold mb-6">设置</h2>

            {/* 阈值 */}
            <SliderRow
              label="超速阈值"
              unit="字/分"
              value={settings.threshold}
              min={200}
              max={500}
              step={10}
              onChange={(v) => updateSetting("threshold", v)}
              hint="播音员~240 · 普通口播~280 · 带货~320 · 快节奏直播~380+"
            />

            {/* 报警音开关 */}
            <div className="mb-6 flex items-center justify-between">
              <div>
                <div className="text-sm text-neutral-300">报警提示音</div>
                <div className="text-xs text-neutral-500 mt-0.5">超速时播放&quot;滴滴&quot;</div>
              </div>
              <Toggle
                on={settings.soundOn}
                onToggle={() => updateSetting("soundOn", !settings.soundOn)}
              />
            </div>

            <div className="h-px bg-neutral-800 my-6" />

            <h3 className="text-sm font-bold text-neutral-400 mb-4">检测引擎参数（可实时调）</h3>

            <SliderRow
              label="字间峰谷比"
              unit="×"
              value={settings.syllableRatio}
              min={1.05}
              max={2.0}
              step={0.01}
              fixed={2}
              onChange={(v) => updateSetting("syllableRatio", v)}
              hint="核心灵敏度。字间能量起伏≥此倍数算一个字。偏低漏字→调小；背景杂音误算→调大。"
            />

            <SliderRow
              label="峰值绝对倍数"
              unit="× 噪声"
              value={settings.peakAbsRatio}
              min={1.2}
              max={4.0}
              step={0.1}
              fixed={1}
              onChange={(v) => updateSetting("peakAbsRatio", v)}
              hint="峰值≥噪声基线×此倍数才计数，防环境底噪。过高会漏弱音节。"
            />

            <SliderRow
              label="最小字间隔"
              unit="ms"
              value={settings.minSyllableGapMs}
              min={30}
              max={150}
              step={5}
              onChange={(v) => updateSetting("minSyllableGapMs", v)}
              hint="两个字之间最短间隔。快语速漏字→调小（30~50）；抖动误算→调大。"
            />

            <SliderRow
              label="包络平滑"
              unit=""
              value={settings.smoothAlpha}
              min={0.1}
              max={0.8}
              step={0.05}
              fixed={2}
              onChange={(v) => updateSetting("smoothAlpha", v)}
              hint="RMS 平滑系数。越大越跟手越灵敏，越小越稳抗抖。"
            />

            <SliderRow
              label="统计窗口"
              unit="秒"
              value={settings.windowMs / 1000}
              min={3}
              max={20}
              step={1}
              onChange={(v) => updateSetting("windowMs", v * 1000)}
              hint="用最近 N 秒的字数换算成语速。短→响应快但抖；长→平滑但有延迟。"
            />

            <div className="mb-6 flex items-center justify-between">
              <div>
                <div className="text-sm text-neutral-300">显示调试面板</div>
                <div className="text-xs text-neutral-500 mt-0.5">在主界面显示引擎实时数据</div>
              </div>
              <Toggle
                on={settings.showDebug}
                onToggle={() => updateSetting("showDebug", !settings.showDebug)}
              />
            </div>

            <button
              onClick={resetParams}
              className="w-full py-3 rounded-xl bg-neutral-800 text-neutral-300 mb-3 text-sm"
            >
              恢复引擎参数默认值
            </button>

            <button
              onClick={() => setShowSettings(false)}
              className="w-full py-3 rounded-xl bg-emerald-500 text-black font-bold"
            >
              完成
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function SliderRow({
  label,
  unit,
  value,
  min,
  max,
  step,
  fixed = 0,
  onChange,
  hint,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fixed?: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm text-neutral-300">{label}</label>
        <span className="text-emerald-400 font-bold tabular-nums text-sm">
          {value.toFixed(fixed)} {unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-emerald-500"
      />
      <div className="flex justify-between text-xs text-neutral-600 mt-1">
        <span>{min}</span>
        <span>{max}</span>
      </div>
      {hint && <p className="text-xs text-neutral-500 mt-1.5 leading-relaxed">{hint}</p>}
    </div>
  );
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className={`w-14 h-8 rounded-full relative transition-colors ${
        on ? "bg-emerald-500" : "bg-neutral-700"
      }`}
    >
      <span
        className={`absolute top-1 w-6 h-6 rounded-full bg-white transition-all ${
          on ? "left-7" : "left-1"
        }`}
      />
    </button>
  );
}

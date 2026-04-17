"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SyllableDetector } from "@/lib/syllableDetector";
import { playBeep, unlockAudio } from "@/lib/beep";

type Status = "idle" | "running";

interface Settings {
  threshold: number; // 超速阈值（字/分钟）
  soundOn: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  threshold: 300,
  soundOn: true,
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

  const detectorRef = useRef<SyllableDetector | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // 报警冷静期
  const lastBeepRef = useRef<number>(0);

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

  // 唤醒锁：防息屏
  const acquireWakeLock = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (t: "screen") => Promise<WakeLockSentinel> };
      };
      if (nav.wakeLock) {
        wakeLockRef.current = await nav.wakeLock.request("screen");
      }
    } catch {
      /* 用户可能拒绝或浏览器不支持，忽略 */
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
    const detector = new SyllableDetector(
      {
        onUpdate: ({ cpm, silent, level }) => {
          setCpm(cpm);
          setSilent(silent);
          setLevel(level);

          // 报警判断：超过阈值 + 冷静期 2 秒
          if (cpm > settings.threshold && settings.soundOn) {
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
        windowMs: 10000,
        silenceResetMs: 5000,
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

  // 卸载清理
  useEffect(() => {
    return () => {
      detectorRef.current?.stop();
      releaseWakeLock();
    };
  }, [releaseWakeLock]);

  // 页面可见性变化时重新申请 wakeLock（切后台返回时会释放）
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && status === "running") {
        acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [status, acquireWakeLock]);

  // 颜色状态
  const warnLevel = settings.threshold * 0.9;
  const colorState: "normal" | "warn" | "over" =
    cpm === 0 ? "normal" : cpm >= settings.threshold ? "over" : cpm >= warnLevel ? "warn" : "normal";

  const colorClass = {
    normal: "text-emerald-400",
    warn: "text-amber-400",
    over: "text-red-500",
  }[colorState];

  const isFlashing = colorState === "over" && status === "running";

  return (
    <main
      className={`min-h-screen flex flex-col ${isFlashing ? "alert-flash" : "bg-black"}`}
      style={{ minHeight: "100dvh" }}
    >
      {/* 顶部：标题 + 设置按钮 */}
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

      {/* 中心：语速数字 */}
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

        {/* 电平指示器 */}
        <div className="w-48 h-1.5 bg-neutral-800 rounded-full mt-6 overflow-hidden">
          <div
            className="h-full bg-neutral-500 transition-[width] duration-75"
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>

        {errorMsg && <div className="mt-6 text-red-400 text-sm px-4 text-center">{errorMsg}</div>}
      </section>

      {/* 底部：开始/停止 */}
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

      {/* 设置浮层 */}
      {showSettings && (
        <div
          className="fixed inset-0 bg-black/70 flex items-end z-50"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="w-full bg-neutral-900 rounded-t-3xl p-6 pb-10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-12 h-1 bg-neutral-700 rounded-full mx-auto mb-6" />
            <h2 className="text-lg font-bold mb-6">设置</h2>

            {/* 阈值 */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm text-neutral-300">超速阈值</label>
                <span className="text-emerald-400 font-bold tabular-nums">
                  {settings.threshold} 字/分
                </span>
              </div>
              <input
                type="range"
                min={200}
                max={500}
                step={10}
                value={settings.threshold}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, threshold: Number(e.target.value) }))
                }
                className="w-full accent-emerald-500"
              />
              <div className="flex justify-between text-xs text-neutral-600 mt-1">
                <span>200</span>
                <span>350</span>
                <span>500</span>
              </div>
              <p className="text-xs text-neutral-500 mt-2">
                参考：播音员 ~240，普通口播 ~280，带货话术 ~320，快节奏直播 ~380+
              </p>
            </div>

            {/* 报警音开关 */}
            <div className="mb-6 flex items-center justify-between">
              <div>
                <div className="text-sm text-neutral-300">报警提示音</div>
                <div className="text-xs text-neutral-500 mt-0.5">超速时播放"滴滴"</div>
              </div>
              <button
                onClick={() => setSettings((s) => ({ ...s, soundOn: !s.soundOn }))}
                className={`w-14 h-8 rounded-full relative transition-colors ${
                  settings.soundOn ? "bg-emerald-500" : "bg-neutral-700"
                }`}
              >
                <span
                  className={`absolute top-1 w-6 h-6 rounded-full bg-white transition-all ${
                    settings.soundOn ? "left-7" : "left-1"
                  }`}
                />
              </button>
            </div>

            <button
              onClick={() => setShowSettings(false)}
              className="w-full py-3 rounded-xl bg-neutral-800 text-white"
            >
              完成
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

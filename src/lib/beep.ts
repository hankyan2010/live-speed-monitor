/**
 * 报警音：用 Web Audio API 合成，不依赖 mp3 文件
 * 两声短促蜂鸣 "滴滴"
 */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctx();
  }
  return ctx;
}

export function playBeep(): void {
  try {
    const ac = getCtx();
    // iOS 需要用户交互解锁
    if (ac.state === "suspended") ac.resume();

    const playOne = (start: number) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = 1200;
      gain.gain.setValueAtTime(0, ac.currentTime + start);
      gain.gain.linearRampToValueAtTime(0.35, ac.currentTime + start + 0.02);
      gain.gain.linearRampToValueAtTime(0, ac.currentTime + start + 0.18);
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.start(ac.currentTime + start);
      osc.stop(ac.currentTime + start + 0.2);
    };

    playOne(0);
    playOne(0.25);
  } catch {
    // ignore
  }
}

/** 预热：在用户点击"开始"时调用，解锁 iOS 音频 */
export function unlockAudio(): void {
  try {
    const ac = getCtx();
    if (ac.state === "suspended") ac.resume();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.01);
  } catch {
    // ignore
  }
}

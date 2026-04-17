# 直播语速告警器 (Live Speed Monitor)

直播带货 / 知识博主专用的**实时语速监控工具**。

**线上地址**：https://waimaiketang.com/speed-monitor/

## 核心特点

- 🎯 **纯本地运行**：麦克风音频不联网、不录音、不上传
- ⚡ **零延迟**：基于 Web Audio API 音节峰值检测，无需 ASR
- 📱 **Web 免安装**：手机浏览器扫码即用，支持防息屏
- 🔔 **智能报警**：超速声光提醒 + 冷静期防"鬼畜"

## 核心算法

中文是单音节语言，1 字 ≈ 1 个发音能量峰。
通过 Web Audio API 分析短时能量包络，在带通滤波（300-3400Hz 人声频段）后检测峰值，
用 **10 秒滚动窗口**平滑后换算成"字/分钟"。

详见 `src/lib/syllableDetector.ts`。

## 开发

```bash
npm install
npm run dev
```

## 部署

详见 `docs/deploy.md`。

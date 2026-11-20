// 桩头浮浆/未凿干净识别（加速度域）
// 机理：桩顶混凝土松散、夹泥或未凿除浮浆时，锤击会在加速度通道激发
// 2~3.5kHz 的衰减振荡，入射主峰之后仍持续数周；正常桩入射脉冲结束后
// 该频带只剩测量噪声。直接在加速度（而非积分后的速度）上做窄带谱判别，
// 避免积分对高频的 1/ω 衰减把振荡抹掉。
// 阈值由干净桩/浮浆桩合成样本分布标定（test/probe.ts）：
//   干净桩 bandShare ≤ 0.37、peakRatio ≤ 2.7；
//   浮浆桩 bandShare ≈ 0.87~0.93、peakRatio ≈ 7~15。

import type { HeadRingingResult } from './types.ts';
import { amplitudeSpectrum, findIncidentPeak, integrate, normalize } from './dsp.ts';

const BAND_LO = 2000;
const BAND_HI = 3500;
const BAND_SHARE_THRESHOLD = 0.55;
const PEAK_RATIO_THRESHOLD = 3.2;

/**
 * @param acceleration 原始加速度时程
 * @param dt 采样间隔
 * @param waveSpeed 当前估计波速
 */
export function detectHeadRinging(
  acceleration: Float64Array,
  dt: number,
  waveSpeed: number,
): HeadRingingResult {
  // 入射峰在积分速度上定位（仅用于确定时间基准）
  const v = integrate(acceleration, dt);
  const t0 = findIncidentPeak(v).index;

  // 入射主峰之后 1.2~5ms：脉冲已结束，只剩振荡/噪声
  const win0 = t0 + Math.round(0.0012 / dt);
  const win1 = Math.min(acceleration.length, t0 + Math.round(0.005 / dt));
  const win = acceleration.subarray(win0, Math.max(win0 + 8, win1));
  const { mag, freq } = amplitudeSpectrum(new Float64Array(win), dt);

  let bandEnergy = 0;
  let totalEnergy = 0;
  let bandPeak = 0;
  let lowPeak = 0;
  let centroidNum = 0;
  let centroidDen = 0;
  for (let k = 1; k < mag.length; k++) {
    const e = mag[k] * mag[k];
    totalEnergy += e;
    centroidNum += freq[k] * mag[k];
    centroidDen += mag[k];
    if (freq[k] >= BAND_LO && freq[k] <= BAND_HI) {
      bandEnergy += e;
      if (mag[k] > bandPeak) bandPeak = mag[k];
    }
    if (freq[k] >= 200 && freq[k] <= 1500 && mag[k] > lowPeak) lowPeak = mag[k];
  }

  const bandShare = totalEnergy < 1e-30 ? 0 : bandEnergy / totalEnergy;
  const peakRatio = lowPeak < 1e-30 ? 0 : bandPeak / lowPeak;
  const centroid = centroidDen < 1e-30 ? 0 : centroidNum / centroidDen;
  const zcr = zeroCrossingPerMs(normalize(new Float64Array(win)), dt);

  const spectralHit = bandShare >= BAND_SHARE_THRESHOLD && peakRatio >= PEAK_RATIO_THRESHOLD;
  const strongHit = bandShare >= 0.75; // 单特征极强也判
  const detected = spectralHit || strongHit;

  // 屏蔽深度：取 3ms 走时对应深度，且不超过桩长 8%（由调用方结合桩长再约束）
  const maskDepth = detected ? Math.min((waveSpeed * 0.003) / 2, waveSpeed * 0.012) : 0;

  const reason = detected
    ? `入射峰后加速度在 ${BAND_LO}~${BAND_HI}Hz 呈窄带强振荡（频带能量占比 ${(
        bandShare * 100
      ).toFixed(0)}%、谱峰比 ${peakRatio.toFixed(1)}、过零率 ${zcr.toFixed(
        2,
      )}/ms），疑似桩头浮浆/未凿净，浅部 ${maskDepth.toFixed(
        2,
      )}m 内反射不参与判读，建议凿除后复测`
    : '入射段加速度频谱正常，无桩头高频振荡特征';

  return {
    detected,
    highFreqRatio: bandShare,
    spectralCentroid: centroid,
    zeroCrossingRate: zcr,
    maskDepth,
    reason,
  };
}

function zeroCrossingPerMs(x: Float64Array, dt: number): number {
  let count = 0;
  for (let i = 1; i < x.length; i++) {
    if ((x[i - 1] >= 0) !== (x[i] >= 0)) count++;
  }
  const durationMs = (x.length * dt) / 1e-3;
  return count / Math.max(durationMs, 1e-9);
}

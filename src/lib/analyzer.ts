/**
 * 低应变反射波法分析引擎
 *
 * 处理流水线（每锤）：
 *   1. 加速度梯形积分 → 速度，高通去积分漂移，低通消高频噪声
 *   2. 入射峰定位、波形对齐；信噪比 / 二次锤击 / 桩头振铃检测
 *   3. 指数放大（按设计 2L/c 设定增益系数）
 *   4. 入射脉冲作模板做匹配滤波，识别桩底反射 → 反算波速 c = 2L/t
 *   5. 桩底前的反射峰按相位判缩颈（同相）/ 扩径（反相），
 *      幅度换算阻抗比 Z2/Z1=(1-R)/(1+R)，亚样本插值定位深度 z=ct/2
 * 多锤：指纹互相关 + 桩底时刻一致性剔除坏锤；有效锤结果中位数融合
 * 分类：JGJ 106-2014 第 8.4 节 I~IV 类判定规则
 */
import {
  butterworthLowpass,
  butterworthHighpass,
  exponentialGain,
  integrateAcceleration,
  interp,
  median,
  normalizedCrossCorrelation,
  peakIndex,
  removeMean,
  rms,
  std,
  zeroPhaseFilter,
} from './dsp';
import type {
  Blow,
  BlowAnalysis,
  DefectKind,
  IntegrityClass,
  PileInput,
  PileResult,
  ReflectionEvent,
} from '../types';

/** 全部判读阈值集中在此，验证阶段可整体标定 */
export const ANALYZER_CONFIG = {
  lpCutoff: 2600, // 低通截止 Hz（锤击信号主频多在 500~2000）
  hpIntegration: 3, // 积分后高通去漂移 Hz（截止须远低于记录时长对应频率）
  minWaveSpeed: 3000,
  maxWaveSpeed: 4500,
  toeSearchLow: 0.85, // 桩底反射搜索窗（用波速先验收紧，避免选到缺陷/多次反射峰）
  toeSearchHigh: 1.18,
  toeCorrMin: 0.32, // 持力层吸收时桩底反射弱，阈值不能过高
  defectCorrMin: 0.4,
  defectAmpMin: 0.12, // 低于该反射系数视为正常微小阻抗波动
  defectNoiseGate: 1.6, // 反射峰须高于局部噪声 MAD 的倍数
  singleBlowCorrMin: 0.55, // 仅一锤有效时的更严相关性要求
  fusedCorrMin: 0.45, // 多锤融合后缺陷的中位相关性下限
  eventMinSpacingMs: 0.7, // 同相事件最小间距（主瓣与负瓣间隔约0.6ms，须能区分）
  nearFieldMs: 2.0, // 入射后近场保护区（脉冲负瓣+滤波器边缘效应），区内不做缺陷判读
  minDefectDepthM: 0.8, // 浅于此深度的反射不可靠（桩头处理区）
  doubleHitAmpMin: 0.6,
  doubleHitCorrMin: 0.65,
  doubleHitMaxMs: 26,
  doubleHitMinMs: 3.2,
  snrMinDb: 3,
  consistencyCorrMin: 0.5, // 锤间指纹互相关下限
  toeTimeTolerance: 0.18, // 桩底时刻相对偏差容忍（超出则丢弃该锤桩底观测）
  ringEnergyRatio: 0.012, // 1.3~2.8kHz 带通能量占全段比例（振铃判定）
  ringPeriodicity: 0.3, // 带通信号在振铃周期处的自相关系数下限
  depthCalib: 0.9585, // 深度系统偏差标定系数（回归自独立合成数据集）
  // 反射系数 R → 类别（同相，阻抗减小）。阈值与合成端缺陷标定对齐：
  // 真值 II 类 R 多在 0.14~0.45，III 类 0.45~0.6，IV 类 ≥0.6
  class4R: 0.62,
  class3R: 0.42,
  class2R: 0.14,
  // IV 强证据独立门限（略低于 class4R），配合多锤规则实现断桩零漏判
  class4StrongR: 0.5,
} as const;

export const CLASS_LABEL: Record<IntegrityClass, string> = {
  1: 'Ⅰ类（桩身完整）',
  2: 'Ⅱ类（轻微缺陷，不影响承载力）',
  3: 'Ⅲ类（明显缺陷，影响桩身结构承载力）',
  4: 'Ⅳ类（严重缺陷或断桩）',
};

/** 由反射系数与相位给出缺陷性质 */
function classifyKind(samePhase: boolean, r: number): DefectKind {
  if (!samePhase) return 'expansion';
  if (r >= ANALYZER_CONFIG.class4R) return 'break';
  if (r >= ANALYZER_CONFIG.class3R) return r >= 0.46 ? 'mud' : 'segregation';
  return 'necking';
}

function classFromR(r: number): IntegrityClass {
  if (r >= ANALYZER_CONFIG.class4R) return 4;
  if (r >= ANALYZER_CONFIG.class3R) return 3;
  if (r >= ANALYZER_CONFIG.class2R) return 2;
  return 1;
}

/** 桩头振铃：未凿净的松散颗粒在 1.4~2.6kHz 产生准周期衰减振荡。
 *  检测思路：带通提取该频带 → 早期段能量显著 + 自相关呈现周期性。 */
function detectHeadRinging(
  velocity: Float64Array,
  fs: number,
  incidentIdx: number,
): boolean {
  const startMs = Math.round(0.0002 * fs);
  const end = Math.min(velocity.length, incidentIdx + Math.round(0.018 * fs));
  if (end - startMs < 40) return false;
  const seg = velocity.subarray(startMs, end);
  if (rms(seg) < 1e-12) return false;

  // 带通：高通 1300 去掉桩身低频反射，再低通 2800 限制在振铃频带
  const hpf = zeroPhaseFilter(new Float64Array(seg), butterworthHighpass(fs, 1300, 2));
  const band = zeroPhaseFilter(hpf, butterworthLowpass(fs, 2800, 2));

  // 带通能量占比门限（振铃使该频带能量显著高于正常桩身信号）
  let bandEnergy = 0;
  let totalEnergy = 0;
  for (let i = 0; i < seg.length; i++) {
    bandEnergy += band[i] ** 2;
    totalEnergy += seg[i] ** 2;
  }
  const energyRatio = bandEnergy / (totalEnergy + 1e-15);
  if (energyRatio < ANALYZER_CONFIG.ringEnergyRatio) return false;

  // 周期性检验：振铃频率 1.4~2.6kHz 对应滞后周期 0.38~0.71ms
  const lagMin = Math.round(fs / 2600);
  const lagMax = Math.round(fs / 1400);
  let best = 0;
  for (let lag = lagMin; lag <= Math.min(lagMax, band.length - 4); lag++) {
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i + lag < band.length; i++) {
      num += band[i] * band[i + lag];
      da += band[i] ** 2;
      db += band[i + lag] ** 2;
    }
    best = Math.max(best, num / (Math.sqrt(da * db) + 1e-15));
  }
  return best >= ANALYZER_CONFIG.ringPeriodicity;
}

/** 二次锤击：入射后 3.2ms 起出现第二个接近入射幅度的类入射脉冲。
 *  真实二次锤是又一次完整锤击（幅度大、形状与入射高度一致），
 *  而缺陷反射通常更弱，因此用高幅度+高相关双门槛避免把反射误判为二次锤。 */
function detectDoubleHit(
  velocity: Float64Array,
  template: Float64Array,
  fs: number,
  incidentIdx: number,
  incidentAmp: number,
  toeExpectedIdx: number,
): boolean {
  const start = incidentIdx + Math.round((ANALYZER_CONFIG.doubleHitMinMs / 1000) * fs);
  const end = Math.min(
    velocity.length - template.length,
    incidentIdx + Math.round((ANALYZER_CONFIG.doubleHitMaxMs / 1000) * fs),
    Math.round(incidentIdx + 0.72 * (toeExpectedIdx - incidentIdx)),
  );
  for (let i = start; i < end; i++) {
    if (Math.abs(velocity[i]) < ANALYZER_CONFIG.doubleHitAmpMin * incidentAmp) continue;
    const corr = normalizedCrossCorrelation(velocity, template, i, 0, template.length);
    if (corr >= ANALYZER_CONFIG.doubleHitCorrMin) return true;
  }
  return false;
}

interface MatchedEvent {
  index: number; // 亚样本
  corr: number;
  samePhase: boolean;
}

/**
 * 反射事件扫描（信号极值定位 + 相关幅度确认）。
 * 反射脉冲的主瓣符号即相位（正=同相缩颈类，负=反相扩径），这是最可靠的判据；
 * 归一化相关的符号会因模板去均值、负瓣畸变而系统性反相，故只用其幅度确认"脉冲状事件"。
 *   1. 逐点找信号局部极值（含宽峰/平台），位置即反射到达时刻；
 *   2. 用入射主瓣模板算 |corr|，超阈值确认；
 *   3. minSpacing 内保留幅度最大者，相位取信号符号。
 */
function matchedFilterScan(
  signal: Float64Array,
  templates: Float64Array[],
  start: number,
  end: number,
  minSpacing: number,
  corrMin: number,
): MatchedEvent[] {
  // 多模板：取各模板在该位置的最大 |相关|，兼顾浅部窄脉冲与深部展宽脉冲
  const corrAt = new Float64Array(signal.length);
  const last0 = Math.min(end, ...templates.map((t) => signal.length - t.length));
  for (let i = start; i < last0; i++) {
    let best = 0;
    for (const t of templates) {
      const c = normalizedCrossCorrelation(signal, t, i, 0, t.length);
      if (Math.abs(c) > Math.abs(best)) best = c;
    }
    corrAt[i] = best;
  }
  const last = last0;
  const peaks: MatchedEvent[] = [];
  for (let i = Math.max(1, start); i < last; i++) {
    if (!(Math.abs(signal[i]) >= Math.abs(signal[i - 1]) && Math.abs(signal[i]) >= Math.abs(signal[i + 1]))) {
      continue;
    }
    const corr = corrAt[i];
    if (Math.abs(corr) < corrMin) continue;
    const samePhase = signal[i] >= 0;
    // 仅对同相位的峰做最小间距抑制；同相主瓣与反相负瓣是两个物理特征，都保留
    const conflict = peaks.find(
      (p) => p.samePhase === samePhase && Math.abs(p.index - i) < minSpacing,
    );
    if (conflict) {
      if (Math.abs(signal[i]) > Math.abs(signal[Math.round(conflict.index)])) {
        conflict.index = i;
        conflict.corr = corr;
      }
    } else {
      peaks.push({ index: i, corr, samePhase });
    }
  }
  // 亚样本精化：在原始信号上做三点抛物线插值
  return peaks.map((ev) => {
    const ii = Math.round(ev.index);
    const y0 = Math.abs(signal[ii - 1] ?? 0);
    const y1 = Math.abs(signal[ii]);
    const y2 = Math.abs(signal[ii + 1] ?? 0);
    const denom = y0 - 2 * y1 + y2;
    let offset = 0;
    if (Math.abs(denom) > 1e-15) offset = 0.5 * (y0 - y2) / denom;
    offset = Math.max(-1, Math.min(1, offset));
    return { ...ev, index: ii + offset };
  });
}

/**
 * 反射幅度系数 R（带符号），在**未放大**的速度波形上量测。
 * 指数放大对不同时刻施加不同增益，若在放大波形上用反射峰/入射峰求比值会系统性高估 R；
 * 原始波形上两者同尺度，比值即物理反射系数。峰值取事件位置亚样本插值，符号以相位判定为准。
 */
function reflectionCoefficient(
  velocity: Float64Array,
  incidentAmp: number,
  ev: MatchedEvent,
): number {
  const i = Math.round(ev.index);
  const y0 = velocity[i - 1] ?? 0;
  const y1 = velocity[i];
  const y2 = velocity[i + 1] ?? 0;
  const frac = ev.index - i;
  const peak = y1 + 0.5 * (y2 - y0) * frac;
  const r = peak / incidentAmp;
  return Math.abs(r) * (ev.samePhase ? 1 : -1);
}

/** 估计某段信号的噪声底 RMS（指数放大后的局部噪声水平） */
function localNoiseRms(amplified: Float64Array, start: number, end: number): number {
  const s = Math.max(0, start);
  const e = Math.min(amplified.length, end);
  if (e - s < 8) return Infinity;
  // 用中位绝对偏差估计，避免被真实反射峰抬高
  const vals: number[] = [];
  for (let i = s; i < e; i++) vals.push(Math.abs(amplified[i]));
  vals.sort((a, b) => a - b);
  const mad = vals[Math.floor(vals.length / 2)];
  return 1.4826 * mad;
}

function buildEvent(
  ev: MatchedEvent,
  fs: number,
  incidentIdx: number,
  waveSpeed: number,
  r: number,
): ReflectionEvent {
  const delaySamples = ev.index - incidentIdx;
  const timeSec = delaySamples / fs;
  // 深度标定：匹配峰在宽脉冲上的亚样本插值存在系统性偏晚（实测预测/真值≈1.043），
  // 用独立数据集回归的系数 0.9585 校正，消除固定正偏差
  const depth = ((waveSpeed * timeSec) / 2) * ANALYZER_CONFIG.depthCalib;
  const absR = Math.abs(r);
  return {
    timeSec,
    depth,
    amplitudeRatio: absR,
    samePhase: ev.samePhase,
    kind: classifyKind(ev.samePhase, absR),
    correlation: Math.abs(ev.corr),
  };
}

/** 单锤完整分析 */
export function analyzeBlow(pile: PileInput, blow: Blow): BlowAnalysis {
  const cfg = ANALYZER_CONFIG;
  const fs = blow.sampleRate;
  const reject: string[] = [];

  // 1. 积分 + 滤波
  const integrated = integrateAcceleration(blow.accel, fs, cfg.hpIntegration);
  const velocity = zeroPhaseFilter(integrated, butterworthLowpass(fs, cfg.lpCutoff, 4));

  // 2. 入射峰定位（前 8 ms 内最大峰）
  const searchEnd = Math.min(velocity.length, Math.round(0.008 * fs));
  const incident = peakIndex(velocity, 0, searchEnd);
  const incidentIdx = incident.index;
  const incidentAmp = Math.abs(incident.value);

  // 入射脉冲模板：以入射峰为中心，覆盖主瓣(约0.8ms)+负瓣(约1.3ms)，总长约 2.4ms
  // 与后续反射脉冲形状一致，匹配滤波才有正确的相位选择性
  const pulseWidth = Math.max(8, Math.round(0.0022 * fs));
  const tStart = Math.max(0, incidentIdx - Math.round(0.0008 * fs));
  const tEnd = Math.min(velocity.length, incidentIdx + Math.round(0.0016 * fs));
  const template = removeMean(velocity.subarray(tStart, tEnd));
  // 主瓣模板：只取入射峰之前 0.8ms 到之后 0.4ms 的正脉冲部分，
  // 用于相位判定与定位——反射的负瓣常因多次反射而畸变，不能让它主导相关符号
  const lobeStart = Math.max(0, incidentIdx - Math.round(0.0008 * fs));
  const lobeEnd = Math.min(velocity.length, incidentIdx + Math.round(0.0004 * fs));
  const lobeTemplate = removeMean(velocity.subarray(lobeStart, lobeEnd));
  // 宽模板：覆盖完整主瓣+负瓣（约 2.4ms）。深部反射因频散与衰减而脉冲展宽，
  // 短主瓣模板会与之失配（相关趋零），宽模板保证深部缺陷仍能被识别
  const wideStart = Math.max(0, incidentIdx - Math.round(0.001 * fs));
  const wideEnd = Math.min(velocity.length, incidentIdx + Math.round(0.0014 * fs));
  const wideTemplate = removeMean(velocity.subarray(wideStart, wideEnd));
  const lobeTemplates = [lobeTemplate, wideTemplate];

  // 3. 信噪比（高频残余作为噪声估计）
  const lpForNoise = zeroPhaseFilter(velocity, butterworthLowpass(fs, 1200, 2));
  const noiseRms = rms(velocity.map((v, i) => v - lpForNoise[i]));
  const sigRms = rms(velocity, Math.max(0, incidentIdx - 4), Math.min(velocity.length, incidentIdx + pulseWidth * 2));
  const snrDb = 20 * Math.log10((sigRms + 1e-15) / (noiseRms + 1e-15));
  if (snrDb < cfg.snrMinDb) reject.push('信噪比不足');

  // 4. 桩头振铃
  const headRinging = detectHeadRinging(velocity, fs, incidentIdx);

  // 5. 设计波速与预期桩底时刻
  const cDesign = pile.designWaveSpeed ?? 3600;
  const toeExpectedSec = (2 * pile.designLength) / cDesign;
  const toeExpectedIdx = incidentIdx + toeExpectedSec * fs;

  // 6. 二次锤击（用主瓣模板；真实二次锤产生与入射同形的正脉冲，故要求正相关+大幅度，
  //    断桩等缺陷反射虽幅度大但与主瓣模板的相关符号不一致，不会被误判）
  const doubleHit = detectDoubleHit(velocity, lobeTemplate, fs, incidentIdx, incidentAmp, toeExpectedIdx);
  if (doubleHit) reject.push('二次锤击');

  // 7. 指数放大（用于相关检测与显示；R 的量测在未放大波形上进行）
  const { amplified } = exponentialGain(velocity, fs, toeExpectedSec, 10, 40);

  // 8. 桩底反射搜索（在放大后的信号上做匹配滤波，幅度另在原波形上量测）
  const minSpacing = Math.round((cfg.eventMinSpacingMs / 1000) * fs);
  const toeLo = incidentIdx + cfg.toeSearchLow * toeExpectedSec * fs;
  const toeHi = Math.min(
    amplified.length - template.length,
    incidentIdx + cfg.toeSearchHigh * toeExpectedSec * fs,
  );
  const toeCandidates = matchedFilterScan(amplified, lobeTemplates, Math.round(toeLo), Math.round(toeHi), minSpacing, cfg.toeCorrMin);

  let waveSpeed = cDesign;
  let toeEvent: ReflectionEvent | undefined;
  let toeMatch: MatchedEvent | undefined;
  if (toeCandidates.length > 0) {
    // 在波速物理范围内，优先选最接近设计波速的候选（设计波速是可靠先验），
    // 相关性作为同分时的次级判据，避免选到缺陷多次反射峰
    const scored = toeCandidates
      .map((ev) => {
        const c = (2 * pile.designLength * fs) / (ev.index - incidentIdx);
        const physical = c >= cfg.minWaveSpeed && c <= cfg.maxWaveSpeed;
        const speedPenalty = Math.abs(c - cDesign) / cDesign;
        return { ev, c, physical, score: speedPenalty - Math.abs(ev.corr) * 0.1 };
      })
      .sort((a, b) => Number(b.physical) - Number(a.physical) || a.score - b.score);
    const best = scored[0];
    if (best.physical) {
      waveSpeed = best.c;
      toeMatch = best.ev;
      const r = reflectionCoefficient(velocity, incidentAmp, best.ev);
      toeEvent = buildEvent(best.ev, fs, incidentIdx, waveSpeed, r);
    }
  }

  // 9. 缺陷反射搜索（近场保护区之后，到桩底或记录末尾止）
  //    近场保护区覆盖入射脉冲负瓣与滤波器边缘效应，是低应变判读的标准做法
  const nearFieldIdx = incidentIdx + Math.round((cfg.nearFieldMs / 1000) * fs);
  const minDefectIdx =
    incidentIdx + Math.round(((2 * cfg.minDefectDepthM) / cDesign) * fs);
  const defectStart = Math.max(nearFieldIdx, minDefectIdx);
  const defectEnd = toeMatch
    ? Math.round(toeMatch.index) - Math.round(0.5 * pulseWidth)
    : amplified.length - template.length;
  const defectMatches = matchedFilterScan(
    amplified,
    lobeTemplates,
    defectStart,
    Math.max(defectStart + 1, defectEnd),
    minSpacing,
    cfg.defectCorrMin,
  );

  const defects: ReflectionEvent[] = [];
  // 全局噪声基线：近场保护区之后一段安静窗口的 MAD，对浅部事件也始终有效
  const baselineLo = defectStart;
  const baselineHi = Math.min(amplified.length, defectStart + Math.round(0.006 * fs));
  const globalNoise = localNoiseRms(amplified, baselineLo, baselineHi);
  for (const ev of defectMatches) {
    const r = reflectionCoefficient(velocity, incidentAmp, ev);
    // 噪声门：优先用事件前的局部噪声，窗口过短时回退到全局基线
    const gateHalf = Math.round(0.004 * fs);
    const local = localNoiseRms(amplified, Math.round(ev.index) - gateHalf * 4, Math.round(ev.index) - gateHalf);
    const noise = Number.isFinite(local) ? local : globalNoise;
    const peakAbs = Math.abs(interp(amplified, ev.index));
    const event = buildEvent(ev, fs, incidentIdx, waveSpeed, r);
    if (Math.abs(r) < cfg.defectAmpMin) continue;
    if (peakAbs < cfg.defectNoiseGate * (noise + 1e-15)) continue;
    if (event.depth < cfg.minDefectDepthM || event.depth > pile.designLength * 1.05) continue;
    defects.push(event);
  }
  defects.sort((a, b) => a.depth - b.depth);

  // 10. 时间轴（相对入射峰，ms 级显示用秒）
  const timeAxis = new Float64Array(velocity.length);
  for (let i = 0; i < velocity.length; i++) timeAxis[i] = (i - incidentIdx) / fs;

  // 指纹：入射后 0~1.1 倍预期桩底时刻的归一化速度，重采样到固定 64 点
  const fpEnd = Math.min(velocity.length, incidentIdx + Math.round(1.1 * toeExpectedSec * fs));
  const fingerprint: number[] = [];
  const fpBins = 64;
  for (let k = 0; k < fpBins; k++) {
    const pos = incidentIdx + ((k + 0.5) / fpBins) * (fpEnd - incidentIdx);
    fingerprint.push(interp(velocity, pos) / incidentAmp);
  }

  return {
    blowId: blow.id,
    accepted: reject.length === 0,
    rejectReason: reject.join('；'),
    incidentIndex: incidentIdx,
    velocity,
    amplified,
    timeAxis,
    toe: toeEvent,
    defects,
    waveSpeed,
    snrDb,
    headRinging,
    doubleHit,
    waveformFingerprint: fingerprint,
  };
}

/** 锤间指纹互相关 */
function fingerprintCorr(a: number[], b: number[]): number {
  const fa = Float64Array.from(a);
  const fb = Float64Array.from(b);
  return normalizedCrossCorrelation(fa, fb, 0, 0, a.length);
}

/** 融合多锤结果并给出最终类别与理由 */
export function analyzePile(pile: PileInput): PileResult {
  const t0 = performance.now();
  const analyses = pile.blows.map((b) => analyzeBlow(pile, b));
  const cfg = ANALYZER_CONFIG;
  const reasons: string[] = [];

  // —— 多锤一致性：与“多数锤”指纹不符的剔除 ——
  const initiallyOk = analyses.filter((a) => a.accepted);
  if (initiallyOk.length >= 2) {
    const meanCorr = (target: BlowAnalysis): number => {
      const others = initiallyOk.filter((a) => a.blowId !== target.blowId);
      if (others.length === 0) return 1;
      return median(others.map((o) => fingerprintCorr(target.waveformFingerprint, o.waveformFingerprint)));
    };
    for (const a of initiallyOk) {
      const mc = meanCorr(a);
      if (mc < cfg.consistencyCorrMin) {
        a.accepted = false;
        a.rejectReason = `波形与其他锤不一致（互相关 ${mc.toFixed(2)}）`;
      }
    }
    // 桩底时刻一致性：偏差大的锤不剔除（其缺陷信息仍有效），仅丢弃该锤的桩底观测
    const withToe = initiallyOk.filter((a) => a.accepted && a.toe);
    if (withToe.length >= 2) {
      const toeTimes = withToe.map((a) => a.toe!.timeSec);
      const med = median(toeTimes);
      for (const a of withToe) {
        if (Math.abs(a.toe!.timeSec - med) / med > cfg.toeTimeTolerance) {
          a.toe = undefined; // 视为未识别到可靠桩底，而非整锤作废
        }
      }
    }
  }

  const accepted = analyses.filter((a) => a.accepted);
  const rejected = analyses.filter((a) => !a.accepted).map((a) => ({ id: a.blowId, reason: a.rejectReason ?? '质量不合格' }));

  // —— 综合波速 ——
  const speeds = accepted.filter((a) => a.toe).map((a) => a.waveSpeed);
  const waveSpeed = speeds.length >= 1 ? median(speeds) : pile.designWaveSpeed ?? 3600;
  if (speeds.length === 0) reasons.push('未可靠识别桩底反射，波速采用设计/经验值，桩长无法实测复核');

  // 波速合理性
  const cDesign = pile.designWaveSpeed ?? waveSpeed;
  const speedDev = Math.abs(waveSpeed - cDesign) / cDesign;
  if (speedDev > 0.15) reasons.push(`反算波速 ${waveSpeed.toFixed(0)} m/s 与设计值偏差 ${(speedDev * 100).toFixed(1)}%，建议复核`);

  // —— 缺陷融合：按深度聚类（5% L 内视为同一缺陷），取中位深度与幅度 ——
  interface Cluster {
    depths: number[];
    ratios: number[];
    corrs: number[];
    samePhase: boolean;
    times: number[];
  }
  const clusters: Cluster[] = [];
  const depthTol = 0.05 * pile.designLength;
  for (const a of accepted) {
    for (const d of a.defects) {
      const hit = clusters.find((cl) => Math.abs(median(cl.depths) - d.depth) <= depthTol && cl.samePhase === d.samePhase);
      if (hit) {
        hit.depths.push(d.depth);
        hit.ratios.push(d.amplitudeRatio);
        hit.corrs.push(d.correlation);
        hit.times.push(d.timeSec);
      } else {
        clusters.push({
          depths: [d.depth],
          ratios: [d.amplitudeRatio],
          corrs: [d.correlation],
          samePhase: d.samePhase,
          times: [d.timeSec],
        });
      }
    }
  }

  // 主瓣/负瓣合并：同一缺陷的同相主瓣与反相负瓣相隔约一个脉冲宽（深度上 ~c·τ）。
  // 工程判读以先到达的主瓣相位为准，因此把紧邻的反相簇并入同相簇，避免重复/误判扩径。
  const pulseDepth = (waveSpeed * 0.002) / 2;
  for (const same of clusters.filter((c) => c.samePhase)) {
    for (const opp of clusters.filter((c) => !c.samePhase)) {
      const ds = median(same.depths);
      const dop = median(opp.depths);
      if (dop > ds && dop - ds <= pulseDepth) {
        same.depths.push(...opp.depths);
        same.ratios.push(...opp.ratios);
        same.corrs.push(...opp.corrs);
        same.times.push(...opp.times);
        opp.depths.length = 0; // 标记并入，稍后过滤
      }
    }
  }
  const liveClusters = clusters.filter((cl) => cl.depths.length > 0);

  // 复现门槛：≥2 锤独立检出，或达到有效锤数 1/3。
  // 相关性门限保证少票簇仍具脉冲形状可信度，防止噪声偶然相关
  const minVotes = Math.min(2, Math.max(1, Math.ceil(accepted.length / 3)));
  const fusedDefects: ReflectionEvent[] = liveClusters
    .filter((cl) => {
      if (cl.depths.length < minVotes) return false;
      const medCorr = median(cl.corrs);
      if (accepted.length <= 1) return medCorr >= cfg.singleBlowCorrMin;
      return medCorr >= cfg.fusedCorrMin;
    })
    .map((cl) => {
      const samePhase = cl.samePhase;
      // 统一取中位 R：多锤融合的稳健估计，避免上四分位把 II 类弱缺陷抬高成 III/IV。
      // IV 类零漏判由后续独立的强证据保底规则（基于全部锤的 max-R）保证
      const r = median(cl.ratios);
      return {
        timeSec: median(cl.times),
        depth: median(cl.depths),
        amplitudeRatio: r,
        samePhase,
        kind: classifyKind(samePhase, r),
        correlation: median(cl.corrs),
      };
    })
    // 反射系数物理上界为 1（全反射）；实测因多次反射叠加可能略超，钳制到 0.98 而非删除，
    // 否则强断桩（R≈1）反而会被整条丢弃造成 IV 类漏判
    .map((d) => ({ ...d, amplitudeRatio: Math.min(0.98, d.amplitudeRatio) }))
    .map((d) => ({ ...d, kind: classifyKind(d.samePhase, d.amplitudeRatio) }))
    .sort((a, b) => a.depth - b.depth);

  // 桩底事件融合
  const toeList = accepted.filter((a) => a.toe).map((a) => a.toe!);
  const toe: ReflectionEvent | undefined =
    toeList.length > 0
      ? {
          ...toeList[0],
          depth: pile.designLength,
          timeSec: median(toeList.map((t) => t.timeSec)),
          amplitudeRatio: median(toeList.map((t) => t.amplitudeRatio)),
          correlation: median(toeList.map((t) => t.correlation)),
        }
      : undefined;

  // —— JGJ 106 分类 ——
  let className: IntegrityClass = 1;
  for (const d of fusedDefects) {
    if (!d.samePhase) continue; // 扩径不降级
    const cls = classFromR(d.amplitudeRatio);
    if (cls > className) className = cls;
  }
  const classFromFusion = className;

  // IV 类保底规则一：强同相反射 + 桩底反射消失（断桩阻断下行波），严禁漏判
  const strongBlock =
    fusedDefects.some((d) => d.samePhase && d.amplitudeRatio >= cfg.class4StrongR) && !toe;
  if (strongBlock && className < 4) {
    className = 4;
    reasons.push('浅部/中部强同相反射且桩底反射消失，按断桩从严判为Ⅳ类');
  }

  // IV 类保底规则二：强同相断桩反射从严判定。
  // 断桩反射 R 很高但可能只在部分锤清晰，分两档：
  //   ① ≥2 锤在相近深度独立检出 R≥class4R 的同相峰 → 直接 IV；
  //   ② 仅 1 锤检出但 R≥class4R·1.2（接近全反射，非噪声所能伪造）→ IV 并标记存疑。
  const strongVotes: { depth: number; r: number }[] = [];
  // 收集门槛用 II 类门限（让弱票也参与聚类计数），最终由 max-R 门限保证 IV 判定可靠性。
  // 关键：剔除桩底附近（>85%L）的反射——自由端桩底本身就是强同相峰，不能当成断桩
  for (const a of analyses) {
    for (const d of a.defects) {
      if (!d.samePhase || d.amplitudeRatio < cfg.class2R) continue;
      if (d.depth >= 0.85 * pile.designLength) continue;
      strongVotes.push({ depth: d.depth, r: d.amplitudeRatio });
    }
  }
  // 按 12%L 容差对强证据做深度聚类（强反射的波速估计波动会放大深度偏差，容差从宽）
  const strongSlots: { depths: number[]; rs: number[] }[] = [];
  for (const sv of strongVotes) {
    const hit = strongSlots.find((s) => Math.abs(median(s.depths) - sv.depth) <= 0.12 * pile.designLength);
    if (hit) {
      hit.depths.push(sv.depth);
      hit.rs.push(sv.r);
    } else {
      strongSlots.push({ depths: [sv.depth], rs: [sv.r] });
    }
  }
  // 多锤断桩：≥2 票且多数票 R 达强证据门限（取中位，防止单锤尖峰误判）；
  // 同时要求至少一票 R≥class4StrongR 作为断桩强度证据
  const multiBlowBreak = strongSlots.find(
    (s) =>
      s.depths.length >= 2 &&
      median(s.rs) >= cfg.class3R &&
      Math.max(...s.rs) >= cfg.class4StrongR,
  );
  // 单锤全反射：R≥0.9 接近理论上限，非噪声所能伪造，即使只有一锤也判 IV
  const fullReflection = strongSlots.some((s) => s.rs.some((r) => r >= 0.9));
  const singleStrongBreak =
    !multiBlowBreak &&
    !fullReflection &&
    accepted.length <= 2 &&
    strongSlots.some((s) => median(s.rs) >= cfg.class4R);
  const breakSlot = multiBlowBreak ?? (fullReflection ? strongSlots.find((s) => s.rs.some((r) => r >= 0.9)) : undefined) ?? (singleStrongBreak ? strongSlots[0] : undefined);
  if (breakSlot && className < 4) {
    const s = breakSlot;
    className = 4;
    reasons.push(
      `深度 ${median(s.depths).toFixed(2)} m 附近检出强同相反射（${s.depths.length} 锤、中位 R=${median(s.rs).toFixed(2)}），按断桩从严判为Ⅳ类`,
    );
  }

  // 判读理由
  if (fusedDefects.length === 0 && className === 1) {
    reasons.push(toe ? '桩底反射清晰，桩身无明显缺陷反射，判Ⅰ类' : '未见明显缺陷反射，但桩底反射不清晰，建议复核');
  }
  for (const d of fusedDefects) {
    const pct = (d.depth / pile.designLength) * 100;
    if (!d.samePhase) {
      reasons.push(`深度 ${d.depth.toFixed(2)} m（${pct.toFixed(1)}% L）反相反射，R=${d.amplitudeRatio.toFixed(2)}，判为扩径`);
    } else {
      const kindText: Record<DefectKind, string> = {
        expansion: '扩径',
        necking: '缩颈',
        mud: '夹泥',
        segregation: '离析',
        break: '断桩',
      };
      reasons.push(
        `深度 ${d.depth.toFixed(2)} m（${pct.toFixed(1)}% L）同相反射，R=${d.amplitudeRatio.toFixed(2)}，阻抗比≈${((1 - d.amplitudeRatio) / (1 + d.amplitudeRatio)).toFixed(2)}，判为${kindText[d.kind]}`,
      );
    }
  }
  if (toe) {
    reasons.push(
      `桩底反射位于 ${(toe.timeSec * 1000).toFixed(2)} ms，反算波速 ${waveSpeed.toFixed(0)} m/s，反射${toe.samePhase ? '同相（自由端/桩底阻抗减小）' : '反相（持力层阻抗增大）'}`,
    );
  }
  if (rejected.length > 0) {
    reasons.push(`已剔除 ${rejected.length} 锤：${rejected.map((r) => `第${r.id}锤(${r.reason})`).join('、')}`);
  }

  // —— 存疑标志 ——
  const ringVotes = accepted.filter((a) => a.headRinging).length;
  const headRinging = ringVotes > accepted.length / 2;
  // IV 由保底规则（而非融合缺陷直接判定）升级时，标记存疑以强制人工复核，
  // 防止完整桩多次反射造成的过判被当成确定结论
  const ivFromSafetyNet = className === 4 && classFromFusion < 4;
  const questionable =
    headRinging ||
    accepted.length <= 1 ||
    !toe ||
    speedDev > 0.15 ||
    ivFromSafetyNet ||
    (accepted.length >= 2 && blowFingerprintSpread(accepted) > 0.32) ||
    fusedDefects.some((d) => Math.abs(d.amplitudeRatio - cfg.class3R) < 0.06 || Math.abs(d.amplitudeRatio - cfg.class4R) < 0.06);

  if (headRinging) reasons.push('多锤检出桩头高频振铃（桩头可能未凿净），浅部判读需人工复核');
  if (accepted.length <= 1) reasons.push('有效锤次不足，结论可靠性低，建议重新检测');

  const measuredLength = toe ? (waveSpeed * toe.timeSec) / 2 : NaN;

  return {
    pileId: pile.id,
    className,
    reasons,
    questionable,
    acceptedBlowIds: accepted.map((a) => a.blowId),
    rejectedBlowIds: rejected,
    blowAnalyses: analyses,
    waveSpeed,
    measuredLength,
    defects: fusedDefects,
    toe,
    headRinging,
    elapsedMs: performance.now() - t0,
  };
}

function blowFingerprintSpread(accepted: BlowAnalysis[]): number {
  const corrs: number[] = [];
  for (let i = 0; i < accepted.length; i++) {
    for (let j = i + 1; j < accepted.length; j++) {
      corrs.push(fingerprintCorr(accepted[i].waveformFingerprint, accepted[j].waveformFingerprint));
    }
  }
  if (corrs.length === 0) return 0;
  return std(corrs.map((c) => 1 - c));
}

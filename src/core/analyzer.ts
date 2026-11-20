// 单锤波形分析（反射波法判读核心）
// 流程：加速度积分 → 基线校正 → 低通 → 入射峰识别 → 桩头高频识别(加速度域) →
//       指数放大 → 桩底反射搜索（期望走时窗口评分 + 周期反射校验）→
//       波速反演 → 缺陷反射扫描（相位/幅值/多次反射）→ 初步分类

import type {
  BlowAnalysis,
  BlowData,
  IntegrityClass,
  PileMeta,
  ReflectionEvent,
} from './types.ts';
import {
  baselineCorrect,
  exponentialGain,
  findIncidentPeak,
  findLocalExtrema,
  integrate,
  movingAverage,
  normalize,
  parabolicInterp,
} from './dsp.ts';
import { referenceWaveSpeed } from './synthesis.ts';
import { detectHeadRinging } from './headRinging.ts';

/** 指数放大增益系数（1/s），补偿土中阻尼；过大会放大远端噪声 */
const GAIN_ALPHA = 20;

export interface AnalyzeContext {
  priorWaveSpeed?: number;
}

export function analyzeBlow(
  blow: BlowData,
  meta: PileMeta,
  ctx: AnalyzeContext = {},
): BlowAnalysis {
  const dt = blow.dt;

  // 1. 加速度 → 速度，基线校正
  const vRaw = integrate(blow.acceleration, dt);
  const inc0 = findIncidentPeak(vRaw);
  const vBase = baselineCorrect(vRaw, inc0.index);

  // 2. 低通平滑（抑制高频噪声），再归一化
  const vSmooth = movingAverage(vBase, 1);
  const incident = findIncidentPeak(vSmooth);
  const t0 = incident.index;
  const sign = incident.sign;
  const velocity = normalize(vSmooth);
  const incidentAmp = Math.abs(velocity[t0]);

  // 3. 先验波速（设计强度等级 + 同批锤结果）
  const refC = referenceWaveSpeed(meta.concreteGrade);
  const priorC = ctx.priorWaveSpeed
    ? 0.5 * ctx.priorWaveSpeed + 0.5 * refC
    : refC;

  // 4. 桩头高频振荡识别（加速度域，先于指数放大）
  const headRinging = detectHeadRinging(blow.acceleration, dt, priorC);

  // 5. 指数放大并重新归一化（用于桩底/深部反射搜索）
  const amplified = normalize(exponentialGain(velocity, t0, GAIN_ALPHA * dt));

  // 6. 双击检测（仅入射脉冲后 2.5ms 内、入射峰附近，避免被深部反射误触发）
  const doubleHit = detectDoubleHit(velocity, t0, dt);

  // 7. 先扫描缺陷反射（用先验波速）
  const prelimEvents = scanDefects({
    amplified,
    velocity,
    t0,
    sign,
    dt,
    meta,
    waveSpeed: priorC,
    toeTravelTime: null,
    maskDepth: headRinging.detected ? headRinging.maskDepth : 0,
    incidentAmp,
  });

  // 8. 断桩判定：强同相反射（β 大）即高度疑似断桩。
  // 强断桩（Z 接近 0）首道反射系数即可达 0.8 以上，不强制要求多次周期；
  // 中等强度但有周期反射的也判断桩。判后桩底反射视为不可达。
  const breakEvent = prelimEvents.find(
    (e) =>
      e.defectType === 'break' &&
      e.phase === 'in' &&
      (Math.abs(e.coefficient) >= 0.6 ||
        (e.multiplicity >= 2 && Math.abs(e.coefficient) >= 0.5)),
  );
  const isBroken = breakEvent !== undefined;

  // 9. 桩底反射搜索（断桩时不搜索，强反射会污染桩底判读）
  const toe = isBroken
    ? null
    : findToeReflection(amplified, velocity, t0, sign, meta, priorC, dt);
  const waveSpeed = toe ? (2 * meta.designLength) / toe.travelTime : null;

  // 10. 用实测波速重新计算事件深度（断桩沿用先验波速）
  const events = isBroken
    ? prelimEvents
    : rebaseEvents(prelimEvents, priorC, waveSpeed ?? priorC);
  if (!isBroken && toe) {
    // 剔除桩底附近误报的缺陷事件：桩底反射的周期回波会在 0.5~1 倍桩底
    // 走时间形成同相假缺陷。对同相事件，凡深度超过桩长 80% 且无独立强反射
    // 特征的，视为桩底回波剔除；反相（扩径）保留到 90%。
    const toeTT = toe.travelTime;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const ratio = e.travelTime / toeTT;
      const nearToe = Math.abs(ratio - 1) < 0.08;
      // 桩底反射的 1/2、2/3 等周期回波会形成同相假缺陷
      const subHarmonic =
        e.phase === 'in' &&
        ((ratio > 0.5 && ratio < 0.68) || (ratio > 0.78 && ratio < 0.95));
      if (nearToe || subHarmonic) events.splice(i, 1);
    }
  }

  if (toe) {
    events.unshift({
      travelTime: toe.travelTime,
      depth: meta.designLength,
      coefficient: toe.amplitude * sign,
      phase: toe.amplitude * sign >= 0 ? 'in' : 'out',
      defectType: 'toe',
      multiplicity: toe.multiplicity,
      confidence: toe.confidence,
    });
  }

  const provisionalClass = classifyBlow(events);

  return {
    blowId: blow.id,
    velocity,
    amplified,
    dt,
    incidentIndex: t0,
    toeTravelTime: toe?.travelTime ?? null,
    toeConfidence: toe?.confidence ?? 0,
    waveSpeed,
    events,
    headRinging,
    doubleHit,
    similarity: 0,
    rejected: false,
    provisionalClass,
  };
}

interface ToeHit {
  travelTime: number;
  amplitude: number;
  multiplicity: number;
  confidence: number;
}

/**
 * 桩底反射搜索（期望走时窗口评分法）
 * 在波速 3000~4700 对应的走时窗口内，对每个候选位置按
 * 「极性符合度 + 局部显著性 + 与期望走时接近度 + 二次反射周期性」综合评分，
 * 避免全局最大峰被缺陷反射或噪声抢占。
 */
function findToeReflection(
  amplified: Float64Array,
  velocity: Float64Array,
  t0: number,
  sign: number,
  meta: PileMeta,
  priorC: number,
  dt: number,
): ToeHit | null {
  const L = meta.designLength;
  const cMin = 3000;
  const cMax = 4700;
  const iMin = t0 + Math.floor((2 * L) / cMax / dt);
  const iMax = Math.min(
    amplified.length - 4,
    t0 + Math.ceil((2 * L) / cMin / dt),
  );
  if (iMax <= iMin + 3) return null;

  const wantPhase = meta.toeCondition === 'socketed' ? -sign : sign;
  const expectedT = (2 * L) / priorC;
  const expectedIdx = t0 + expectedT / dt;

  let bestIdx = -1;
  let bestScore = -Infinity;

  for (let i = iMin; i <= iMax; i++) {
    const v = amplified[i];
    const phaseOk = Math.sign(v) === wantPhase;
    // 嵌岩桩反相为主；摩擦桩必须同相
    const phaseScore = phaseOk
      ? 1
      : meta.toeCondition === 'socketed'
        ? 0.35
        : 0.1;
    if (!phaseOk && meta.toeCondition === 'friction') continue;

    // 局部显著性：相对 ±0.5ms 邻域
    const lo = Math.max(iMin, i - Math.round(0.0005 / dt));
    const hi = Math.min(iMax, i + Math.round(0.0005 / dt));
    let localMax = 1e-12;
    for (let k = lo; k <= hi; k++) localMax = Math.max(localMax, Math.abs(amplified[k]));
    const prominence = Math.abs(v) / localMax;

    // 与期望走时的接近度（高斯型）
    const sigmaT = Math.max(2, Math.round(0.0008 / dt));
    const timeScore = Math.exp(-((i - expectedIdx) ** 2) / (2 * sigmaT * sigmaT));

    // 二次反射周期性
    const period = checkPeriodic(amplified, t0, (i - t0) * dt, wantPhase, dt);

    const score =
      phaseScore * 0.3 +
      prominence * 0.25 +
      timeScore * 0.25 +
      period * 0.2;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestScore < 0.42) return null;

  const interp = parabolicInterp(amplified, bestIdx);
  const travelTime = (interp.index - t0) * dt;
  const period = checkPeriodic(amplified, t0, travelTime, wantPhase, dt);
  const multiplicity = 1 + Math.round(period);
  const rawAmp = sampleInterpolated(velocity, interp.index) * sign;

  return {
    travelTime,
    amplitude: rawAmp,
    multiplicity,
    confidence: Math.min(0.98, 0.3 + bestScore * 0.65),
  };
}

/** 检查 2Δt、3Δt 处的周期反射，返回 0~1 的匹配强度（要求回波超过绝对幅值） */
function checkPeriodic(
  amplified: Float64Array,
  t0: number,
  deltaT: number,
  wantPhase: number,
  dt: number,
): number {
  let match = 0;
  let weight = 0;
  for (const mult of [2, 3]) {
    const idx = t0 + (mult * deltaT) / dt;
    const iLo = Math.floor(idx - 2);
    const iHi = Math.ceil(idx + 2);
    if (iHi >= amplified.length) break;
    let local = 0;
    for (let i = Math.max(0, iLo); i <= iHi; i++) {
      if (Math.sign(amplified[i]) === wantPhase)
        local = Math.max(local, Math.abs(amplified[i]));
    }
    const w = mult === 2 ? 0.7 : 0.3;
    // 回波幅值需超过 0.15 才计为有效周期反射
    match += clamp01((local - 0.1) / 0.2) * w;
    weight += w;
  }
  return weight === 0 ? 0 : match / weight;
}

function sampleInterpolated(x: Float64Array, idx: number): number {
  const i = Math.floor(idx);
  if (i < 0 || i >= x.length - 1)
    return x[Math.max(0, Math.min(x.length - 1, Math.round(idx)))];
  const f = idx - i;
  return x[i] * (1 - f) + x[i + 1] * f;
}

interface ScanArgs {
  amplified: Float64Array;
  velocity: Float64Array;
  t0: number;
  sign: number;
  dt: number;
  meta: PileMeta;
  waveSpeed: number;
  toeTravelTime: number | null;
  maskDepth: number;
  incidentAmp: number;
}

/**
 * 缺陷反射扫描
 * 同相反射（与入射同向）→ 阻抗减小：缩颈/夹泥/断桩
 * 反相反射 → 阻抗增大：扩径
 * 浅部受桩头振荡/入射脉冲拖尾影响，设最小可判深度。
 */
function scanDefects(args: ScanArgs): ReflectionEvent[] {
  const {
    amplified,
    velocity,
    t0,
    sign,
    dt,
    meta,
    waveSpeed,
    toeTravelTime,
    maskDepth,
    incidentAmp,
  } = args;
  const events: ReflectionEvent[] = [];
  // 浅部下限：屏蔽深度、0.8m、桩长 5% 三者取大
  const minDepth = Math.max(maskDepth, 0.8, meta.designLength * 0.05);
  const minIdx = t0 + Math.ceil((2 * minDepth) / waveSpeed / dt);
  const maxIdx = toeTravelTime
    ? t0 + Math.floor(toeTravelTime / dt) - 2
    : Math.min(
        amplified.length - 3,
        t0 + Math.ceil((2 * meta.designLength * 0.92) / waveSpeed / dt),
      );
  if (maxIdx <= minIdx) return events;

  const extrema = findLocalExtrema(
    amplified,
    Math.max(3, Math.round(0.0008 / dt)),
  );

  // 噪声底：入射前安静段 RMS（放大后），缺陷峰必须显著高于噪声底
  const noiseFloor = rms(amplified.subarray(0, Math.max(4, t0 - 2)));
  const snrGate = Math.max(0.13, noiseFloor * 1.7);

  for (const e of extrema) {
    if (e.index < minIdx || e.index > maxIdx) continue;
    const interp = parabolicInterp(amplified, e.index);
    const ampNorm = Math.abs(interp.value);
    // 双重门控：绝对幅值 + 相对噪声底的信噪比
    if (ampNorm < 0.13 || ampNorm < snrGate) continue;
    const travelTime = (interp.index - t0) * dt;
    const depth = (waveSpeed * travelTime) / 2;
    if (depth < minDepth || depth >= meta.designLength * 0.97) continue;

    const phase: 'in' | 'out' = Math.sign(e.value) === sign ? 'in' : 'out';
    // 未放大波形上估计反射系数 β ≈ Vr/Vi
    const rawV = sampleInterpolated(velocity, interp.index);
    const coefficient = rawV / Math.max(incidentAmp, 1e-12);
    const absBeta = Math.abs(coefficient);
    const period = checkPeriodic(
      amplified,
      t0,
      travelTime,
      sign * (phase === 'in' ? 1 : -1),
      dt,
    );

    let defectType: ReflectionEvent['defectType'];
    let confidence: number;
    if (phase === 'out') {
      defectType = 'bulge';
      confidence = clamp01(0.45 + ampNorm * 0.8);
    } else {
      // 同相：按幅值与周期性区分严重程度
      if (absBeta >= 0.45 || (ampNorm >= 0.45 && period >= 0.5)) {
        defectType = 'break';
        confidence = clamp01(0.5 + absBeta * 0.6 + period * 0.3);
      } else if (period >= 0.4 || absBeta >= 0.22) {
        defectType = 'segregation';
        confidence = clamp01(0.4 + period * 0.4 + absBeta);
      } else {
        defectType = 'neck';
        confidence = clamp01(0.35 + ampNorm * 0.9);
      }
    }

    events.push({
      travelTime,
      depth,
      coefficient,
      phase,
      defectType,
      multiplicity: 1 + Math.round(period),
      confidence,
    });
  }

  return suppressHarmonics(mergeCloseEvents(events));
}

/**
 * 谐波抑制：断桩/夹泥的强反射会在 2Δt、3Δt… 产生周期回波，
 * 这些回波对应同一缺陷而非新缺陷。保留最浅的强同相事件，
 * 剔除其走时近似整数倍的后续同类型事件，同时累加 multiplicity。
 */
function suppressHarmonics(events: ReflectionEvent[]): ReflectionEvent[] {
  const sorted = [...events].sort((a, b) => a.depth - b.depth);
  const primaries = sorted.filter(
    (e) =>
      (e.defectType === 'break' || e.defectType === 'segregation') &&
      e.phase === 'in' &&
      e.multiplicity >= 2,
  );
  if (primaries.length === 0) return sorted;

  const keep: ReflectionEvent[] = [];
  for (const e of sorted) {
    let isHarmonic = false;
    for (const p of primaries) {
      if (p === e || e.depth <= p.depth) continue;
      const ratio = e.travelTime / p.travelTime;
      const nearest = Math.round(ratio);
      // 走时接近主反射的 2/3/4 倍，且同为同相 → 周期回波
      if (
        nearest >= 2 &&
        nearest <= 4 &&
        Math.abs(ratio - nearest) < 0.12 &&
        e.phase === 'in'
      ) {
        isHarmonic = true;
        p.multiplicity = Math.max(p.multiplicity, nearest);
        break;
      }
    }
    if (!isHarmonic) keep.push(e);
  }
  return keep;
}

/** 合并位置过近的重复事件（同一反射的相邻极值） */
function mergeCloseEvents(events: ReflectionEvent[]): ReflectionEvent[] {
  const sorted = [...events].sort((a, b) => a.depth - b.depth);
  const out: ReflectionEvent[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.depth - e.depth) < Math.max(0.6, e.depth * 0.08)) {
      if (e.confidence > last.confidence) out[out.length - 1] = e;
    } else {
      out.push(e);
    }
  }
  return out;
}

/**
 * 双击检测：第二个锤击脉冲紧跟第一个（间隔通常 0.8~2ms）。
 * 要求第二峰幅度 ≥70% 首峰、两峰间有明显谷值（≤首峰 40%）、
 * 且第二峰后有完整回落，以区分真正的二次锤击与断桩周期反射/脉冲波瓣。
 */
function detectDoubleHit(velocity: Float64Array, t0: number, dt: number): boolean {
  const winStart = t0 + Math.round(0.0005 / dt);
  const winEnd = Math.min(
    velocity.length - 2,
    t0 + Math.round(0.002 / dt),
  );
  const peak = Math.abs(velocity[t0]);
  const peakSign = Math.sign(velocity[t0]);
  for (let i = winStart; i < winEnd; i++) {
    if (
      Math.sign(velocity[i]) === peakSign &&
      Math.abs(velocity[i]) >= 0.7 * peak &&
      Math.abs(velocity[i]) >= Math.abs(velocity[i - 1]) &&
      Math.abs(velocity[i]) >= Math.abs(velocity[i + 1])
    ) {
      // 两峰之间需有明显谷值
      let valley = Infinity;
      for (let k = t0 + 1; k < i; k++)
        valley = Math.min(valley, Math.abs(velocity[k]));
      if (valley > 0.4 * peak) continue;
      // 第二峰后需回落到其一半以下（完整脉冲）
      let fell = false;
      const tail = Math.min(velocity.length - 1, i + Math.round(0.001 / dt));
      for (let k = i + 1; k < tail; k++) {
        if (Math.abs(velocity[k]) < 0.5 * Math.abs(velocity[i])) {
          fell = true;
          break;
        }
      }
      if (fell) return true;
    }
  }
  return false;
}

/** 单锤初步分类 */
function classifyBlow(events: ReflectionEvent[]): IntegrityClass {
  const defects = events.filter((e) => e.defectType !== 'toe');
  const hasBreak = defects.some((e) => e.defectType === 'break');
  const hasSeg = defects.some((e) => e.defectType === 'segregation');
  const strongNeck = defects.some(
    (e) => e.defectType === 'neck' && Math.abs(e.coefficient) >= 0.3,
  );

  if (hasBreak) return 'IV';
  if (hasSeg || strongNeck) return 'III';
  if (defects.length > 0) return 'II';
  return 'I';
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** 实测波速确定后，按走时不变重算各事件深度 */
function rebaseEvents(
  events: ReflectionEvent[],
  oldSpeed: number,
  newSpeed: number,
): ReflectionEvent[] {
  if (Math.abs(newSpeed - oldSpeed) / oldSpeed < 0.005) return events;
  return events.map((e) => ({
    ...e,
    depth: (newSpeed * e.travelTime) / 2,
  }));
}

function rms(x: Float64Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

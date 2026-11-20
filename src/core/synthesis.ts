// 一维波动方程波形合成（特征线差分格点法）
// 物理模型：等截面弹性杆 ρ·A·∂v/∂t = ∂(Aσ)/∂x，σ = ρc·∂u/∂t 的波动形式
// 特征线关系（压缩应力为正、质点向下速度为正）：
//   下行波: v + σ/Z = const   上行波: v - σ/Z = const
// 阻抗 Z = ρcA；缩颈/夹泥/断桩 => Z 减小，速度反射与入射同相；
// 扩径 => Z 增大，速度反射反相。桩头自由面 R_v=+1，嵌岩桩底可呈反相反射。

import type {
  BlowData,
  DefectSpec,
  PileMeta,
  SynthesisOptions,
} from './types.ts';
import { mulberry32 } from './dsp.ts';

/** 混凝土强度等级 -> 参考纵波波速 m/s（JGJ 106 常见区间中值） */
const GRADE_WAVE_SPEED: Record<string, number> = {
  C20: 3200,
  C25: 3400,
  C30: 3600,
  C35: 3800,
  C40: 4000,
  C45: 4150,
  C50: 4300,
  C55: 4400,
  C60: 4500,
};

export function referenceWaveSpeed(concreteGrade: string): number {
  return GRADE_WAVE_SPEED[concreteGrade] ?? 3800;
}

/** 混凝土密度 kg/m³ */
const CONCRETE_DENSITY = 2400;

interface SynthesisConfig {
  c: number;
  dt: number;
  nSeg: number;
  nNodes: number;
  dx: number;
  nTime: number;
  area: Float64Array;
  impedance: Float64Array;
  /** 速度型阻尼系数（材料内阻尼 + 桩侧土阻力的综合吸收，每时间步） */
  damping: number;
  /** 桩底速度反射系数：摩擦桩接近 +1，嵌岩桩取 0~0.4 或负值 */
  toeReflection: number;
}

function buildConfig(meta: PileMeta, opts: SynthesisOptions): SynthesisConfig {
  const c = opts.trueWaveSpeed ?? referenceWaveSpeed(meta.concreteGrade);
  const sampleRate = opts.sampleRate ?? 12500;
  const dt = 1 / sampleRate;
  // CFL=1：每时间步波恰好传播一个格点
  const dx = c * dt;
  const nSeg = Math.max(16, Math.ceil(meta.designLength / dx));
  const nNodes = nSeg + 1;
  const baseArea = Math.PI * (meta.diameter / 2) ** 2;
  const area = new Float64Array(nNodes).fill(baseArea);
  const impedance = new Float64Array(nNodes);

  // 按缺陷修改截面积/材料阻抗（夹泥通过降低等效波阻抗实现，不改几何）
  // 阻抗突变在特征线格式中会失稳，缺陷边界做线性渐变过渡；
  // 断桩是近突变界面，用更窄过渡（3 格点）保留强反射，其余缺陷用较宽过渡。
  const baseZ = CONCRETE_DENSITY * c * baseArea;
  const wideRamp = Math.max(5, Math.round(nSeg * 0.02));
  for (const d of opts.defects ?? []) {
    const ramp = d.type === 'break' ? 3 : wideRamp;
    const jCenter = Math.round((d.depth / meta.designLength) * nSeg);
    const jLen = Math.max(3, Math.round((d.length / meta.designLength) * nSeg));
    const jStart = Math.max(1, jCenter - ramp);
    const jPlatEnd = Math.min(nSeg, jCenter + jLen);
    const jEnd = Math.min(nSeg, jPlatEnd + ramp);
    // 断桩阻抗比钳制下限 0.12，保证数值稳定（R≈-0.79 仍属极强反射，可判 IV 类）
    const ratio =
      d.type === 'break' ? Math.max(0.12, d.impedanceRatio) : d.impedanceRatio;
    for (let j = jStart; j <= jEnd; j++) {
      let w: number;
      if (j < jCenter) {
        w = (j - jStart) / ramp; // 0 -> 1 渐入
      } else if (j <= jPlatEnd) {
        w = 1;
      } else {
        w = Math.max(0, 1 - (j - jPlatEnd) / ramp); // 1 -> 0 渐出
      }
      const localRatio = 1 + (ratio - 1) * w;
      if (d.type === 'segregation' || d.type === 'break') {
        // 夹泥/断桩：等效阻抗（ρcA）整体折减
        impedance[j] = baseZ * localRatio;
      } else {
        // 缩颈/扩径：面积变化
        area[j] = baseArea * localRatio;
        impedance[j] = baseZ * localRatio;
      }
    }
  }
  for (let j = 0; j < nNodes; j++) {
    if (impedance[j] === 0) impedance[j] = baseZ;
  }

  // 记录时长覆盖至少 3.5 个桩底往返（2L/c 为一个往返），保证多次反射可辨
  const duration =
    opts.duration ?? Math.max(0.025, (3.5 * 2 * meta.designLength) / c);
  const nTime = Math.ceil(duration / dt);

  // 完整桩底反射系数：摩擦桩 +0.85（土约束，非理想自由），嵌岩桩 -0.35
  const toeReflection = meta.toeCondition === 'socketed' ? -0.35 : 0.85;

  return {
    c,
    dt,
    nSeg,
    nNodes,
    dx,
    nTime,
    area,
    impedance,
    damping: 0.004,
    toeReflection,
  };
}

/** 锤击入射脉冲：汉宁窗调制的 1.5 周正弦，脉宽约 0.8~1.5ms */
function hammerPulse(t: number, pulseWidth: number, sign: number): number {
  if (t < 0 || t > pulseWidth) return 0;
  const phase = (1.5 * 2 * Math.PI * t) / pulseWidth;
  const window = 0.5 * (1 - Math.cos((2 * Math.PI * t) / pulseWidth));
  return sign * Math.sin(phase) * window;
}

export interface SynthesizedPile {
  blows: BlowData[];
  groundTruth: { waveSpeed: number; defects: DefectSpec[] };
  dt: number;
}

/** 为一根桩合成 3~5 锤加速度波形 */
export function synthesizePile(
  meta: PileMeta,
  opts: SynthesisOptions,
): SynthesizedPile {
  const cfg = buildConfig(meta, opts);
  const rng = mulberry32(opts.seed);
  const blowCount = opts.blowCount ?? 4;
  const noiseLevel = opts.noiseLevel ?? 0.015;
  const defects = opts.defects ?? [];
  const blows: BlowData[] = [];

  for (let b = 0; b < blowCount; b++) {
    const seedExtra = b * 7919;
    const blowRng = mulberry32(opts.seed + seedExtra + 13);
    // 每锤轻微差异：脉宽、幅度、触发时刻抖动
    const pulseWidth = (0.9 + blowRng() * 0.5) * 1e-3;
    const amp = 0.9 + blowRng() * 0.2;
    // 工程惯例：入射速度首峰向下（负），自由端反射同相亦为负
    const sign = -1;
    const startSample = 8 + Math.floor(blowRng() * 4);
    const doubleHit = opts.doubleHit && b === blowCount - 1;
    const secondDelay = doubleHit ? (1.6 + blowRng() * 0.8) * 1e-3 : 0;
    const secondAmp = doubleHit ? 0.55 + blowRng() * 0.2 : 0;

    const vTop = runWaveSimulation(cfg, (t) => {
      const p1 = hammerPulse(t, pulseWidth, sign) * amp;
      const p2 =
        secondDelay > 0
          ? hammerPulse(t - secondDelay, pulseWidth, sign) * secondAmp
          : 0;
      return p1 + p2;
    }, startSample);

    // 由桩顶速度差分得到加速度（仪器实际采集量）
    const acc = new Float64Array(vTop.length);
    for (let i = 0; i < vTop.length; i++) {
      if (i === 0) acc[i] = (vTop[1] - vTop[0]) / cfg.dt;
      else if (i === vTop.length - 1)
        acc[i] = (vTop[i] - vTop[i - 1]) / cfg.dt;
      else acc[i] = (vTop[i + 1] - vTop[i - 1]) / (2 * cfg.dt);
    }

    // 桩头浮浆/未凿干净：锚定真实入射峰，在加速度信号上叠加高频衰减振荡
    // （2.2~3kHz、持续约 5~8 周；真实仪器中浮浆在加速度通道最明显，
    // 振荡在入射主峰之后仍持续，是与正常锤击脉冲的关键区别）
    if (opts.headRinging) {
      const ringFreq = 2300 + blowRng() * 700;
      const ringDecay = 450 + blowRng() * 200; // 1/s
      const basePeak = maxAbs(acc);
      const ringAmp = (0.5 + blowRng() * 0.15) * basePeak;
      const phase0 = blowRng() * Math.PI;
      // 锚定实际入射峰（仅在记录前 30% 内查找，避免桩底反射比入射峰大时选错），
      // 振荡从峰前 0.3ms 起振
      const vForPeak = integrateLocal(acc, cfg.dt);
      const searchEnd = Math.max(8, Math.floor(acc.length * 0.3));
      const peakIdx = argMaxAbs(vForPeak.subarray(0, searchEnd));
      const ringStart = Math.max(0, peakIdx - Math.round(0.0003 / cfg.dt));
      for (let i = ringStart; i < acc.length; i++) {
        const t = (i - ringStart) * cfg.dt;
        acc[i] +=
          ringAmp *
          Math.sin(2 * Math.PI * ringFreq * t + phase0) *
          Math.exp(-ringDecay * t);
      }
    }

    // 加测量噪声与缓慢零漂
    const peak = maxAbs(acc);
    const driftA = (blowRng() - 0.5) * 0.02 * peak;
    const driftB = (blowRng() - 0.5) * 0.03 * peak;
    for (let i = 0; i < acc.length; i++) {
      const n = (blowRng() + blowRng() + blowRng() - 1.5) * noiseLevel * peak;
      const tn = i / acc.length;
      acc[i] += n + driftA * tn + driftB * tn * tn;
    }

    blows.push({
      id: `${meta.id}-B${b + 1}`,
      acceleration: acc,
      dt: cfg.dt,
    });
    void rng;
  }

  return {
    blows,
    dt: cfg.dt,
    groundTruth: { waveSpeed: cfg.c, defects },
  };
}

function maxAbs(x: Float64Array): number {
  let m = 0;
  for (const v of x) {
    const a = Math.abs(v);
    if (a > m) m = a;
  }
  return m;
}

function argMaxAbs(x: Float64Array): number {
  let idx = 0;
  let m = -1;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > m) {
      m = a;
      idx = i;
    }
  }
  return idx;
}

function integrateLocal(acc: Float64Array, dt: number): Float64Array {
  const v = new Float64Array(acc.length);
  let s = 0;
  for (let i = 1; i < acc.length; i++) {
    s += 0.5 * (acc[i - 1] + acc[i]) * dt;
    v[i] = s;
  }
  return v;
}

/**
 * 特征线格点求解
 * @param cfg 格点配置
 * @param topVelocityInput 给定激励时间 t(s) 下的桩顶入射速度（自由面反射由边界自然形成）
 * @param startSample 脉冲起始采样点
 */
function runWaveSimulation(
  cfg: SynthesisConfig,
  topVelocityInput: (t: number) => number,
  startSample: number,
): Float64Array {
  const { nNodes, nSeg, nTime, dt, impedance: Z, damping, toeReflection } = cfg;
  let v = new Float64Array(nNodes);
  let s = new Float64Array(nNodes); // 应力 σ（压缩为正）
  const vTopHist = new Float64Array(nTime);

  for (let n = 0; n < nTime; n++) {
    const t = (n - startSample) * dt;
    const vNew = new Float64Array(nNodes);
    const sNew = new Float64Array(nNodes);

    // 内部节点 j=1..N-1：特征线外推 + 阻抗变化界面
    for (let j = 1; j < nSeg; j++) {
      // 下行特征线（来自 j-1）：v + σ/Z_j
      const down = v[j - 1] + s[j - 1] / Z[j];
      // 上行特征线（来自 j+1）：v - σ/Z_j
      const up = v[j + 1] - s[j + 1] / Z[j];
      let vj = 0.5 * (down + up);
      let sj = 0.5 * Z[j] * (down - up);
      // 综合阻尼（材料吸收 + 桩侧阻力）
      vj *= 1 - damping;
      sj *= 1 - damping * 0.5;
      vNew[j] = vj;
      sNew[j] = sj;
    }

    // 桩顶 j=0
    // 激励期：速度边界 v0=input，应力由上行特征线 up=v1-σ1/Z1 与 v0=(down+up)/2、
    //         σ0=Z0(down-up)/2 联立得 σ0=Z0(input-up)
    // 激励后：自由面 σ0=0，down=up，v0=up（Rv=+1 同相反射）
    const input = topVelocityInput(t);
    const up0 = v[1] - s[1] / Z[1];
    if (input !== 0) {
      vNew[0] = input;
      sNew[0] = Z[0] * (input - up0);
    } else {
      vNew[0] = up0;
      sNew[0] = 0;
    }

    // 桩底 j=N：Rv 为速度反射系数（自由端 +1 同相，固定端 -1 反相）
    // 入射下行特征量 dN=down，反射上行特征量 up=Rv·down
    const downN = v[nSeg - 1] + s[nSeg - 1] / Z[nSeg];
    const upN = toeReflection * downN;
    vNew[nSeg] = 0.5 * (downN + upN);
    sNew[nSeg] = 0.5 * Z[nSeg] * (downN - upN);

    v = vNew;
    s = sNew;
    vTopHist[n] = v[0];
  }
  return vTopHist;
}

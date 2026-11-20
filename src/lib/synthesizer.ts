/**
 * 一维应力波方程 FDTD 合成器
 *
 * 控制方程（杆的纵向振动，z 轴向下，压应力为正，v 向下为正）：
 *   ρ ∂v/∂t = ∂s/∂z - η_s v        （动量方程，η_s 为桩侧土阻尼）
 *   ∂s/∂t   = M(z) ∂v/∂z，M = ρc²   （本构）
 *
 * 交错网格：v 节点在整数格点，应力 s 节点在半格点。
 * 顶部：锤击压力 p(t) 作为边界应力；底部：自由端或辐射阻尼（持力层）。
 * 缺陷：通过截面 A(z) 与波速 c(z) 的空间变化改变波阻抗 Z=ρcA，
 *       缩颈/扩径/夹泥/离析/断桩均由此统一描述。
 *
 * 反射相位（与 JGJ 106 判读规则一致）：
 *   Z 减小（缩颈、夹泥、离析、断桩、自由桩底）→ 速度反射与入射同相
 *   Z 增大（扩径、硬持力层桩底）              → 反相
 */
import { gaussian, mulberry32 } from './dsp';
import type { DefectKind, IntegrityClass, SyntheticPile, SyntheticTruth } from '../types';

export const OUTPUT_FS = 25000; // 输出采样率 Hz
const OUTPUT_N = 2048; // 82 ms，覆盖最长桩 2L/c 有余

/** 混凝土强度等级 → 波速经验范围 (m/s) */
const GRADE_SPEED: Record<string, [number, number]> = {
  C20: [3000, 3500],
  C25: [3200, 3700],
  C30: [3400, 3900],
  C35: [3550, 4050],
  C40: [3700, 4200],
};

export const CONCRETE_GRADES = Object.keys(GRADE_SPEED);

export function designSpeedForGrade(grade: string, rand: () => number): number {
  const range = GRADE_SPEED[grade] ?? GRADE_SPEED.C30;
  return range[0] + rand() * (range[1] - range[0]);
}

interface FdtdDefect {
  start: number; // m
  length: number;
  areaRatio: number; // 缺陷段 A/A0
  speedRatio: number; // 缺陷段 c/c0
  kind: DefectKind;
}

interface FdtdOptions {
  length: number;
  waveSpeed: number;
  diameter: number;
  defects: FdtdDefect[];
  toeCondition: 'free' | 'soil';
  toeDashpot: number; // 持力层辐射阻尼系数 k，0=自由端，1=完全吸收
  shaftDamping: number; // 桩侧土辐射阻力系数（无量纲，乘 ρc 得到单位面积阻尼）
  kelvinTau: number; // 开尔文-沃伊特黏滞松弛时间 s（混凝土内耗，只作用于应变率）
  hammerTau: number; // 锤击脉冲宽度 s
  hammerAmplitude: number;
  ringFreq: number; // 桩头振铃频率 Hz，0 表示无
  ringDecay: number; // 振铃衰减时间 s
  ringAmp: number;
  doubleHitAt: number; // 二次锤击时刻 s，0 表示无
  doubleHitAmp: number;
  noiseLevel: number; // 加速度噪声相对 RMS
  rand: () => number;
  lowFreqDrift: number;
}

interface FdtdResult {
  accel: Float64Array;
  velocity: Float64Array;
  /** 未叠加噪声的 FDTD 原始桩顶速度（调试用） */
  cleanVelocity: Float64Array;
  /** 调试：实际阻抗面积场与网格参数 */
  debug?: { area: Float64Array; dz: number; nSub: number; Nz: number };
}

function runFdtd(opts: FdtdOptions): FdtdResult {
  const { length, waveSpeed: c0 } = opts;
  const rho = 2400; // 混凝土密度 kg/m³

  // 固定空间网格 0.1 m：对 0.5~1.2ms 锤脉冲（主频 0.4~1kHz，波长 3~9m）
  // 每个波长 30~90 个网格，分辨率充裕；所有桩长共用一套离散参数，行为可预测
  const dz = 0.1;
  const nCells = Math.ceil(length / dz);
  const Nz = nCells + 1;

  // 时间步：严格 CFL，dt = 0.8·dz/c_max；输出采样固定 25kHz，内部子步进
  let cMax = c0;
  for (const d of opts.defects) cMax = Math.max(cMax, c0 * d.speedRatio);
  const dtOut = 1 / OUTPUT_FS;
  const dtCfl = 0.8 * dz / cMax;
  const nSub = Math.max(1, Math.ceil(dtOut / dtCfl));
  const dt = dtOut / nSub;

  // 材料参数场（全部使用物理深度坐标）
  const area = new Float64Array(Nz);
  const M = new Float64Array(Nz); // M_i 定义在应力节点 i（v_i 与 v_{i+1} 之间）
  const A0 = Math.PI * (opts.diameter / 2) ** 2;
  // 过渡带宽度：约 2 个网格，保证短缺陷中心也能达到目标阻抗比
  const transition = Math.max(0.2, dz * 2);
  for (let i = 0; i < Nz; i++) {
    const z = i * dz; // 物理深度 m
    let ar = 1;
    let sr = 1;
    for (const d of opts.defects) {
      const dEnd = d.start + d.length;
      let weight = 0;
      if (z <= d.start - transition || z >= dEnd + transition) {
        weight = 0;
      } else if (z >= d.start && z <= dEnd) {
        weight = 1;
      } else if (z < d.start) {
        weight = 0.5 * (1 - Math.cos((Math.PI * (z - (d.start - transition))) / transition));
      } else {
        weight = 0.5 * (1 + Math.cos((Math.PI * (z - dEnd)) / transition));
      }
      // 多缺陷叠加时按权重合成（取影响最强者）
      if (weight > 0) {
        ar = 1 + (d.areaRatio - 1) * weight;
        sr = 1 + (d.speedRatio - 1) * weight;
      }
    }
    area[i] = A0 * ar;
    M[i] = rho * (c0 * sr) ** 2;
  }

  const v = new Float64Array(Nz);
  // 应力节点 i 位于 v_i 与 v_{i+1} 之间，共 Nz-1 个
  const s = new Float64Array(Nz - 1);
  const areaAtStress = new Float64Array(Nz - 1);
  const Mstress = new Float64Array(Nz - 1);
  for (let i = 0; i < Nz - 1; i++) {
    areaAtStress[i] = Math.sqrt(area[i] * area[i + 1]);
    Mstress[i] = 0.5 * (M[i] + M[i + 1]);
  }
  // 界面力 F_i = A_i^s · s_i；直接对力做有限体积演化，变截面阻抗自然正确
  const force = new Float64Array(Nz - 1);
  // v 节点质量（内部整控制体 ρ A dz，两端半控制体 ρ A dz/2）
  const mass = new Float64Array(Nz);
  mass[0] = rho * area[0] * dz * 0.5;
  for (let i = 1; i < Nz - 1; i++) mass[i] = rho * area[i] * dz;
  mass[Nz - 1] = rho * area[Nz - 1] * dz * 0.5;

  const accel = new Float64Array(OUTPUT_N);
  const velocity = new Float64Array(OUTPUT_N);
  // 桩侧单位面积辐射阻力 β·ρc（β 很小，仅提供随传播距离的温和衰减）
  const sideDampPerArea = opts.shaftDamping * rho * c0;
  const strainRate = new Float64Array(Nz - 1);

  const hammer = (t: number): number => {
    let p = 0;
    if (t >= 0 && t <= opts.hammerTau) {
      p = opts.hammerAmplitude * Math.sin((Math.PI * t) / opts.hammerTau);
    }
    if (opts.doubleHitAt > 0 && t >= opts.doubleHitAt && t <= opts.doubleHitAt + opts.hammerTau) {
      const tt = t - opts.doubleHitAt;
      p += opts.doubleHitAmp * Math.sin((Math.PI * tt) / opts.hammerTau);
    }
    return p;
  };

  let v0Prev = 0;
  let outIdx = 0;
  let t = 0;
  for (let n = 0; outIdx < OUTPUT_N; n++) {
    for (let sub = 0; sub < nSub && outIdx < OUTPUT_N; sub++) {
      t += dt;
      const pTop = hammer(t);

      // —— 有限体积速度-应力格式（v 向下为正，压应力为正） ——
      // 动量：m_i dv_i = 界面力差·dt + 边界力·dt - 桩侧阻力·dt
      // 顶面外力（锤击压力，向下）= pTop·A0
      const sideForceCoef = sideDampPerArea; // 单位面积阻力系数，乘面积与 v
      v[0] +=
        (dt * (area[0] * pTop - force[0]) - dt * sideForceCoef * area[0] * v[0]) / mass[0];
      for (let i = 1; i < Nz - 1; i++) {
        v[i] +=
          (dt * (force[i - 1] - force[i]) - dt * sideForceCoef * area[i] * dz * v[i]) /
          mass[i];
      }
      // 底面：自由端 ghost 力=0；持力层辐射阻尼抵抗运动 F_ghost = -k ρc v·A
      const fGhost =
        opts.toeCondition === 'free'
          ? 0
          : -opts.toeDashpot * rho * c0 * v[Nz - 1] * area[Nz - 1];
      v[Nz - 1] +=
        (dt * (force[Nz - 2] - fGhost) -
          dt * sideForceCoef * area[Nz - 1] * v[Nz - 1]) /
        mass[Nz - 1];

      // 界面力演化：dF = A^s·ds = A^s·M·∂v/∂z·dt，与动量符号配套取负
      const relax = opts.kelvinTau >= 1e6 ? 1 : Math.exp(-dt / opts.kelvinTau);
      for (let i = 0; i < Nz - 1; i++) {
        strainRate[i] = (v[i + 1] - v[i]) / dz;
        force[i] = force[i] * relax - dt * areaAtStress[i] * Mstress[i] * strainRate[i];
        s[i] = force[i] / areaAtStress[i];
      }
    }

    // 输出桩顶质点速度与加速度
    velocity[outIdx] = v[0];
    accel[outIdx] = (v[0] - v0Prev) / dtOut;
    v0Prev = v[0];
    outIdx++;
  }

  // —— 实测效应叠加（传感器与现场噪声） ——
  const cleanVelocity = new Float64Array(velocity);
  const rand = opts.rand;
  const velRms = Math.sqrt(velocity.reduce((a, b) => a + b * b, 0) / velocity.length);
  const noiseRms = opts.noiseLevel * velRms;
  for (let i = 0; i < OUTPUT_N; i++) {
    const tt = i / OUTPUT_FS;
    let noise = gaussian(rand) * noiseRms;
    // 低频基线漂移（传感器/手持晃动）
    noise += opts.lowFreqDrift * velRms * Math.sin(2 * Math.PI * (6 + 2 * rand()) * tt + rand() * 6);
    // 桩头未凿净：附着松散颗粒引起的高频衰减振荡
    if (opts.ringFreq > 0) {
      noise +=
        opts.ringAmp *
        velRms *
        Math.exp(-tt / opts.ringDecay) *
        Math.sin(2 * Math.PI * opts.ringFreq * tt + rand() * 0.5);
    }
    // 噪声同时以加速度形式叠加（积分后成为速度噪声）
    accel[i] += noise * OUTPUT_FS;
    velocity[i] += noise;
  }

  return { accel, velocity, cleanVelocity, debug: { area, dz, nSub, Nz } };
}

/** 调试/教学用：用受控参数跑单根桩的单锤 FDTD，返回未加噪的干净波形 */
export function runControlledFdtd(params: {
  length: number;
  waveSpeed: number;
  diameter?: number;
  defects?: { depth: number; length: number; areaRatio: number; speedRatio: number; kind: DefectKind }[];
  toeCondition?: 'free' | 'soil';
  toeDashpot?: number;
  hammerTau?: number;
  shaftDamping?: number;
  relaxationTau?: number;
}): FdtdResult {
  return runFdtd({
    length: params.length,
    waveSpeed: params.waveSpeed,
    diameter: params.diameter ?? 0.8,
    defects: (params.defects ?? []).map((d) => ({
      start: d.depth,
      length: d.length,
      areaRatio: d.areaRatio,
      speedRatio: d.speedRatio,
      kind: d.kind,
    })),
    toeCondition: params.toeCondition ?? 'free',
    toeDashpot: params.toeDashpot ?? 0,
    shaftDamping: params.shaftDamping ?? 0.015,
    kelvinTau: params.relaxationTau ?? 0.04,
    hammerTau: params.hammerTau ?? 0.0008,
    hammerAmplitude: 1e6,
    ringFreq: 0,
    ringDecay: 0,
    ringAmp: 0,
    doubleHitAt: 0,
    doubleHitAmp: 0,
    noiseLevel: 0,
    lowFreqDrift: 0,
    rand: mulberry32(1),
  });
}

/** 缺陷参数模板：由类别与随机数生成符合工程常识的缺陷 */
function makeDefect(
  kind: DefectKind,
  depth: number,
  rand: () => number,
): FdtdDefect {
  const base = { start: depth, length: 0.3 + rand() * 0.5, kind };
  switch (kind) {
    case 'necking':
      return { ...base, areaRatio: 0.62 + rand() * 0.2, speedRatio: 0.95 + rand() * 0.05 };
    case 'expansion':
      return { ...base, areaRatio: 1.18 + rand() * 0.25, speedRatio: 1 };
    case 'mud':
      return { ...base, areaRatio: 0.8 + rand() * 0.12, speedRatio: 0.55 + rand() * 0.18 };
    case 'segregation':
      return { ...base, areaRatio: 0.85 + rand() * 0.1, speedRatio: 0.6 + rand() * 0.2 };
    case 'break':
      return { ...base, length: 0.15 + rand() * 0.2, areaRatio: 0.35 + rand() * 0.15, speedRatio: 0.18 + rand() * 0.15 };
  }
}

/** 由缺陷配置决定完整性类别（与分析端同一套判定规则，保证真值自洽） */
export function truthClassFromDefects(
  defects: { impedanceRatio: number; kind: DefectKind }[],
): IntegrityClass {
  let worst: IntegrityClass = 1;
  for (const d of defects) {
    const r = d.impedanceRatio;
    let cls: IntegrityClass;
    if (d.kind === 'break' || r < 0.25) cls = 4;
    else if (r < 0.5) cls = 3;
    else if (r < 0.8) cls = 2;
    else cls = 1;
    if (cls > worst) worst = cls;
  }
  return worst;
}

export interface SynthesisBuildOptions {
  count: number;
  seed: number;
  classMix?: Partial<Record<IntegrityClass, number>>;
  badBlowRate?: number;
  headRingingRate?: number;
}

/**
 * 合成一个工地的桩与波形。
 * 每根桩 3~5 锤，坏锤（二次锤击/大噪声/触发偏移）与桩头振铃按概率注入。
 */
export function synthesizeSite(options: SynthesisBuildOptions): SyntheticPile[] {
  const rand = mulberry32(options.seed);
  const mix: Record<IntegrityClass, number> = {
    1: options.classMix?.[1] ?? 0.55,
    2: options.classMix?.[2] ?? 0.25,
    3: options.classMix?.[3] ?? 0.13,
    4: options.classMix?.[4] ?? 0.07,
  };
  const mixSum = mix[1] + mix[2] + mix[3] + mix[4];
  const badBlowRate = options.badBlowRate ?? 0.18;
  const ringRate = options.headRingingRate ?? 0.2;

  // 平面排布：矩形网格，带轻微随机错位，模拟桩位平面图
  const cols = Math.ceil(Math.sqrt(options.count * 1.4));
  const spacing = 3; // m，桩间距示意

  const piles: SyntheticPile[] = [];
  for (let p = 0; p < options.count; p++) {
    const col = p % cols;
    const row = Math.floor(p / cols);
    const id = `ZH-${String(p + 1).padStart(3, '0')}`;
    const grade = CONCRETE_GRADES[Math.floor(rand() * CONCRETE_GRADES.length)];
    const designLength = 12 + Math.round(rand() * 28); // 12~40 m
    const diameter = [0.6, 0.8, 1.0, 1.2][Math.floor(rand() * 4)];
    const c = designSpeedForGrade(grade, rand);

    // 按 mix 抽取本桩类别
    const draw = rand() * mixSum;
    let targetClass: IntegrityClass = 1;
    let acc = 0;
    for (const cls of [1, 2, 3, 4] as IntegrityClass[]) {
      acc += mix[cls];
      if (draw <= acc) {
        targetClass = cls;
        break;
      }
    }

    // 生成与目标类别匹配的缺陷
    const fdtdDefects: FdtdDefect[] = [];
    const truthDefects: SyntheticTruth['defects'] = [];
    const addDefect = (kind: DefectKind, depth: number) => {
      const d = makeDefect(kind, depth, rand);
      fdtdDefects.push(d);
      const impedanceRatio = d.areaRatio * d.speedRatio;
      truthDefects.push({ depth, impedanceRatio, kind, length: d.length });
    };

    if (targetClass === 4) {
      const depth = designLength * (0.25 + rand() * 0.5);
      addDefect(rand() < 0.7 ? 'break' : 'mud', depth);
    } else if (targetClass === 3) {
      const depth = designLength * (0.2 + rand() * 0.55);
      addDefect(rand() < 0.5 ? 'mud' : 'segregation', depth);
    } else if (targetClass === 2) {
      const depth = designLength * (0.15 + rand() * 0.6);
      addDefect(rand() < 0.6 ? 'necking' : 'segregation', depth);
      if (rand() < 0.25) addDefect('expansion', designLength * (0.3 + rand() * 0.4));
    } else {
      // I 类桩保持完整；少量加入轻微扩径（不影响类别）
      if (rand() < 0.2) addDefect('expansion', designLength * (0.35 + rand() * 0.4));
    }

    const toeCondition: 'free' | 'soil' = rand() < 0.55 ? 'free' : 'soil';
    const toeDashpot = toeCondition === 'free' ? 0 : 0.15 + rand() * 0.35;
    const headRinging = rand() < ringRate;
    const nBlows = 3 + Math.floor(rand() * 3); // 3~5 锤
    const badBlows: SyntheticTruth['badBlows'] = [];

    const blows = [];
    for (let b = 1; b <= nBlows; b++) {
      const isBad = b > 1 && rand() < badBlowRate; // 至少保留一锤好数据
      let reason = '';
      const doubleHitAt = isBad && rand() < 0.4 ? 0.012 + rand() * 0.02 : 0;
      if (doubleHitAt > 0) reason = '二次锤击';
      const noiseLevel = isBad && !reason ? 0.12 + rand() * 0.12 : 0.015 + rand() * 0.025;
      if (isBad && !reason) reason = rand() < 0.5 ? '噪声过大' : '信号微弱';
      const hammerAmp = reason === '信号微弱' ? 0.25 + rand() * 0.2 : 0.9 + rand() * 0.3;

      const { accel } = runFdtd({
        length: designLength,
        waveSpeed: c,
        diameter,
        defects: fdtdDefects,
        toeCondition,
        toeDashpot,
        shaftDamping: 0.012 + rand() * 0.02, // 桩侧辐射阻力系数 β（无量纲）
        kelvinTau: 0.04 + rand() * 0.05, // 应力弛豫时间 s（越大衰减越弱，保留缺陷与桩底反射）
        hammerTau: 0.0005 + rand() * 0.0007,
        hammerAmplitude: hammerAmp * 1e6,
        ringFreq: headRinging ? 1500 + rand() * 900 : 0,
        ringDecay: 0.005 + rand() * 0.006,
        // 振铃相对速度 RMS 的幅度（桩头松散颗粒可产生与入射同量级的高频振荡）
        ringAmp: headRinging ? 0.28 + rand() * 0.3 : 0,
        doubleHitAt,
        doubleHitAmp: doubleHitAt > 0 ? hammerAmp * 0.45 * 1e6 : 0,
        noiseLevel,
        lowFreqDrift: 0.01 + rand() * 0.02,
        rand,
      });
      if (isBad) badBlows.push({ blowId: b, reason });
      blows.push({
        id: b,
        sampleRate: OUTPUT_FS,
        accel,
        label: `第 ${b} 锤`,
      });
    }

    const truth: SyntheticTruth = {
      waveSpeed: c,
      defects: truthDefects,
      toeCondition,
      className: truthClassFromDefects(truthDefects),
      badBlows,
      headRinging,
    };

    piles.push({
      id,
      x: col * spacing + (rand() - 0.5) * 0.6,
      y: row * spacing + (rand() - 0.5) * 0.6,
      designLength,
      concreteGrade: grade,
      diameter,
      designWaveSpeed: Math.round(c),
      blows,
      truth,
    });
  }
  return piles;
}

/**
 * 数字信号处理基础工具
 * 全部基于纯函数 + Float64Array，可在主线程 / Worker / Node 中运行。
 */

/** 可配置的二阶 IIR 节（Direct Form I 转置结构，数值稳定） */
export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export function biquad(coeffs: BiquadCoeffs): (x: number) => number {
  const { b0, b1, b2, a1, a2 } = coeffs;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x: number): number => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/** RBJ audio EQ cookbook 标准 biquad 系数（低通），多节级联实现高阶巴特沃斯 */
function rbqLowpass(fs: number, f0: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * f0) / fs;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cosw) / 2 / a0,
    b1: (1 - cosw) / a0,
    b2: (1 - cosw) / 2 / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** RBJ 高通 */
function rbqHighpass(fs: number, f0: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * f0) / fs;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosw) / 2 / a0,
    b1: (-(1 + cosw)) / a0,
    b2: (1 + cosw) / 2 / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** 巴特沃斯各二阶节的 Q 值（第 k 节，共 n/2 节） */
function butterQ(k: number, order: number): number {
  return 1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (2 * order)));
}

/** 巴特沃斯低通，返回 order/2 个二阶节（order 须为偶数） */
export function butterworthLowpass(fs: number, cutoff: number, order = 4): BiquadCoeffs[] {
  const sections: BiquadCoeffs[] = [];
  for (let k = 0; k < order / 2; k++) {
    sections.push(rbqLowpass(fs, cutoff, butterQ(k, order)));
  }
  return sections;
}

/** 巴特沃斯高通 */
export function butterworthHighpass(fs: number, cutoff: number, order = 2): BiquadCoeffs[] {
  const sections: BiquadCoeffs[] = [];
  for (let k = 0; k < order / 2; k++) {
    sections.push(rbqHighpass(fs, cutoff, butterQ(k, order)));
  }
  return sections;
}

/** 对整段信号串联若干 biquad 节做零相位滤波（每节前向 + 后向各一遍，等效 filtfilt，无相位畸变） */
export function zeroPhaseFilter(input: Float64Array, sections: BiquadCoeffs[]): Float64Array {
  let cur = new Float64Array(input);
  for (const section of sections) {
    // 前向
    const ff = biquad(section);
    const fwd = new Float64Array(cur.length);
    for (let i = 0; i < cur.length; i++) fwd[i] = ff(cur[i]);
    // 后向：重新初始化滤波器状态，避免状态串扰
    const bf = biquad(section);
    const bwd = new Float64Array(cur.length);
    for (let i = cur.length - 1; i >= 0; i--) bwd[i] = bf(fwd[i]);
    cur = bwd;
  }
  return cur;
}

/** 加速度 -> 速度：梯形积分 + 高通去趋势（积分漂移是低应变分析的主要误差源之一） */
export function integrateAcceleration(accel: Float64Array, fs: number, hpCutoff = 8): Float64Array {
  const dt = 1 / fs;
  const velocity = new Float64Array(accel.length);
  let acc = 0;
  for (let i = 1; i < accel.length; i++) {
    acc += 0.5 * (accel[i - 1] + accel[i]) * dt;
    velocity[i] = acc;
  }
  const hp = butterworthHighpass(fs, hpCutoff, 2);
  return zeroPhaseFilter(velocity, hp);
}

/** 去均值 */
export function removeMean(x: Float64Array): Float64Array {
  let s = 0;
  for (const v of x) s += v;
  const mean = s / x.length;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] - mean;
  return out;
}

/**
 * 指数放大（低应变规范规定的放大方式）：
 * G(t) = exp(alpha * t)，alpha 依据桩长与波速选取，使桩底处增益约为 e^(alpha * 2L/c)
 * 限制最大增益避免尾部噪声与多次反射爆炸。
 */
export function exponentialGain(
  velocity: Float64Array,
  fs: number,
  travelTimeSec: number,
  targetGainAtToe = 10,
  maxGain = 40,
): { amplified: Float64Array; alpha: number } {
  const alpha = travelTimeSec > 0 ? Math.log(targetGainAtToe) / travelTimeSec : 0;
  const out = new Float64Array(velocity.length);
  for (let i = 0; i < velocity.length; i++) {
    const t = i / fs;
    const g = Math.min(maxGain, Math.exp(alpha * t));
    out[i] = velocity[i] * g;
  }
  return { amplified: out, alpha };
}

/** 归一化互相关（零均值），窗口由 start/end 指定；返回 [-1, 1] */
export function normalizedCrossCorrelation(
  a: Float64Array,
  b: Float64Array,
  aStart: number,
  bStart: number,
  len: number,
): number {
  let ma = 0;
  let mb = 0;
  for (let k = 0; k < len; k++) {
    ma += a[aStart + k];
    mb += b[bStart + k];
  }
  ma /= len;
  mb /= len;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let k = 0; k < len; k++) {
    const va = a[aStart + k] - ma;
    const vb = b[bStart + k] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  const den = Math.sqrt(da * db);
  return den < 1e-12 ? 0 : num / den;
}

/** RMS */
export function rms(x: Float64Array, start = 0, end?: number): number {
  const e = end ?? x.length;
  let s = 0;
  for (let i = start; i < e; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, e - start));
}

/** 峰值绝对值位置（可限定窗口） */
export function peakIndex(x: Float64Array, start = 0, end?: number): { index: number; value: number } {
  const e = end ?? x.length;
  let idx = start;
  let best = -Infinity;
  for (let i = start; i < e; i++) {
    const a = Math.abs(x[i]);
    if (a > best) {
      best = a;
      idx = i;
    }
  }
  return { index: idx, value: x[idx] };
}

/** 抛物线三点插值，把离散峰值位置精化到亚样本精度 */
export function parabolicInterp(x: Float64Array, i: number): { index: number; value: number } {
  if (i <= 0 || i >= x.length - 1) return { index: i, value: x[i] };
  const y0 = Math.abs(x[i - 1]);
  const y1 = Math.abs(x[i]);
  const y2 = Math.abs(x[i + 1]);
  const denom = y0 - 2 * y1 + y2;
  if (Math.abs(denom) < 1e-15) return { index: i, value: x[i] };
  const offset = 0.5 * (y0 - y2) / denom;
  return { index: i + offset, value: Math.sign(x[i]) * (y1 - 0.25 * (y0 - y2) * offset) };
}

/** 简单确定性 PRNG（mulberry32），保证合成数据可复现 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 高斯白噪声（Box-Muller） */
export function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 数组中位数 */
export function median(x: number[]): number {
  if (x.length === 0) return NaN;
  const s = [...x].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** 标准差（总体） */
export function std(x: number[]): number {
  if (x.length < 2) return 0;
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  return Math.sqrt(x.reduce((a, b) => a + (b - mean) ** 2, 0) / x.length);
}

/** 线性插值取值 */
export function interp(x: Float64Array, index: number): number {
  const i = Math.floor(index);
  if (i < 0) return x[0];
  if (i >= x.length - 1) return x[x.length - 1];
  const f = index - i;
  return x[i] * (1 - f) + x[i + 1] * f;
}

// 数字信号处理工具：积分、基线校正、滤波、指数放大、FFT、峰值与相关性
// 全部为纯函数，输入输出使用 Float64Array，可在主线程与 Web Worker 中复用

/** 确定性随机数（mulberry32），保证合成与测试可复现 */
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

export function maxAbs(x: Float64Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > m) m = a;
  }
  return m;
}

export function normalize(x: Float64Array): Float64Array {
  const m = maxAbs(x);
  const out = new Float64Array(x.length);
  if (m < 1e-30) return out;
  for (let i = 0; i < x.length; i++) out[i] = x[i] / m;
  return out;
}

/** 加速度 -> 速度（梯形积分），返回与输入等长 */
export function integrate(acc: Float64Array, dt: number): Float64Array {
  const v = new Float64Array(acc.length);
  let s = 0;
  for (let i = 1; i < acc.length; i++) {
    s += 0.5 * (acc[i - 1] + acc[i]) * dt;
    v[i] = s;
  }
  return v;
}

/** 最小二乘去线性趋势（同时去掉直流） */
export function detrend(x: Float64Array): Float64Array {
  const n = x.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += x[i];
    sxx += i * i;
    sxy += i * x[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const mean = sy / n;
  const xMean = sx / n;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i] - (mean + slope * (i - xMean));
  return out;
}

/**
 * 积分后基线校正：先用入射前安静段去直流，再整段去趋势，
 * 最后强制入射前信号均值为 0（抑制加速度计零漂导致的速度漂移）
 */
export function baselineCorrect(
  v: Float64Array,
  incidentIndex: number,
): Float64Array {
  let out = detrend(v);
  const quietEnd = Math.max(4, Math.floor(incidentIndex * 0.8));
  let sum = 0;
  for (let i = 0; i < quietEnd; i++) sum += out[i];
  const bias = sum / quietEnd;
  for (let i = 0; i < out.length; i++) out[i] -= bias;
  return out;
}

/** 滑动平均低通（半宽 halfWin 个采样点） */
export function movingAverage(x: Float64Array, halfWin: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const w = Math.max(0, Math.floor(halfWin));
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += x[i];
    if (i > 2 * w) acc -= x[i - 2 * w - 1];
    const lo = Math.max(0, i - 2 * w);
    out[i] = acc / (i - lo + 1);
  }
  return out;
}

/**
 * 指数放大（PIT 增益）：从入射峰时刻 t0 起
 * G(t) = exp(alpha * (t - t0))，补偿土中阻尼衰减
 */
export function exponentialGain(
  v: Float64Array,
  incidentIndex: number,
  alpha: number,
): Float64Array {
  const out = new Float64Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const dtIdx = i - incidentIndex;
    out[i] = dtIdx <= 0 ? v[i] : v[i] * Math.exp(alpha * dtIdx);
  }
  return out;
}

/**
 * 寻找入射脉冲。
 * 入射脉冲在时间上必然最早到达，因此只在记录前 searchFrac 范围内找最大绝对值峰，
 * 避免断桩强反射/基线漂移使后部幅值超过入射峰时定位错误。
 */
export function findIncidentPeak(
  v: Float64Array,
  searchFrac = 0.3,
): { index: number; sign: number } {
  const end = Math.max(8, Math.floor(v.length * searchFrac));
  let idx = 0;
  let best = -1;
  for (let i = 0; i < end; i++) {
    const a = Math.abs(v[i]);
    if (a > best) {
      best = a;
      idx = i;
    }
  }
  return { index: idx, sign: v[idx] >= 0 ? 1 : -1 };
}

export interface Extremum {
  index: number;
  value: number;
  kind: 'max' | 'min';
}

/** 局部极值检测（最小间距 minDist 个采样点） */
export function findLocalExtrema(x: Float64Array, minDist: number): Extremum[] {
  const out: Extremum[] = [];
  let pending: Extremum | null = null;
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i] >= x[i - 1] && x[i] >= x[i + 1] && x[i] !== x[i - 1]) {
      pending = pushExtremum(out, pending, { index: i, value: x[i], kind: 'max' }, minDist);
    } else if (x[i] <= x[i - 1] && x[i] <= x[i + 1] && x[i] !== x[i - 1]) {
      pending = pushExtremum(out, pending, { index: i, value: x[i], kind: 'min' }, minDist);
    }
  }
  if (pending) out.push(pending);
  return out;
}

function pushExtremum(
  out: Extremum[],
  pending: Extremum | null,
  cur: Extremum,
  minDist: number,
): Extremum | null {
  if (!pending) return cur;
  if (cur.kind === pending.kind && cur.index - pending.index < minDist) {
    // 同类极值间距过小，保留幅值更大的
    return Math.abs(cur.value) > Math.abs(pending.value) ? cur : pending;
  }
  out.push(pending);
  return cur;
}

/** 抛物线亚采样插值，返回修正后的分数位置与峰值 */
export function parabolicInterp(
  x: Float64Array,
  i: number,
): { index: number; value: number } {
  if (i <= 0 || i >= x.length - 1) return { index: i, value: x[i] };
  const y0 = x[i - 1];
  const y1 = x[i];
  const y2 = x[i + 1];
  const denom = y0 - 2 * y1 + y2;
  if (Math.abs(denom) < 1e-30) return { index: i, value: y1 };
  const delta = 0.5 * (y0 - y2) / denom;
  const clamped = Math.max(-1, Math.min(1, delta));
  const value = y1 - 0.25 * (y0 - y2) * clamped;
  return { index: i + clamped, value };
}

/**
 * 能量质心亚采样定位：在峰 ±halfWin 内按幅值平方加权求质心，
 * 对宽缓、受噪声扰动的弱反射峰比三点抛物线更稳健。
 */
export function centroidRefine(
  x: Float64Array,
  i: number,
  halfWin = 2,
): { index: number; value: number } {
  const lo = Math.max(0, i - halfWin);
  const hi = Math.min(x.length - 1, i + halfWin);
  let num = 0;
  let den = 0;
  for (let k = lo; k <= hi; k++) {
    const w = x[k] * x[k];
    num += k * w;
    den += w;
  }
  if (den < 1e-30) return { index: i, value: x[i] };
  const idx = Math.max(lo, Math.min(hi, num / den));
  // 质心位置的线性插值幅值
  const base = Math.floor(idx);
  const f = idx - base;
  const value = x[base] * (1 - f) + (x[base + 1] ?? x[base]) * f;
  return { index: idx, value };
}

/** 归一化互相关（零均值），用于多锤波形一致性 */
export function normalizedCorrelation(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const va = a[i] - ma;
    const vb = b[i] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  const denom = Math.sqrt(da * db);
  return denom < 1e-30 ? 0 : num / denom;
}

// ---------------- FFT（迭代基2） ----------------

export interface FFTResult {
  re: Float64Array;
  im: Float64Array;
}

export function fft(input: Float64Array): FFTResult {
  let n = 1;
  while (n < input.length) n <<= 1;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(input);
  // 位反转
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  return { re, im };
}

/** 单边幅度谱（长度 floor(n/2)+1） */
export function amplitudeSpectrum(x: Float64Array, dt: number) {
  const { re, im } = fft(x);
  const n = re.length;
  const bins = Math.floor(n / 2) + 1;
  const mag = new Float64Array(bins);
  const freq = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    mag[k] = Math.hypot(re[k], im[k]) / n;
    freq[k] = k / (n * dt);
  }
  return { mag, freq };
}

/** 谱质心 Hz */
export function spectralCentroid(x: Float64Array, dt: number): number {
  const { mag, freq } = amplitudeSpectrum(x, dt);
  let num = 0;
  let den = 0;
  for (let k = 1; k < mag.length; k++) {
    num += freq[k] * mag[k];
    den += mag[k];
  }
  return den < 1e-30 ? 0 : num / den;
}

/** 截止频率以上的能量占比 */
export function highFrequencyRatio(x: Float64Array, dt: number, cutoffHz: number): number {
  const { mag, freq } = amplitudeSpectrum(x, dt);
  let hi = 0;
  let all = 0;
  for (let k = 1; k < mag.length; k++) {
    const e = mag[k] * mag[k];
    all += e;
    if (freq[k] >= cutoffHz) hi += e;
  }
  return all < 1e-30 ? 0 : hi / all;
}

/** 过零率（次/毫秒） */
export function zeroCrossingRate(x: Float64Array, dt: number): number {
  let count = 0;
  for (let i = 1; i < x.length; i++) {
    if ((x[i - 1] >= 0) !== (x[i] >= 0) && (x[i - 1] !== 0 || x[i] !== 0)) count++;
  }
  const durationMs = (x.length * dt) / 1e-3;
  return count / Math.max(durationMs, 1e-9);
}

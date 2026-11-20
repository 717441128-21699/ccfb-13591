/** Canvas 绘制：波形曲线与反射事件标注 */
import type { BlowAnalysis, ReflectionEvent } from '../types';

const COLORS = {
  raw: '#7fb3e8',
  amplified: '#e4e9ef',
  same: '#4da3ff',
  opposite: '#ff7043',
  toe: '#4caf50',
  grid: '#26303c',
  axis: '#3d4a59',
};

/** 绘制单条波形（速度或指数放大），可叠加事件标记 */
export function drawWave(
  canvas: HTMLCanvasElement,
  opts: {
    data: Float64Array;
    sampleRate: number;
    incidentIdx: number;
    events?: ReflectionEvent[];
    toe?: ReflectionEvent;
    showToe?: boolean;
    title: string;
    yLabel: string;
  },
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 500;
  const cssH = 150;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const W = cssW;
  const H = cssH;
  const padL = 44;
  const padR = 12;
  const padT = 22;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px monospace';
  ctx.fillStyle = '#8b98a8';
  ctx.fillText(opts.title, padL, 13);

  const { data, sampleRate, incidentIdx } = opts;
  // 时间轴范围：0 ~ 记录末尾相对入射的秒数
  const tMax = (data.length - 1 - incidentIdx) / sampleRate;
  const xOf = (i: number) => padL + ((i - incidentIdx) / sampleRate / tMax) * plotW;

  // 幅度归一化
  let peak = 0;
  for (let i = incidentIdx; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak < 1e-12) peak = 1;
  const yOf = (v: number) => padT + plotH / 2 - (v / peak) * (plotH / 2) * 0.92;

  // 网格 + 零轴
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();
  ctx.strokeStyle = COLORS.axis;
  ctx.beginPath();
  const yZero = yOf(0);
  ctx.moveTo(padL, yZero);
  ctx.lineTo(padL + plotW, yZero);
  ctx.stroke();

  // 时间刻度（ms）
  ctx.fillStyle = '#8b98a8';
  const tickMs = tMax > 0.03 ? 5 : 2;
  for (let ms = 0; ms <= tMax * 1000; ms += tickMs) {
    const x = padL + (ms / 1000 / tMax) * plotW;
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillText(`${ms}`, x - 6, padT + plotH + 14);
  }
  ctx.fillText('t(ms)', padL + plotW - 28, padT + plotH + 14);
  ctx.fillText(opts.yLabel, 4, padT + 4);

  // 事件竖线（先画，置于曲线下方）
  const markEvent = (ev: ReflectionEvent, color: string, label: string) => {
    const idx = incidentIdx + ev.timeSec * sampleRate;
    const x = xOf(idx);
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText(label, x + 2, padT + 10);
    ctx.font = '10px monospace';
  };
  if (opts.showToe !== false && opts.toe) {
    markEvent(opts.toe, COLORS.toe, '桩底');
  }
  for (const ev of opts.events ?? []) {
    markEvent(ev, ev.samePhase ? COLORS.same : COLORS.opposite, ev.samePhase ? '同相' : '反相');
  }

  // 波形曲线
  ctx.strokeStyle = opts.title.includes('放大') ? COLORS.amplified : COLORS.raw;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  for (let i = incidentIdx; i < data.length; i++) {
    const x = xOf(i);
    const y = yOf(data[i]);
    if (i === incidentIdx) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // 入射峰标记
  ctx.fillStyle = '#f44336';
  ctx.beginPath();
  ctx.arc(xOf(incidentIdx), yOf(data[incidentIdx]), 2.5, 0, Math.PI * 2);
  ctx.fill();
}

/** 绘制多锤叠加的缩略对比（用于锤间一致性可视化） */
export function drawOverlap(
  canvas: HTMLCanvasElement,
  blows: BlowAnalysis[],
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 500;
  const cssH = 110;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const W = cssW;
  const H = cssH;
  ctx.clearRect(0, 0, W, H);
  ctx.font = '10px monospace';
  ctx.fillStyle = '#8b98a8';
  ctx.fillText('多锤波形叠加（指纹对比）', 8, 13);

  const palette = ['#4da3ff', '#4caf50', '#ffc107', '#ff9800', '#ab47bc'];
  const padL = 8;
  const padT = 20;
  const plotH = H - padT - 8;
  // 统一时间窗与归一化
  let globalPeak = 0;
  let maxLen = 0;
  for (const b of blows) {
    for (let i = b.incidentIndex; i < b.timeAxis.length; i++) globalPeak = Math.max(globalPeak, Math.abs(b.velocity[i]));
    maxLen = Math.max(maxLen, b.timeAxis.length - b.incidentIndex);
  }
  if (globalPeak < 1e-12) globalPeak = 1;
  blows.forEach((b, bi) => {
    ctx.strokeStyle = palette[bi % palette.length];
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < b.timeAxis.length - b.incidentIndex; k++) {
      const i = b.incidentIndex + k;
      const x = padL + (k / maxLen) * (W - padL - 8);
      const y = padT + plotH / 2 - (b.velocity[i] / globalPeak) * (plotH / 2) * 0.9;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}

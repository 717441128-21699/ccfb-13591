// 单锤波形绘制（Canvas）：速度时程 + 指数放大曲线 + 反射事件标注

import type { BlowAnalysis } from '../core/types.ts';

const CLASS_COLOR: Record<string, string> = {
  I: '#16a34a',
  II: '#2563eb',
  III: '#d97706',
  IV: '#dc2626',
};

export function drawWaveform(
  canvas: HTMLCanvasElement,
  analysis: BlowAnalysis,
  pileLength: number,
  waveSpeed: number | null,
): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 46;
  const padR = 12;
  const padT = 14;
  const padB = 26;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const v = analysis.velocity;
  const t0 = analysis.incidentIndex;
  const dt = analysis.dt;
  const c = waveSpeed ?? 3600;

  // 横坐标显示为深度（m）：depth = c·t/2
  const maxT = (v.length - t0) * dt;
  const maxDepth = (c * maxT) / 2;
  const xOf = (i: number) => padL + ((i - t0) / (v.length - t0)) * plotW;
  const yOf = (val: number) => padT + (1 - (val + 1) / 2) * plotH;

  // 背景与网格
  ctx.fillStyle = '#0b1220';
  ctx.fillRect(padL, padT, plotW, plotH);
  ctx.strokeStyle = 'rgba(148,163,184,0.15)';
  ctx.lineWidth = 1;
  ctx.font = '10px system-ui';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  const depthStep = chooseDepthStep(pileLength);
  for (let d = 0; d <= Math.min(maxDepth, pileLength * 1.4); d += depthStep) {
    const i = t0 + (2 * d) / c / dt;
    if (i < t0 || i > v.length) continue;
    const x = xOf(i);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillText(`${d}m`, x, padT + plotH + 15);
  }
  // 零线
  ctx.strokeStyle = 'rgba(148,163,184,0.4)';
  ctx.beginPath();
  ctx.moveTo(padL, yOf(0));
  ctx.lineTo(padL + plotW, yOf(0));
  ctx.stroke();

  // 桩头屏蔽区
  if (analysis.headRinging.detected) {
    const maskIdx = t0 + (2 * analysis.headRinging.maskDepth) / c / dt;
    ctx.fillStyle = 'rgba(217,119,6,0.18)';
    ctx.fillRect(padL, padT, Math.max(0, xOf(maskIdx) - padL), plotH);
  }

  // 原始速度（浅色）
  drawTrace(ctx, v, xOf, yOf, 'rgba(148,163,184,0.55)', 1);
  // 指数放大（亮色）
  drawTrace(ctx, analysis.amplified, xOf, yOf, '#38bdf8', 1.4);

  // 入射峰标注
  ctx.strokeStyle = '#e2e8f0';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(xOf(t0), padT);
  ctx.lineTo(xOf(t0), padT + plotH);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#e2e8f0';
  ctx.textAlign = 'left';
  ctx.fillText('入射', xOf(t0) + 3, padT + 10);

  // 事件标注
  for (const e of analysis.events) {
    const idx = t0 + e.travelTime / dt;
    if (idx < t0 || idx >= v.length) continue;
    const x = xOf(idx);
    const color =
      e.defectType === 'toe'
        ? '#a78bfa'
        : e.phase === 'in'
          ? CLASS_COLOR.IV
          : CLASS_COLOR.II;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.textAlign = x > cssW - 60 ? 'right' : 'left';
    const label =
      e.defectType === 'toe'
        ? `桩底 ${e.depth.toFixed(1)}m`
        : `${defectName(e.defectType)} ${e.depth.toFixed(1)}m`;
    ctx.fillText(label, x + (x > cssW - 60 ? -3 : 3), padT + plotH - 4);
  }

  // 标题与状态
  ctx.textAlign = 'left';
  ctx.fillStyle = analysis.rejected ? '#f87171' : '#cbd5e1';
  ctx.font = 'bold 11px system-ui';
  const status = analysis.rejected ? `（已剔除：${analysis.rejectReason ?? ''}）` : '';
  ctx.fillText(`${analysis.blowId} ${status}`, padL, 11);
}

function drawTrace(
  ctx: CanvasRenderingContext2D,
  data: Float64Array,
  xOf: (i: number) => number,
  yOf: (v: number) => number,
  color: string,
  width: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  const t0Offset = 0;
  for (let i = 0; i < data.length; i++) {
    const x = xOf(i);
    const y = yOf(data[i]);
    if (i === t0Offset) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function chooseDepthStep(L: number): number {
  if (L <= 12) return 2;
  if (L <= 24) return 4;
  return 5;
}

export function defectName(t: string): string {
  switch (t) {
    case 'neck':
      return '缩颈';
    case 'bulge':
      return '扩径';
    case 'segregation':
      return '夹泥';
    case 'break':
      return '断桩';
    default:
      return t;
  }
}

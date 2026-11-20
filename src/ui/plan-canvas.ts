/** 桩位平面图：Canvas 网格排布，按完整性类别着色，存疑桩加环，点击选中 */
import type { IntegrityClass, PileResult, SyntheticPile } from '../types';

const CLASS_COLOR: Record<IntegrityClass, string> = {
  1: '#4caf50',
  2: '#ffc107',
  3: '#ff9800',
  4: '#f44336',
};

const RADIUS = 13;
const COLS_HINT = 20;

export interface PlanClick {
  pileId: string;
}

export function drawPlan(
  canvas: HTMLCanvasElement,
  piles: SyntheticPile[],
  results: Map<string, PileResult>,
  selectedId: string | null,
  onClick: (id: string) => void,
): void {
  const dpr = window.devicePixelRatio || 1;
  const wrapW = canvas.clientWidth || 600;
  const cols = Math.min(COLS_HINT, Math.ceil(Math.sqrt(piles.length * 1.4)));
  const rows = Math.ceil(piles.length / cols);
  const cellW = Math.max(40, (wrapW - 30) / cols);
  const cellH = 42;
  const cssW = Math.max(wrapW, cols * cellW + 20);
  const cssH = rows * cellH + 20;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  // 记录点击热区
  const hotspots: { id: string; x: number; y: number; r: number }[] = [];

  piles.forEach((pile, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    // 平面图坐标带轻微随机错位（与合成端一致的视觉效果）
    const jitterX = ((pile.x * 0.1) % 1) * 6 - 3;
    const jitterY = ((pile.y * 0.1) % 1) * 6 - 3;
    const cx = 14 + col * cellW + cellW / 2 + jitterX;
    const cy = 12 + row * cellH + cellH / 2 + jitterY;
    const result = results.get(pile.id);
    const cls = result?.className ?? 1;
    const color = CLASS_COLOR[cls];

    // 选中高亮
    if (pile.id === selectedId) {
      ctx.beginPath();
      ctx.arc(cx, cy, RADIUS + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // 桩体
    ctx.beginPath();
    ctx.arc(cx, cy, RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = result ? 0.92 : 0.35;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#0f1419';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // 存疑问号环
    if (result?.questionable) {
      ctx.beginPath();
      ctx.arc(cx, cy, RADIUS + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#ab47bc';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 编号
    ctx.fillStyle = '#0f1419';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const num = pile.id.replace('ZH-', '');
    ctx.fillText(num, cx, cy + 0.5);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';

    hotspots.push({ id: pile.id, x: cx, y: cy, r: RADIUS + 4 });
  });

  canvas.onclick = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    for (const h of hotspots) {
      if ((mx - h.x) ** 2 + (my - h.y) ** 2 <= h.r ** 2) {
        onClick(h.id);
        return;
      }
    }
  };
}

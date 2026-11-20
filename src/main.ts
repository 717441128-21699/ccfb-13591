// 主应用：工地平面图 + 统计 + 桩详情（多锤波形并排与判读理由）

import './ui/styles.css';
import { generateSite } from './core/siteGenerator.ts';
import { parsePileData } from './core/importer.ts';
import { buildImportTemplate, CSV_TEMPLATE } from './core/template.ts';
import type {
  IntegrityClass,
  PileReport,
  PileTest,
  ReflectionEvent,
} from './core/types.ts';
import { analyzeSite } from './worker/workerPool.ts';
import { defectName, drawWaveform } from './ui/waveform.ts';

const CLASS_COLOR: Record<IntegrityClass, string> = {
  I: '#16a34a',
  II: '#2563eb',
  III: '#d97706',
  IV: '#dc2626',
};
const CLASS_LABEL: Record<IntegrityClass, string> = {
  I: 'I 类 完整',
  II: 'II 类 轻微缺陷',
  III: 'III 类 明显缺陷',
  IV: 'IV 类 断桩/严重',
};

interface AppState {
  tests: PileTest[];
  reports: Map<string, PileReport>;
  selectedId: string | null;
  filter: IntegrityClass | 'all' | 'questionable';
  workerCount: number;
}

const state: AppState = {
  tests: [],
  reports: new Map(),
  selectedId: null,
  filter: 'all',
  workerCount: 0,
};

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="topbar">
    <h1>基桩低应变反射波法完整性分析系统</h1>
    <button class="btn" id="runBtn">生成并分析 300 根桩</button>
    <button class="btn secondary" id="importBtn">导入实测波形</button>
    <button class="btn secondary" id="templateBtn">下载导入模板</button>
    <input type="file" id="fileInput" accept=".csv,.json,.txt" hidden multiple />
    <div class="progress-bar"><div id="progFill"></div></div>
    <span class="elapsed" id="elapsed"></span>
  </header>
  <div class="main">
    <section class="panel" id="planPanel">
      <h2>工地平面图（颜色 = 完整性类别，虚线框 = 疑问桩）</h2>
      <div class="stats" id="stats"></div>
      <div class="legend">
        <span><span class="dot" style="background:${CLASS_COLOR.I}"></span>I 类</span>
        <span><span class="dot" style="background:${CLASS_COLOR.II}"></span>II 类</span>
        <span><span class="dot" style="background:${CLASS_COLOR.III}"></span>III 类</span>
        <span><span class="dot" style="background:${CLASS_COLOR.IV}"></span>IV 类</span>
        <span><span class="dot" style="background:transparent;border:1px dashed var(--warn)"></span>疑问待复核</span>
      </div>
      <div class="filter-row" id="filterRow"></div>
      <div class="plan-wrap"><canvas id="planCanvas"></canvas></div>
    </section>
    <section class="panel" id="detailPanel">
      <div class="empty">点击左侧平面图中的桩查看波形与判读理由</div>
    </section>
  </div>
  <div class="tooltip" id="tooltip"></div>
`;

const runBtn = document.querySelector<HTMLButtonElement>('#runBtn')!;
const importBtn = document.querySelector<HTMLButtonElement>('#importBtn')!;
const templateBtn = document.querySelector<HTMLButtonElement>('#templateBtn')!;
const fileInput = document.querySelector<HTMLInputElement>('#fileInput')!;
const progFill = document.querySelector<HTMLDivElement>('#progFill')!;
const elapsedEl = document.querySelector<HTMLSpanElement>('#elapsed')!;
const planCanvas = document.querySelector<HTMLCanvasElement>('#planCanvas')!;
const detailPanel = document.querySelector<HTMLDivElement>('#detailPanel')!;
const statsEl = document.querySelector<HTMLDivElement>('#stats')!;
const filterRow = document.querySelector<HTMLDivElement>('#filterRow')!;
const tooltip = document.querySelector<HTMLDivElement>('#tooltip')!;

runBtn.addEventListener('click', () => runDemoSite());
importBtn.addEventListener('click', () => fileInput.click());
templateBtn.addEventListener('click', downloadTemplate);
fileInput.addEventListener('change', handleImport);

function downloadTemplate(): void {
  const blob = new Blob([buildImportTemplate()], { type: 'application/json' });
  triggerDownload(blob, 'pile-import-template.json');
  const csvBlob = new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' });
  triggerDownload(csvBlob, 'pile-import-template.csv');
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function handleImport(): Promise<void> {
  if (!fileInput.files || fileInput.files.length === 0) return;
  const allTests: PileTest[] = [];
  const allErrors: string[] = [];
  for (const file of Array.from(fileInput.files)) {
    const text = await file.text();
    const result = parsePileData(text, file.name);
    allTests.push(...result.tests);
    allErrors.push(...result.errors.map((e) => `[${file.name}] ${e}`));
  }
  fileInput.value = '';
  if (allTests.length === 0) {
    elapsedEl.textContent = `导入失败：${allErrors.slice(0, 3).join('；') || '无有效数据'}`;
    return;
  }
  if (allErrors.length > 0) console.warn('导入告警：', allErrors);
  await runTests(allTests, `已导入 ${allTests.length} 根实测桩`);
}

async function runDemoSite(): Promise<void> {
  runBtn.disabled = true;
  elapsedEl.textContent = '正在合成波形…';
  progFill.style.width = '0%';
  await new Promise((r) => setTimeout(r, 30));
  const tGen0 = performance.now();
  const site = generateSite(300);
  const genMs = performance.now() - tGen0;
  await runTests(site.tests, '合成演示工地', site.groundTruths, genMs);
  runBtn.disabled = false;
}

async function runTests(
  tests: PileTest[],
  label: string,
  groundTruths?: Map<string, PileReport['groundTruth']>,
  genMs = 0,
): Promise<void> {
  state.tests = tests;
  state.reports.clear();
  const result = await analyzeSite(tests, groundTruths, {
    onProgress: (done, total) => {
      progFill.style.width = `${(done / total) * 100}%`;
    },
  });
  for (const r of result.reports) state.reports.set(r.pileId, r);
  state.workerCount = result.workerCount;
  elapsedEl.textContent =
    `${label} · ${genMs ? `合成 ${genMs.toFixed(0)}ms · ` : ''}分析 ${result.elapsedMs.toFixed(0)}ms · ${result.workerCount} Worker · ${tests.length} 桩`;
  state.selectedId = null;
  detailPanel.innerHTML = '<div class="empty">点击左侧平面图中的桩查看波形与判读理由</div>';
  renderStats();
  renderFilters();
  renderPlan();
}

const FILTERS: { key: AppState['filter']; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'questionable', label: '仅疑问桩' },
  { key: 'IV', label: 'IV 类' },
  { key: 'III', label: 'III 类' },
  { key: 'II', label: 'II 类' },
  { key: 'I', label: 'I 类' },
];

function renderFilters(): void {
  filterRow.innerHTML = FILTERS.map(
    (f) =>
      `<button data-f="${f.key}" class="${state.filter === f.key ? 'active' : ''}">${f.label}</button>`,
  ).join('');
  filterRow.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      state.filter = b.dataset.f as AppState['filter'];
      renderFilters();
      renderPlan();
    }),
  );
}

function renderStats(): void {
  const reports = [...state.reports.values()];
  const count = (c: IntegrityClass) => reports.filter((r) => r.finalClass === c).length;
  const questionable = reports.filter((r) => r.questionable).length;
  const items: { num: number; lbl: string; color: string }[] = [
    { num: count('I'), lbl: CLASS_LABEL.I, color: CLASS_COLOR.I },
    { num: count('II'), lbl: CLASS_LABEL.II, color: CLASS_COLOR.II },
    { num: count('III'), lbl: CLASS_LABEL.III, color: CLASS_COLOR.III },
    { num: count('IV'), lbl: CLASS_LABEL.IV, color: CLASS_COLOR.IV },
  ];
  statsEl.innerHTML =
    items.map((i) => `<div class="stat"><div class="num" style="color:${i.color}">${i.num}</div><div class="lbl">${i.lbl}</div></div>`).join('') +
    `<div class="stat"><div class="num" style="color:var(--warn)">${questionable}</div><div class="lbl">疑问待复核</div></div>`;
}

function renderPlan(): void {
  if (state.tests.length === 0) return;
  const maxX = Math.max(...state.tests.map((t) => t.meta.x));
  const maxY = Math.max(...state.tests.map((t) => t.meta.y));
  const cell = 34;
  const margin = 30;
  const cssW = margin * 2 + (maxX / 6 + 1) * cell;
  const cssH = margin * 2 + (maxY / 6 + 1) * cell;
  const dpr = window.devicePixelRatio || 1;
  planCanvas.style.width = `${cssW}px`;
  planCanvas.style.height = `${cssH}px`;
  planCanvas.width = Math.round(cssW * dpr);
  planCanvas.height = Math.round(cssH * dpr);
  const ctx = planCanvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  for (const t of state.tests) {
    const r = state.reports.get(t.meta.id);
    if (!r) continue;
    if (!passFilter(r)) continue;
    const x = margin + (t.meta.x / 6) * cell;
    const y = margin + (t.meta.y / 6) * cell;
    const size = cell - 8;
    ctx.fillStyle = CLASS_COLOR[r.finalClass];
    roundRect(ctx, x, y, size, size, 5);
    ctx.fill();
    if (r.questionable) {
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(x - 1.5, y - 1.5, size + 3, size + 3);
      ctx.setLineDash([]);
    }
    if (state.selectedId === t.meta.id) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 3, y - 3, size + 6, size + 6);
    }
  }
}

function passFilter(r: PileReport): boolean {
  if (state.filter === 'all') return true;
  if (state.filter === 'questionable') return r.questionable;
  return r.finalClass === state.filter;
}

planCanvas.addEventListener('click', (ev) => {
  const hit = pickPile(ev);
  if (hit) {
    state.selectedId = hit.meta.id;
    renderPlan();
    renderDetail(hit.meta.id);
  }
});

planCanvas.addEventListener('mousemove', (ev) => {
  const hit = pickPile(ev);
  if (hit) {
    const r = state.reports.get(hit.meta.id)!;
    tooltip.style.display = 'block';
    tooltip.style.left = `${ev.clientX + 12}px`;
    tooltip.style.top = `${ev.clientY + 12}px`;
    tooltip.innerHTML = `${hit.meta.id} · ${CLASS_LABEL[r.finalClass]}${r.questionable ? ' · 疑问' : ''}<br>桩长 ${hit.meta.designLength}m · ${hit.meta.concreteGrade} · 波速 ${r.waveSpeed?.toFixed(0) ?? '—'}m/s`;
  } else {
    tooltip.style.display = 'none';
  }
});

function pickPile(ev: MouseEvent): PileTest | null {
  const rect = planCanvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  const margin = 30;
  const cell = 34;
  let best: PileTest | null = null;
  let bestD = Infinity;
  for (const t of state.tests) {
    const x = margin + (t.meta.x / 6) * cell + (cell - 8) / 2;
    const y = margin + (t.meta.y / 6) * cell + (cell - 8) / 2;
    const d = Math.hypot(mx - x, my - y);
    if (d < bestD && d < 18) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

function renderDetail(pileId: string): void {
  const r = state.reports.get(pileId);
  const t = state.tests.find((x) => x.meta.id === pileId);
  if (!r || !t) return;
  const m = t.meta;
  const defects = r.events.filter((e) => e.defectType !== 'toe');

  detailPanel.innerHTML = `
    <div class="detail-head">
      <h2 style="margin:0">${pileId}</h2>
      <span class="class-badge" style="background:${CLASS_COLOR[r.finalClass]}">${CLASS_LABEL[r.finalClass]}</span>
      ${r.questionable ? '<span class="question-tag">疑问桩 · 需人工复核</span>' : ''}
      <span style="font-size:12px;color:var(--muted)">有效锤 ${r.validBlows}/${r.totalBlows}</span>
    </div>
    <div class="meta-grid">
      <div>设计桩长 <b>${m.designLength} m</b></div>
      <div>桩径 <b>${m.diameter} m</b></div>
      <div>强度 <b>${m.concreteGrade}</b></div>
      <div>桩端 <b>${m.toeCondition === 'socketed' ? '嵌岩' : '摩擦'}</b></div>
      <div>反算波速 <b>${r.waveSpeed?.toFixed(0) ?? '—'} m/s</b></div>
      <div>桩底置信度 <b>${(r.toeConfidence * 100).toFixed(0)}%</b></div>
    </div>
    ${
      r.headRinging.detected
        ? `<div class="reasons" style="border-left:3px solid var(--warn)">⚠️ ${r.headRinging.reason}</div>`
        : ''
    }
    ${
      defects.length
        ? `<table class="events">
            <tr><th>类型</th><th>深度(m)</th><th>相位</th><th>反射系数</th><th>周期次数</th><th>置信度</th></tr>
            ${defects
              .map(
                (e: ReflectionEvent) => `<tr>
                <td style="color:${e.phase === 'in' ? '#f87171' : '#60a5fa'}">${defectName(e.defectType)}</td>
                <td>${e.depth.toFixed(2)}</td>
                <td>${e.phase === 'in' ? '同相(阻抗↓)' : '反相(阻抗↑)'}</td>
                <td>${e.coefficient.toFixed(2)}</td>
                <td>${e.multiplicity}</td>
                <td>${(e.confidence * 100).toFixed(0)}%</td>
              </tr>`,
              )
              .join('')}
          </table>`
        : '<p style="color:var(--muted);font-size:12px">未识别到明显桩身缺陷反射</p>'
    }
    <div class="reasons"><b>判读理由：</b><ul style="margin:6px 0 0;padding-left:18px">${r.reasons.map((x) => `<li>${x}</li>`).join('')}</ul></div>
    ${r.rejectedBlows.length ? `<div class="reasons" style="border-left:3px solid var(--iv)"><b>剔除锤说明：</b><ul style="margin:6px 0 0;padding-left:18px">${r.rejectedBlows.map((x) => `<li>${x.blowId}：${x.reason}</li>`).join('')}</ul></div>` : ''}
    <div id="blowStack"></div>
  `;

  const stack = detailPanel.querySelector<HTMLDivElement>('#blowStack')!;
  stack.innerHTML = r.analyses
    .map((a) => `<div class="blow-card ${a.rejected ? 'rejected' : ''}"><canvas></canvas></div>`)
    .join('');
  // 等待 DOM 布局后绘制
  requestAnimationFrame(() => {
    stack.querySelectorAll<HTMLCanvasElement>('canvas').forEach((cv, i) => {
      drawWaveform(cv, r.analyses[i], m.designLength, r.waveSpeed);
    });
  });
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

renderFilters();

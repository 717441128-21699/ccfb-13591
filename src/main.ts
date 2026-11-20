/** 主应用：数据合成 → Worker 并行分析 → 平面图 + 单桩详情（波形/判读理由） */
import './styles.css';
import { WorkerPool } from './worker/pool';
import { CLASS_LABEL } from './lib/analyzer';
import type { IntegrityClass, PileResult, SyntheticPile } from './types';
import { drawPlan } from './ui/plan-canvas';
import { drawWave, drawOverlap } from './ui/wave-canvas';

const CLASS_COLOR: Record<IntegrityClass, string> = {
  1: '#4caf50',
  2: '#ffc107',
  3: '#ff9800',
  4: '#f44336',
};

interface AppState {
  piles: SyntheticPile[];
  results: Map<string, PileResult>;
  selectedId: string | null;
  running: boolean;
}

const state: AppState = {
  piles: [],
  results: new Map(),
  selectedId: null,
  running: false,
};

let pool: WorkerPool | null = null;

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel)!;

function el(tag: string, cls = ''): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function setStatus(text: string, progress?: number): void {
  $('.status-text').textContent = text;
  if (progress !== undefined) {
    $('.progress-bar > div').style.width = `${Math.round(progress * 100)}%`;
  }
}

/** 合成 + 分析整条流水线 */
async function runPipeline(count: number, seed: number): Promise<void> {
  if (state.running) return;
  state.running = true;
  setButtonsDisabled(true);
  state.results.clear();
  state.selectedId = null;

  try {
    setStatus('Worker 中合成波形（一维波动方程）…', 0.05);
    const t0 = performance.now();
    const { piles } = await WorkerPool.synthesize(count, seed, {
      classMix: { 1: 0.5, 2: 0.25, 3: 0.15, 4: 0.1 },
      badBlowRate: 0.2,
      headRingingRate: 0.2,
    });
    state.piles = piles;
    const synthMs = performance.now() - t0;
    setStatus(`合成完成（${synthMs.toFixed(0)}ms），开始并行分析…`, 0.15);

    pool ??= new WorkerPool();
    const t1 = performance.now();
    const results = await pool.analyzeAll(piles, (done, total) => {
      setStatus(`分析中 ${done}/${total}（${pool!.size} 个 Worker）`, 0.15 + 0.85 * (done / total));
    });
    const analysisMs = performance.now() - t1;
    for (const r of results) state.results.set(r.pileId, r);

    setStatus(`完成：合成 ${synthMs.toFixed(0)}ms，分析 ${analysisMs.toFixed(0)}ms（${(analysisMs / count).toFixed(1)}ms/桩）`, 1);
    renderPlan();
    renderSummary();
    renderDetail();
  } catch (err) {
    setStatus(`运行失败：${(err as Error).message}`, 0);
  } finally {
    state.running = false;
    setButtonsDisabled(false);
  }
}

function setButtonsDisabled(disabled: boolean): void {
  document.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach((b) => {
    b.disabled = disabled;
  });
}

function renderPlan(): void {
  const canvas = $('#plan-canvas') as HTMLCanvasElement;
  drawPlan(canvas, state.piles, state.results, state.selectedId, (id) => {
    state.selectedId = id;
    renderPlan();
    renderDetail();
  });
}

function renderSummary(): void {
  const counts: Record<IntegrityClass, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let questionable = 0;
  for (const r of state.results.values()) {
    counts[r.className]++;
    if (r.questionable) questionable++;
  }
  const box = $('#summary-chips');
  box.innerHTML = '';
  ([1, 2, 3, 4] as IntegrityClass[]).forEach((c) => {
    const chip = el('span', 'chip');
    chip.style.color = CLASS_COLOR[c];
    chip.textContent = `${CLASS_LABEL[c]} ${counts[c]} 根`;
    box.appendChild(chip);
  });
  const q = el('span', 'chip');
  q.style.color = '#ab47bc';
  q.textContent = `存疑 ${questionable} 根`;
  box.appendChild(q);
}

function renderDetail(): void {
  const wrap = $('#detail-wrap');
  wrap.innerHTML = '';
  const id = state.selectedId;
  if (!id) {
    wrap.appendChild(el('div', 'empty-hint')).innerHTML =
      '点击左侧平面图中的桩位查看详情<br/><br/>颜色：绿=Ⅰ类 黄=Ⅱ类 橙=Ⅲ类 红=Ⅳ类<br/>紫色虚环=存疑（需人工复核）';
    return;
  }
  const pile = state.piles.find((p) => p.id === id);
  const result = state.results.get(id);
  if (!pile || !result) return;

  // —— 基本信息 ——
  const info = el('div', 'detail-scroll');
  info.appendChild(section('基本信息'));
  const meta = el('div', 'meta-grid');
  const rows: [string, string][] = [
    ['桩号', pile.id],
    ['桩长 L', `${pile.designLength} m`],
    ['桩径', `Φ${(pile.diameter * 1000).toFixed(0)} mm`],
    ['混凝土', pile.concreteGrade],
    ['设计波速', `${pile.designWaveSpeed} m/s`],
    ['反算波速', `${result.waveSpeed.toFixed(0)} m/s`],
    ['实测桩长', Number.isNaN(result.measuredLength) ? '—' : `${result.measuredLength.toFixed(2)} m`],
    ['锤次', `${result.acceptedBlowIds.length} 有效 / ${pile.blows.length} 总`],
  ];
  for (const [k, v] of rows) {
    const kk = el('div', 'k');
    kk.textContent = k;
    const vv = el('div', 'v');
    vv.textContent = v;
    meta.append(kk, vv);
  }
  info.appendChild(meta);

  // —— 判定结论 ——
  info.appendChild(section('完整性判定'));
  const verdict = el('div');
  verdict.style.display = 'flex';
  verdict.style.alignItems = 'center';
  verdict.style.gap = '12px';
  const badge = el('span', 'class-badge');
  badge.style.background = CLASS_COLOR[result.className];
  badge.style.color = result.className === 2 ? '#3a2e00' : '#fff';
  badge.textContent = CLASS_LABEL[result.className];
  verdict.appendChild(badge);
  if (result.questionable) {
    const tag = el('span', 'qa-tag');
    tag.textContent = '存疑·需复核';
    verdict.appendChild(tag);
  }
  info.appendChild(verdict);

  // —— 缺陷列表 ——
  if (result.defects.length) {
    info.appendChild(section(`缺陷反射（${result.defects.length}）`));
    const table = el('table', 'defects');
    table.innerHTML =
      '<tr><th>类型</th><th>深度(m)</th><th>占桩长</th><th>R</th><th>相位</th><th>相关</th></tr>';
    for (const d of result.defects) {
      const tr = el('tr');
      tr.innerHTML =
        `<td>${d.kind}</td><td>${d.depth.toFixed(2)}</td>` +
        `<td>${(d.depth / pile.designLength * 100).toFixed(1)}%</td>` +
        `<td>${d.amplitudeRatio.toFixed(2)}</td>` +
        `<td style="color:${d.samePhase ? 'var(--same)' : 'var(--opp)'}">${d.samePhase ? '同相' : '反相'}</td>` +
        `<td>${d.correlation.toFixed(2)}</td>`;
      table.appendChild(tr);
    }
    info.appendChild(table);
  }

  // —— 判读理由 ——
  info.appendChild(section('判读理由'));
  const ul = el('ul', 'reasons');
  for (const reason of result.reasons) {
    const li = el('li');
    li.textContent = reason;
    ul.appendChild(li);
  }
  info.appendChild(ul);

  // —— 锤次处理 ——
  info.appendChild(section('多锤一致性与坏锤剔除'));
  const rejectLine = el('div', 'reasons');
  if (result.rejectedBlowIds.length) {
    rejectLine.textContent =
      '剔除锤：' + result.rejectedBlowIds.map((x) => `#${x.id}（${x.reason}）`).join('；');
  } else {
    rejectLine.textContent = '所有锤次均通过一致性检验，无坏锤剔除。';
  }
  info.appendChild(rejectLine);
  if (result.headRinging) {
    const ring = el('div', 'reasons');
    ring.style.color = '#ab47bc';
    ring.textContent = '⚠ 检出桩头高频振铃，桩头可能未凿净，浅部判读需谨慎。';
    info.appendChild(ring);
  }

  // —— 各锤波形 ——
  info.appendChild(section('各锤波形（速度 / 指数放大）'));
  const overlap = document.createElement('canvas');
  overlap.className = 'wave';
  info.appendChild(overlap);
  for (const ba of result.blowAnalyses) {
    const card = el('div', 'blow-card');
    const head = el('div', 'blow-head');
    const left = el('span');
    left.textContent = `锤 #${ba.blowId}　SNR ${ba.snrDb.toFixed(1)}dB${ba.headRinging ? '　振铃' : ''}`;
    const right = el('span', ba.accepted ? '' : 'rejected');
    right.textContent = ba.accepted
      ? `波速 ${ba.waveSpeed.toFixed(0)} m/s`
      : `已剔除：${ba.rejectReason}`;
    head.append(left, right);
    card.appendChild(head);
    const c1 = document.createElement('canvas');
    c1.className = 'wave';
    const c2 = document.createElement('canvas');
    c2.className = 'wave';
    card.append(c1, c2);
    info.appendChild(card);
    // 延迟到插入 DOM 后绘制（clientWidth 才有效）
    queueMicrotask(() => {
      drawWave(c1, {
        data: ba.velocity,
        sampleRate: inferRate(),
        incidentIdx: ba.incidentIndex,
        events: ba.defects,
        toe: ba.toe,
        title: `积分速度（原始）`,
        yLabel: 'v',
      });
      drawWave(c2, {
        data: ba.amplified,
        sampleRate: inferRate(),
        incidentIdx: ba.incidentIndex,
        events: ba.defects,
        toe: ba.toe,
        title: '指数放大速度',
        yLabel: 'v×G',
      });
    });
  }
  queueMicrotask(() => {
    drawOverlap(overlap, result.blowAnalyses);
  });

  wrap.appendChild(info);
}

function inferRate(): number {
  // 合成端输出采样率固定为 25kHz
  return 25000;
}

function section(title: string): HTMLElement {
  const s = el('div', 'section-title');
  s.textContent = title;
  return s;
}

// —— 事件绑定 ——
function init(): void {
  $('#btn-run').addEventListener('click', () => {
    const count = Number(($('#pile-count') as HTMLInputElement).value) || 300;
    const seed = Number(($('#seed') as HTMLInputElement).value) || 20261120;
    void runPipeline(count, seed);
  });
  $('#btn-demo300').addEventListener('click', () => {
    ($('#pile-count') as HTMLInputElement).value = '300';
    void runPipeline(300, 20261120);
  });
  $('#btn-export').addEventListener('click', exportReport);
  window.addEventListener('resize', () => {
    if (state.piles.length) renderPlan();
  });
}

function exportReport(): void {
  if (!state.results.size) {
    setStatus('暂无可导出的分析结果');
    return;
  }
  const lines: string[] = ['桩号,完整性类别,存疑,反算波速(m/s),缺陷数,缺陷类型与深度,判读理由'];
  for (const pile of state.piles) {
    const r = state.results.get(pile.id);
    if (!r) continue;
    const defects = r.defects.map((d) => `${d.kind}@${d.depth.toFixed(2)}m(R${d.amplitudeRatio.toFixed(2)})`).join(';');
    const reason = r.reasons.join('；').replace(/,/g, '，');
    lines.push(
      [pile.id, CLASS_LABEL[r.className], r.questionable ? '是' : '否', r.waveSpeed.toFixed(0), r.defects.length, defects, reason]
        .map((x) => `"${x}"`)
        .join(','),
    );
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `低应变分析报告_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

init();

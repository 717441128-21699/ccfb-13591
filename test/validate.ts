// Node 验证脚本（node test/validate.ts，Node 24 原生支持 TS 类型擦除）
// 验收指标：
//   1. 缺陷深度误差 ≤ 桩长 5%（p95）
//   2. IV 类桩零漏判（召回率 100%）
//   3. 波速反演误差 ≤ 5%
//   4. 300 根桩全部分析 ≤ 60s（Node 单线程基线，浏览器 Worker 并行更快）

import { generateSite } from '../src/core/siteGenerator.ts';
import { analyzePile } from '../src/core/consistency.ts';
import type { PileReport } from '../src/core/types.ts';

const PILE_COUNT = Number(process.argv[2] ?? 300);

console.log(`生成 ${PILE_COUNT} 根桩的合成工地（一维波动方程）...`);
const t0 = performance.now();
const SEED = Number(process.env.SEED ?? 20261121);
const site = generateSite(PILE_COUNT, SEED);
const genMs = performance.now() - t0;
console.log(`合成耗时 ${genMs.toFixed(0)} ms\n`);

const reports: PileReport[] = [];
const t1 = performance.now();
for (const test of site.tests) {
  const gt = site.groundTruths.get(test.meta.id);
  reports.push(analyzePile(test.meta, test.blows, gt));
}
const analyzeMs = performance.now() - t1;

// ---------- 指标 1：缺陷深度误差 ----------
interface DepthError {
  pileId: string;
  type: string;
  trueDepth: number;
  predDepth: number;
  relPercent: number;
}
const depthErrors: DepthError[] = [];
const missedDefects: string[] = [];

for (const r of reports) {
  const gt = r.groundTruth!;
  const L = r.meta.designLength;
  for (const d of gt.defects) {
    const candidates = r.events.filter((e) => e.defectType !== 'toe');
    // 相位兼容：缩颈/夹泥/断桩同为阻抗减小（同相），扩径为阻抗增大（反相）
    const gtReduces = d.type !== 'bulge';
    const compatible = candidates.filter((e) =>
      gtReduces ? e.phase === 'in' : e.phase === 'out',
    );
    const pool = compatible.length > 0 ? compatible : candidates;
    // 仅在桩长 25% 邻域内匹配，超出视为漏判，杜绝远距离错配
    const near = pool
      .map((e) => ({ e, dist: Math.abs(e.depth - d.depth) }))
      .filter((x) => x.dist <= L * 0.25)
      .sort((a, b) => a.dist - b.dist)[0];
    if (!near) {
      missedDefects.push(`${r.pileId} 漏判 ${d.type}@${d.depth}m`);
      continue;
    }
    depthErrors.push({
      pileId: r.pileId,
      type: d.type === near.e.defectType ? d.type : `${d.type}->${near.e.defectType}`,
      trueDepth: d.depth,
      predDepth: near.e.depth,
      relPercent: (near.dist / L) * 100,
    });
  }
}

const sorted = [...depthErrors].sort((a, b) => b.relPercent - a.relPercent);
const p50 = percentile(sorted.map((d) => d.relPercent), 50);
const p95 = percentile(sorted.map((d) => d.relPercent), 95);
const maxErr = sorted[0];
const within5 = depthErrors.filter((d) => d.relPercent <= 5).length;

// ---------- 指标 2：IV 类召回 ----------
const ivPiles = site.tests.filter(
  (t) => site.expectedClasses.get(t.meta.id) === 'IV',
);
const ivReports = reports.filter((r) =>
  ivPiles.some((t) => t.meta.id === r.pileId),
);
const ivDetected = ivReports.filter((r) => r.finalClass === 'IV');
const ivMissed = ivReports.filter((r) => r.finalClass !== 'IV');

// ---------- 指标 3：波速误差 ----------
const speedErrors = reports
  .filter((r) => r.waveSpeed !== null)
  .map((r) => Math.abs(r.waveSpeed! - r.groundTruth!.waveSpeed) / r.groundTruth!.waveSpeed * 100);
const speedP95 = percentile(speedErrors, 95);
const speedMax = Math.max(...speedErrors);

// ---------- 指标 4：耗时 ----------
const totalMs = genMs + analyzeMs;

// ---------- 类别分布 ----------
const classDist = new Map<string, number>();
for (const r of reports) classDist.set(r.finalClass, (classDist.get(r.finalClass) ?? 0) + 1);
const expectedDist = new Map<string, number>();
for (const [, c] of site.expectedClasses) expectedDist.set(c, (expectedDist.get(c) ?? 0) + 1);

// ---------- 输出 ----------
console.log('================ 验收指标 ================');
console.log(
          `[1] 缺陷深度误差：p50=${p50.toFixed(2)}%  p95=${p95.toFixed(2)}%  最大=${maxErr.relPercent.toFixed(2)}%` +
          `（${maxErr.pileId} ${maxErr.type} 真值${maxErr.trueDepth.toFixed(1)}m 判${maxErr.predDepth.toFixed(1)}m）`,
);
console.log(
          `    误差≤5%占比：${within5}/${depthErrors.length} = ${((within5 / depthErrors.length) * 100).toFixed(1)}%；漏判事件 ${missedDefects.length} 个`,
);
console.log(
          `[2] IV 类召回：${ivDetected.length}/${ivPiles.length} = ${((ivDetected.length / ivPiles.length) * 100).toFixed(1)}%` +
          `（漏判 ${ivMissed.map((r) => r.pileId).join(',') || '无'}）`,
);
console.log(
          `[3] 波速反演误差：p95=${speedP95.toFixed(2)}%  最大=${speedMax.toFixed(2)}%（n=${speedErrors.length}）`,
);
console.log(
          `[4] 总耗时：合成 ${genMs.toFixed(0)}ms + 分析 ${analyzeMs.toFixed(0)}ms = ${totalMs.toFixed(0)}ms` +
          `（单桩均值 ${(analyzeMs / PILE_COUNT).toFixed(2)}ms，限额 60000ms）`,
);
console.log('[5] 类别分布：');
console.log(`    预期：${[...expectedDist.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log(`    实判：${[...classDist.entries()].sort().map(([k, v]) => `${k}=${v}`).join('  ')}`);

const questionable = reports.filter((r) => r.questionable).length;
const ringing = reports.filter((r) => r.headRinging.detected).length;
const rejected = reports.reduce((s, r) => s + r.rejectedBlows.length, 0);
console.log(
          `[6] 疑问桩 ${questionable} 根 | 识别桩头浮浆 ${ringing} 根 | 累计剔除坏锤 ${rejected} 锤`,
);

console.log('\n================ 误差最大的 10 个事件 ================');
for (const d of sorted.slice(0, 10)) {
  console.log(
            `${d.pileId}  ${d.type.padEnd(16)} 真值 ${d.trueDepth.toFixed(2)}m  判 ${d.predDepth.toFixed(2)}m  误差 ${d.relPercent.toFixed(2)}%`,
  );
}
if (missedDefects.length) {
  console.log('\n漏判事件：');
  missedDefects.forEach((m) => console.log('  ' + m));
}

// ---------- 合格判定 ----------
const pass =
  p95 <= 5 &&
  ivDetected.length === ivPiles.length &&
  speedP95 <= 5 &&
  analyzeMs <= 60000 &&
  missedDefects.length === 0;
console.log(`\n结论：${pass ? '✅ 全部达标' : '❌ 存在未达标项'}`);
process.exit(pass ? 0 : 1);

function percentile(x: number[], p: number): number {
  const s = [...x].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, idx)];
}

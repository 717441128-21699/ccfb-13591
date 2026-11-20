// 单桩诊断调试：node test/debug.ts
import { synthesizePile } from '../src/core/synthesis.ts';
import { analyzeBlow } from '../src/core/analyzer.ts';
import { analyzePile } from '../src/core/consistency.ts';
import { detectHeadRinging } from '../src/core/headRinging.ts';
import type { PileMeta } from '../src/core/types.ts';

function makeMeta(over: Partial<PileMeta> = {}): PileMeta {
  return {
    id: 'DBG',
    x: 0,
    y: 0,
    designLength: 20,
    diameter: 0.8,
    concreteGrade: 'C30',
    toeCondition: 'friction',
    ...over,
  };
}

function diag(name: string, opts: Parameters<typeof synthesizePile>[1]) {
  const meta = makeMeta();
  const synth = synthesizePile(meta, opts);
  console.log(`\n========== ${name} ==========`);
  for (const blow of synth.blows) {
    const a = analyzeBlow(blow, meta);
    console.log(
      `  ${blow.id} doubleHit=${a.doubleHit} toeTT=${a.toeTravelTime?.toFixed(5) ?? 'null'} c=${a.waveSpeed?.toFixed(0) ?? 'null'} toeConf=${a.toeConfidence.toFixed(2)}`,
    );
    console.log(
      `    ringing: det=${a.headRinging.detected} centroid=${a.headRinging.spectralCentroid.toFixed(0)}Hz hi=${(a.headRinging.highFreqRatio * 100).toFixed(0)}% zcr=${a.headRinging.zeroCrossingRate.toFixed(2)}`,
    );
    for (const e of a.events) {
      console.log(
        `    event ${e.defectType.padEnd(11)} phase=${e.phase} depth=${e.depth.toFixed(2)}m beta=${e.coefficient.toFixed(2)} mult=${e.multiplicity} conf=${e.confidence.toFixed(2)}`,
      );
    }
  }
  const report = analyzePile(meta, synth.blows, synth.groundTruth);
  console.log(
    `  FINAL class=${report.finalClass} valid=${report.validBlows}/${report.totalBlows} c=${report.waveSpeed?.toFixed(0) ?? 'null'} sims=[${report.analyses.map((a) => a.similarity.toFixed(2)).join(',')}]`,
  );
  for (const r of report.rejectedBlows) console.log(`    rejected: ${r.blowId} ${r.reason}`);
  for (const e of report.events) {
    console.log(
    `  FUSED ${e.defectType.padEnd(11)} depth=${e.depth.toFixed(2)}m beta=${e.coefficient.toFixed(2)} mult=${e.multiplicity} conf=${e.confidence.toFixed(2)}`,
    );
  }
}

diag('完整桩 I 类', { seed: 1 });
diag('浅部缩颈 3m', { seed: 2, defects: [{ type: 'neck', depth: 3, length: 0.6, impedanceRatio: 0.75 }] });
diag('扩径 5m', { seed: 3, defects: [{ type: 'bulge', depth: 5, length: 0.8, impedanceRatio: 1.25 }] });
diag('夹泥 8m III', { seed: 4, defects: [{ type: 'segregation', depth: 8, length: 0.8, impedanceRatio: 0.5 }] });
diag('断桩 6m IV', { seed: 5, defects: [{ type: 'break', depth: 6, length: 0.4, impedanceRatio: 0.03 }] });
diag('断桩 14m IV', { seed: 6, defects: [{ type: 'break', depth: 14, length: 0.4, impedanceRatio: 0.04 }] });
diag('桩头浮浆(完整桩)', { seed: 7, headRinging: true });
diag('双击(完整桩)', { seed: 8, doubleHit: true });

// 直接查看干净/浮浆信号的高频指标（用于校准 ringing 阈值）
console.log('\n========== 干净桩 ringing 指标采样 ==========');
for (let seed = 100; seed < 110; seed++) {
  const meta = makeMeta();
  const synth = synthesizePile(meta, { seed });
  const r = detectHeadRinging(synth.blows[0].acceleration, synth.dt, 3600);
  console.log(`seed=${seed} share=${(r.highFreqRatio * 100).toFixed(1)}% zcr=${r.zeroCrossingRate.toFixed(2)} det=${r.detected}`);
}
console.log('\n========== 浮浆桩 ringing 指标采样 ==========');
for (let seed = 200; seed < 210; seed++) {
  const meta = makeMeta();
  const synth = synthesizePile(meta, { seed, headRinging: true });
  const r = detectHeadRinging(synth.blows[0].acceleration, synth.dt, 3600);
  console.log(`seed=${seed} share=${(r.highFreqRatio * 100).toFixed(1)}% zcr=${r.zeroCrossingRate.toFixed(2)} det=${r.detected}`);
}

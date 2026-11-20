/** 端到端冒烟测试：合成 → 分析 → 关键不变量校验（Node 环境，复用与 Worker 相同的核心模块） */
import { synthesizeSite } from '../src/lib/synthesizer';
import { analyzePile, CLASS_LABEL } from '../src/lib/analyzer';

const piles = synthesizeSite({
  count: 50,
  seed: 777,
  classMix: { 1: 0.4, 2: 0.3, 3: 0.15, 4: 0.15 },
  badBlowRate: 0.2,
  headRingingRate: 0.2,
});

let ivTruth = 0;
let ivCaught = 0;
let invariantFailures = 0;

for (const pile of piles) {
  const r = analyzePile(pile);

  // 不变量 1：所有桩都有合法类别
  if (![1, 2, 3, 4].includes(r.className)) {
    console.error(`✗ ${pile.id} 非法类别 ${r.className as number}`);
    invariantFailures++;
  }
  // 不变量 2：波速在物理范围
  if (r.waveSpeed < 2000 || r.waveSpeed > 5000) {
    console.error(`✗ ${pile.id} 波速越界 ${r.waveSpeed}`);
    invariantFailures++;
  }
  // 不变量 3：缺陷深度为正且不超过桩长 1.1 倍
  for (const d of r.defects) {
    if (d.depth <= 0 || d.depth > pile.designLength * 1.1 || !Number.isFinite(d.depth)) {
      console.error(`✗ ${pile.id} 非法缺陷深度 ${d.depth}`);
      invariantFailures++;
    }
    if (Math.abs(d.amplitudeRatio) > 1 || !Number.isFinite(d.amplitudeRatio)) {
      console.error(`✗ ${pile.id} 非法反射系数 ${d.amplitudeRatio}`);
      invariantFailures++;
    }
  }
  // 不变量 4：每个有效锤都有波形数据
  for (const ba of r.blowAnalyses) {
    if (ba.velocity.length === 0 || ba.amplified.length === 0) {
      console.error(`✗ ${pile.id} 锤${ba.blowId} 波形为空`);
      invariantFailures++;
    }
  }

  if (pile.truth.className === 4) {
    ivTruth++;
    if (r.className === 4) ivCaught++;
  }
}

const dist = [1, 2, 3, 4].map((c) => `${CLASS_LABEL[c as 1]}=${piles.filter((p) => analyzePile(p).className === c).length}`);
console.log('50 桩分类分布:', dist.join(' '));
console.log(`Ⅳ 类召回: ${ivCaught}/${ivTruth}`);
console.log(`不变量校验失败: ${invariantFailures}`);
if (invariantFailures > 0 || ivCaught !== ivTruth) {
  console.error('冒烟测试失败');
  process.exit(1);
}
console.log('✅ 端到端冒烟测试通过');

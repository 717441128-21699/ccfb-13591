// 性能基准：300 根桩分析耗时（Node 单线程基线，浏览器多 Worker 应更快）
import { generateSite } from '../src/core/siteGenerator.ts';
import { analyzePile } from '../src/core/consistency.ts';

const N = Number(process.argv[2] ?? 300);
const site = generateSite(N);

// 预热
analyzePile(site.tests[0].meta, site.tests[0].blows);

const t0 = performance.now();
for (const test of site.tests) {
  analyzePile(test.meta, test.blows);
}
const elapsed = performance.now() - t0;

console.log(`单线程分析 ${N} 根桩：${elapsed.toFixed(0)} ms`);
console.log(`单桩均值：${(elapsed / N).toFixed(3)} ms`);
console.log(`吞吐：${((N / elapsed) * 1000).toFixed(0)} 桩/秒`);
console.log(`限额 60000ms：${elapsed < 60000 ? '达标 ✅' : '超标 ❌'}（余量 ${(60000 / elapsed).toFixed(1)} 倍）`);

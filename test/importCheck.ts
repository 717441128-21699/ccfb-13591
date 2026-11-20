import { buildImportTemplate, CSV_TEMPLATE } from '../src/core/template.ts';
import { parsePileData } from '../src/core/importer.ts';
import { analyzePile } from '../src/core/consistency.ts';

const json = parsePileData(buildImportTemplate(), 't.json');
console.log('JSON 导入：桩数=' + json.tests.length + ' 错误=' + json.errors.length);
for (const t of json.tests) {
  const r = analyzePile(t.meta, t.blows);
  console.log('  ' + t.meta.id + ' 锤=' + t.blows.length + ' 点/锤=' + t.blows[0].acceleration.length + ' 判定=' + r.finalClass + ' 波速=' + r.waveSpeed?.toFixed(0));
}
const csv = parsePileData(CSV_TEMPLATE, 't.csv');
console.log('CSV 模板（占位数据预期报错）：桩数=' + csv.tests.length + ' 错误数=' + csv.errors.length);

// 生成实测数据导入模板（JSON 字符串），供现场仪器数据对照转换
import { synthesizePile } from './synthesis.ts';
import type { PileMeta } from './types.ts';

export function buildImportTemplate(): string {
  const metas: PileMeta[] = [
    {
      id: 'S-001',
      x: 0,
      y: 0,
      designLength: 18,
      diameter: 0.8,
      concreteGrade: 'C30',
      toeCondition: 'friction',
    },
    {
      id: 'S-002',
      x: 6,
      y: 0,
      designLength: 22,
      diameter: 1.0,
      concreteGrade: 'C35',
      toeCondition: 'socketed',
    },
  ];
  const piles = metas.map((meta, i) => {
    const synth = synthesizePile(meta, { seed: 900 + i, blowCount: 4 });
    return {
      meta,
      blows: synth.blows.map((b) => ({
        id: b.id,
        dt: b.dt,
        acceleration: Array.from(b.acceleration),
      })),
    };
  });
  return JSON.stringify({ piles }, null, 2);
}

export const CSV_TEMPLATE = `# 基桩低应变数据 CSV 模板
# META,pileId,x,y,designLength,diameter,concreteGrade,toeCondition(friction|socketed)
# BLOW,blowId,dt(seconds)
# 下一行为加速度序列(m/s²)，逗号分隔
META,S-001,0,0,18,0.8,C30,friction
BLOW,S-001-B1,0.00008
0,0,0.01,-0.02,...（此处替换为仪器导出的加速度采样点）
BLOW,S-001-B2,0.00008
0,0,0.01,-0.02,...
`;

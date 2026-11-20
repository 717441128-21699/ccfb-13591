// 演示工地生成：按平面图布置 300 根桩，按一维波动方程逐桩合成波形
// 缺陷分布覆盖 I~IV 类与桩头浮浆、双击、坏锤等现场工况，真值随报告返回用于验证

import type {
  DefectSpec,
  DefectType,
  PileMeta,
  PileReport,
  PileTest,
  SynthesisOptions,
  ToeCondition,
} from './types.ts';
import { synthesizePile, referenceWaveSpeed } from './synthesis.ts';
import { mulberry32 } from './dsp.ts';

export interface GeneratedSite {
  tests: PileTest[];
  groundTruths: Map<string, PileReport['groundTruth']>;
  /** 每根桩的设计预期类别（由合成参数决定，用于核对） */
  expectedClasses: Map<string, string>;
}

const GRADES = ['C25', 'C30', 'C35', 'C40'];
const SPACING = 6; // 平面桩间距 m
const COLS = 20;

export function generateSite(pileCount = 300, seed = 20261121): GeneratedSite {
  const rng = mulberry32(seed);
  const tests: PileTest[] = [];
  const groundTruths = new Map<string, PileReport['groundTruth']>();
  const expectedClasses = new Map<string, string>();

  for (let k = 0; k < pileCount; k++) {
    const col = k % COLS;
    const row = Math.floor(k / COLS);
    const id = `Z-${String(row + 1).padStart(2, '0')}-${String(col + 1).padStart(2, '0')}`;
    const length = round1(14 + rng() * 16); // 14~30m
    const diameter = rng() > 0.5 ? 0.8 : 1.0;
    const grade = GRADES[Math.floor(rng() * GRADES.length)];
    const toeCondition: ToeCondition = rng() > 0.82 ? 'socketed' : 'friction';

    const meta: PileMeta = {
      id,
      x: col * SPACING,
      y: row * SPACING,
      designLength: length,
      diameter,
      concreteGrade: grade,
      toeCondition,
    };

    // 真实波速围绕强度等级参考值波动 ±6%
    const trueC = referenceWaveSpeed(grade) * (0.94 + rng() * 0.12);

    // 缺陷工况分布（保证 IV 类样本充足，验证不许漏判）
    const roll = rng();
    let defects: DefectSpec[] = [];
    let expected = 'I';
    let headRinging = false;
    let doubleHit = false;

    if (roll < 0.34) {
      // 完整桩 I 类
      expected = 'I';
    } else if (roll < 0.56) {
      // 轻微缩颈/扩径 II 类（阻抗变化约 15~30%，反射处于可检测区间）
      const type: DefectType = rng() > 0.45 ? 'neck' : 'bulge';
      const ratio = type === 'neck' ? 0.7 + rng() * 0.12 : 1.15 + rng() * 0.18;
      defects = [
        {
          type,
          depth: round1(2.5 + rng() * (length - 5)),
          length: round1(0.6 + rng() * 0.8),
          impedanceRatio: round2(ratio),
        },
      ];
      expected = 'II';
    } else if (roll < 0.76) {
      // 夹泥/离析或明显缩颈 III 类
      const type: DefectType = rng() > 0.4 ? 'segregation' : 'neck';
      const ratio =
        type === 'segregation' ? 0.45 + rng() * 0.2 : 0.6 + rng() * 0.15;
      defects = [
        {
          type,
          depth: round1(2 + rng() * (length - 6)),
          length: round1(0.5 + rng() * 0.8),
          impedanceRatio: round2(ratio),
        },
      ];
      expected = 'III';
    } else if (roll < 0.9) {
      // 断桩 IV 类（浅/中/深各位置都要有）
      defects = [
        {
          type: 'break',
          depth: round1(1.8 + rng() * (length - 4.5)),
          length: round1(0.3 + rng() * 0.5),
          impedanceRatio: round2(0.12 + rng() * 0.08),
        },
      ];
      expected = 'IV';
    } else {
      // 复合缺陷 + 异常工况
      headRinging = rng() > 0.4;
      doubleHit = rng() > 0.5;
      if (rng() > 0.45) {
        // 双缺陷：浅部缩颈 + 深部夹泥
        defects = [
          {
            type: 'neck',
            depth: round1(2 + rng() * 3),
            length: round1(0.5),
            impedanceRatio: round2(0.7 + rng() * 0.1),
          },
          {
            type: 'segregation',
            depth: round1(length * 0.55 + rng() * length * 0.25),
            length: round1(0.6 + rng() * 0.6),
            impedanceRatio: round2(0.4 + rng() * 0.2),
          },
        ];
        expected = 'III';
      } else {
        defects = [
          {
            type: 'break',
            depth: round1(2 + rng() * (length - 5)),
            length: round1(0.4),
            impedanceRatio: round2(0.12 + rng() * 0.06),
          },
        ];
        expected = 'IV';
      }
    }

    const opts: SynthesisOptions = {
      seed: seed + k * 104729,
      defects,
      trueWaveSpeed: trueC,
      headRinging,
      doubleHit,
      blowCount: 4,
      noiseLevel: 0.006 + rng() * 0.009,
    };

    const synth = synthesizePile(meta, opts);
    tests.push({ meta, blows: synth.blows });
    groundTruths.set(id, { waveSpeed: trueC, defects });
    expectedClasses.set(id, expected);
  }

  return { tests, groundTruths, expectedClasses };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

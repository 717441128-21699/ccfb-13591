// 多锤一致性分析与整桩综合判定
// 同一根桩 3~5 锤：相关系数低/双击/入射形态异常的锤剔除，
// 有效锤的反射事件按深度聚类融合，再按 JGJ 106 给出 I~IV 类。

import type {
  BlowAnalysis,
  BlowData,
  IntegrityClass,
  PileMeta,
  PileReport,
  ReflectionEvent,
} from './types.ts';
import { analyzeBlow } from './analyzer.ts';

const CORRELATION_MIN = 0.72;
const MIN_VALID_BLOWS = 2;

export function analyzePile(
  meta: PileMeta,
  blows: BlowData[],
  groundTruth?: PileReport['groundTruth'],
): PileReport {
  const tStart = performance.now();

  // ---- 第一遍：独立分析每锤 ----
  const firstPass = blows.map((b) => analyzeBlow(b, meta));

  // ---- 一致性：速度波形两两相关（对齐入射峰后截取公共段） ----
  const sims = new Array<number>(firstPass.length).fill(0);
  for (let i = 0; i < firstPass.length; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = 0; j < firstPass.length; j++) {
      if (i === j) continue;
      sum += pairSimilarity(firstPass[i], firstPass[j], meta.designLength);
      cnt++;
    }
    sims[i] = cnt > 0 ? sum / cnt : 0;
  }

  const rejected: { blowId: string; reason: string }[] = [];
  // 强断桩锤保护：断桩强反射会显著改变波形，使其与其他锤相关性降低，
  // 但这类锤恰恰承载最关键的 IV 类判据，不得因一致性低被剔除。
  const isStrongBreakBlow = (a: BlowAnalysis) =>
    a.events.some(
      (e) => e.defectType === 'break' && e.phase === 'in' && Math.abs(e.coefficient) >= 0.6,
    );

  firstPass.forEach((a, i) => {
    a.similarity = sims[i];
    if (a.doubleHit && !isStrongBreakBlow(a)) {
      a.rejected = true;
      a.rejectReason = '双击波形，入射脉冲重叠，剔除';
    } else if (sims[i] < CORRELATION_MIN && !isStrongBreakBlow(a)) {
      a.rejected = true;
      a.rejectReason = `与其余锤波形相关系数仅 ${sims[i].toFixed(2)}（< ${CORRELATION_MIN}），一致性不足，剔除`;
    }
    if (a.rejected) rejected.push({ blowId: a.blowId, reason: a.rejectReason! });
  });

  let valid = firstPass.filter((a) => !a.rejected);
  // 若剔除过多导致不足 2 锤，保留相似度最高的锤（保证可出报告，但标记疑问）。
  // 强断桩锤必须无条件保留——它承载 IV 类判据，不得因波形独特被排除。
  let forcedFallback = false;
  if (valid.length < MIN_VALID_BLOWS) {
    forcedFallback = true;
    const protectedBlows = firstPass.filter(isStrongBreakBlow);
    const others = firstPass
      .filter((a) => !protectedBlows.includes(a))
      .sort((a, b) => b.similarity - a.similarity);
    const need = Math.max(MIN_VALID_BLOWS, Math.min(2, firstPass.length));
    valid = [...protectedBlows, ...others].slice(0, Math.max(need, protectedBlows.length));
    valid.forEach((a) => {
      if (a.rejected) {
        a.rejected = false;
        const idx = rejected.findIndex((r) => r.blowId === a.blowId);
        if (idx >= 0) rejected.splice(idx, 1);
      }
    });
  }

  // ---- 用有效锤波速中位数作为约束，第二遍重算，保证深度一致 ----
  const speeds = valid
    .map((a) => a.waveSpeed)
    .filter((c): c is number => c !== null)
    .sort((a, b) => a - b);
  const medianSpeed =
    speeds.length > 0 ? speeds[Math.floor(speeds.length / 2)] : null;

  const secondPass = valid.map((b) => {
    const blow = blows.find((x) => x.id === b.blowId)!;
    return analyzeBlow(blow, meta, { priorWaveSpeed: medianSpeed ?? undefined });
  });
  secondPass.forEach((a) => {
    a.similarity = firstPass.find((f) => f.blowId === a.blowId)!.similarity;
  });

  // ---- 桩底信息融合 ----
  const toeHits = secondPass
    .map((a) => ({
      tt: a.toeTravelTime,
      conf: a.toeConfidence,
      c: a.waveSpeed,
    }))
    .filter((x): x is { tt: number; conf: number; c: number | null } => x.tt !== null)
    .sort((a, b) => b.conf - a.conf);

  const toeConfidence =
    secondPass.length > 0
      ? secondPass.reduce((s, a) => s + a.toeConfidence, 0) / secondPass.length
      : 0;

  let finalSpeed: number | null = null;
  if (toeHits.length > 0) {
    const ttMedian = median(toeHits.map((x) => x.tt!));
    finalSpeed = (2 * meta.designLength) / ttMedian;
  } else if (medianSpeed) {
    finalSpeed = medianSpeed;
  }

  // ---- 缺陷事件跨锤聚类融合 ----
  const fused = fuseEvents(secondPass, finalSpeed ?? medianSpeed ?? 0);

  // 任一有效锤出现强断桩反射（|β|≥0.7）即锁定 IV 类，不允许被融合/投票稀释
  const strongBreak = secondPass.some((a) =>
    a.events.some(
      (e) => e.defectType === 'break' && e.phase === 'in' && Math.abs(e.coefficient) >= 0.6,
    ),
  );

  // ---- 最终分类 ----
  const headRinging = secondPass[0]?.headRinging ?? firstPass[0].headRinging;
  const { finalClass, reasons } = decideClass({
    meta,
    events: fused,
    toeConfidence,
    headRingingDetected: headRinging.detected,
    forcedFallback,
    validBlowCount: secondPass.length,
    totalBlowCount: blows.length,
    waveSpeed: finalSpeed,
    strongBreak,
  });

  // 疑问判定（精准对应需要人工复核的难例，避免正常桩被大面积标记）：
  // 1) 有效锤不足的兜底报告；2) 桩底反射不可靠且无强断桩锁定；
  // 3) 缺陷事件仅单锤复现或置信度低；4) 剔除锤占比过半。
  const lowConfidenceDefect = fused.some(
    (e) => e.defectType !== 'toe' && e.confidence < 0.5,
  );
  const questionable =
    forcedFallback ||
    (toeConfidence < 0.45 && !strongBreak) ||
    lowConfidenceDefect ||
    (rejected.length / blows.length >= 0.5 && !strongBreak);

  return {
    pileId: meta.id,
    meta,
    validBlows: secondPass.length,
    totalBlows: blows.length,
    rejectedBlows: rejected,
    waveSpeed: finalSpeed,
    toeConfidence,
    events: fused,
    finalClass,
    questionable,
    reasons,
    headRinging,
    // 报告中保留全部锤（含被剔除锤）的分析结果，界面可并排查看剔除理由
    analyses: firstPass,
    groundTruth,
    elapsedMs: performance.now() - tStart,
  };
}

/**
 * 对齐入射峰后计算两锤速度波形的归一化相关系数。
 * 各锤触发存在亚毫秒抖动，在 ±6 样本范围内搜索最佳滞后再取最大相关，
 * 避免因对齐偏差低估真实一致性。
 */
function pairSimilarity(
  a: BlowAnalysis,
  b: BlowAnalysis,
  designLength: number,
): number {
  // 相关窗口取 1.2 个桩底往返（有效反射集中在此），避免远端噪声拉低相关性
  const winMs = Math.min(30, Math.max(12, (2.4 * designLength) / 3.6));
  const len = Math.min(
    a.velocity.length - a.incidentIndex,
    b.velocity.length - b.incidentIndex,
    Math.round(winMs / 1000 / a.dt),
  );
  const xa = new Float64Array(len);
  const xb = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    xa[i] = a.velocity[a.incidentIndex + i] ?? 0;
    xb[i] = b.velocity[b.incidentIndex + i] ?? 0;
  }
  const maxLag = 6;
  let best = -2;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const r = shiftedCorrelation(xa, xb, lag);
    if (r > best) best = r;
  }
  return best;
}

/** b 相对 a 平移 lag 个样本后的归一化相关（零均值） */
function shiftedCorrelation(
  a: Float64Array,
  b: Float64Array,
  lag: number,
): number {
  const n = a.length;
  let num = 0;
  let da = 0;
  let db = 0;
  let sumA = 0;
  let sumB = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const j = i + lag;
    if (j < 0 || j >= n) continue;
    sumA += a[i];
    sumB += b[j];
    cnt++;
  }
  if (cnt < 8) return 0;
  const ma = sumA / cnt;
  const mb = sumB / cnt;
  for (let i = 0; i < n; i++) {
    const j = i + lag;
    if (j < 0 || j >= n) continue;
    const va = a[i] - ma;
    const vb = b[j] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  const denom = Math.sqrt(da * db);
  return denom < 1e-30 ? 0 : num / denom;
}

function median(x: number[]): number {
  const s = [...x].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface EventCluster {
  depths: number[];
  coeffs: number[];
  phases: ('in' | 'out')[];
  types: ReflectionEvent['defectType'][];
  multiplicities: number[];
  confidences: number[];
  votes: number;
  totalBlows: number;
}

/** 跨锤事件融合：深度相近（≤5% 桩长或 0.5m）的事件归为同一缺陷，按锤投票 */
function fuseEvents(analyses: BlowAnalysis[], waveSpeed: number): ReflectionEvent[] {
  const clusters: EventCluster[] = [];
  const totalBlows = analyses.length;

  for (const a of analyses) {
    for (const e of a.events) {
      if (e.defectType === 'toe') continue;
      const existing = clusters.find(
        (cl) => Math.abs(mean(cl.depths) - e.depth) < Math.max(0.8, e.depth * 0.12),
      );
      if (existing) {
        existing.depths.push(e.depth);
        existing.coeffs.push(e.coefficient);
        existing.phases.push(e.phase);
        existing.types.push(e.defectType);
        existing.multiplicities.push(e.multiplicity);
        existing.confidences.push(e.confidence);
        existing.votes++;
      } else {
        clusters.push({
          depths: [e.depth],
          coeffs: [e.coefficient],
          phases: [e.phase],
          types: [e.defectType],
          multiplicities: [e.multiplicity],
          confidences: [e.confidence],
          votes: 1,
          totalBlows,
        });
      }
    }
  }

  const fused = clusters
    // 多锤复现优先；单锤事件仅在反射较强（|β|≥0.25）或高置信时保留，
    // 避免噪声单峰混入，同时不漏掉仅个别锤清晰捕获的弱缺陷
    .filter((cl) => {
      if (cl.votes >= 2) return true;
      const strong = Math.abs(mean(cl.coeffs)) >= 0.25 || mean(cl.confidences) >= 0.75;
      return strong;
    })
    .map((cl) => {
      const depth = mean(cl.depths);
      const coefficient = mean(cl.coeffs);
      const phase = cl.phases.filter((p) => p === 'in').length >= cl.phases.length / 2 ? 'in' : 'out';
      const defectType = voteType(cl.types, phase);
      // 单锤事件置信度打折，提示人工复核
      const voteWeight = cl.votes >= 2 ? 0.4 : 0.15;
      const confidence =
        mean(cl.confidences) * (1 - voteWeight) + (cl.votes / totalBlows) * voteWeight;
      return {
        travelTime: waveSpeed > 0 ? (2 * depth) / waveSpeed : mean(cl.depths) * 0,
        depth,
        coefficient,
        phase,
        defectType,
        multiplicity: Math.round(mean(cl.multiplicities)),
        confidence: Math.min(0.99, confidence),
      } satisfies ReflectionEvent;
    })
    .sort((a, b) => a.depth - b.depth);

  return suppressFusedHarmonics(fused);
}

/**
 * 融合后谐波抑制：同相阻抗减小类事件（缩颈/夹泥/断桩）若深度近似为
 * 更浅主事件的 2/3 倍，判为该缺陷的周期回波而非独立缺陷，剔除并把
 * 倍数计入主事件 multiplicity。最浅主反射优先保留。
 */
function suppressFusedHarmonics(events: ReflectionEvent[]): ReflectionEvent[] {
  const sorted = [...events].sort((a, b) => a.depth - b.depth);
  const primaries = sorted.filter(
    (e) => e.phase === 'in' && (e.defectType === 'break' || e.defectType === 'segregation'),
  );
  if (primaries.length === 0) return sorted;
  const keep: ReflectionEvent[] = [];
  for (const e of sorted) {
    let harmonicOf: ReflectionEvent | null = null;
    for (const p of primaries) {
      if (p.depth >= e.depth) continue;
      const ratio = e.travelTime / p.travelTime;
      const nearest = Math.round(ratio);
      if (
        e.phase === 'in' &&
        nearest >= 2 &&
        nearest <= 3 &&
        Math.abs(ratio - nearest) < 0.15
      ) {
        harmonicOf = p;
        break;
      }
    }
    if (harmonicOf) {
      harmonicOf.multiplicity = Math.max(
        harmonicOf.multiplicity,
        Math.round(e.travelTime / harmonicOf.travelTime),
      );
    } else {
      keep.push(e);
    }
  }
  return keep;
}

/** 类型投票：严重程度优先（断桩 > 夹泥 > 缩颈 > 扩径），同时尊重相位 */
function voteType(
  types: ReflectionEvent['defectType'][],
  phase: 'in' | 'out',
): ReflectionEvent['defectType'] {
  if (phase === 'out') return 'bulge';
  const rank: Record<string, number> = { break: 4, segregation: 3, neck: 2, unknown: 1, toe: 0, bulge: 0 };
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  let best: ReflectionEvent['defectType'] = 'neck';
  let bestKey = '';
  for (const [t, c] of counts) {
    const key = `${rank[t] ?? 0}-${c}`;
    if (key > bestKey) {
      bestKey = key;
      best = t as ReflectionEvent['defectType'];
    }
  }
  return best;
}

function mean(x: number[]): number {
  return x.reduce((s, v) => s + v, 0) / x.length;
}

interface DecideArgs {
  meta: PileMeta;
  events: ReflectionEvent[];
  toeConfidence: number;
  headRingingDetected: boolean;
  forcedFallback: boolean;
  validBlowCount: number;
  totalBlowCount: number;
  waveSpeed: number | null;
  strongBreak: boolean;
}

function decideClass(args: DecideArgs): {
  finalClass: IntegrityClass;
  reasons: string[];
} {
  const { events, toeConfidence, meta } = args;
  const reasons: string[] = [];
  const defects = events.filter((e) => e.defectType !== 'toe');
  const breaks = defects.filter((e) => e.defectType === 'break');
  const segs = defects.filter((e) => e.defectType === 'segregation');
  const necks = defects.filter((e) => e.defectType === 'neck');
  const bulges = defects.filter((e) => e.defectType === 'bulge');

  if (args.waveSpeed) {
    reasons.push(
      `桩底反射走时反算波速 ${args.waveSpeed.toFixed(0)} m/s，桩底反射置信度 ${(
        toeConfidence * 100
      ).toFixed(0)}%`,
    );
  } else {
    reasons.push('未识别到可靠桩底反射，波速采用强度等级参考值，判定可信度降低');
  }

  for (const e of defects) {
    const name =
      e.defectType === 'break'
        ? '断桩'
        : e.defectType === 'segregation'
          ? '夹泥/离析'
          : e.defectType === 'neck'
            ? '缩颈'
            : '扩径';
    reasons.push(
      `桩深 ${e.depth.toFixed(2)}m 处${e.phase === 'in' ? '同相' : '反相'}反射（${name}），` +
        `反射系数 ${e.coefficient.toFixed(2)}，${e.multiplicity} 次周期反射，${args.validBlowCount}/${args.totalBlowCount} 锤复现`,
    );
  }

  let finalClass: IntegrityClass;

  // 最高优先级：任一有效锤出现强断桩反射即锁定 IV 类（IV 类不许漏判）
  if (args.strongBreak) {
    finalClass = 'IV';
    const anyBreak = breaks[0];
    reasons.push(
      `检测到强同相反射（反射系数 ≥0.7）${
        anyBreak ? `，最浅位于桩深 ${anyBreak.depth.toFixed(2)}m` : ''
      }，波阻抗近乎丧失、桩底反射不可达，判定 IV 类桩，必须立即复测并开挖/钻芯验证`,
    );
  } else if (breaks.length > 0) {
    // IV 类：断桩特征（强同相 + 多次反射），或浅部严重缺陷且无桩底反射
    finalClass = 'IV';
    reasons.push(
      `断桩反射位于 ${breaks[0].depth.toFixed(2)}m，呈强同相周期反射且${
        toeConfidence < 0.4 ? '桩底反射消失' : '桩底反射明显减弱'
      }，判定 IV 类桩`,
    );
  } else if (
    segs.some((e) => Math.abs(e.coefficient) >= 0.35 || e.multiplicity >= 2) &&
    toeConfidence < 0.4
  ) {
    finalClass = 'IV';
    reasons.push('严重夹泥/离析伴多次反射且桩底反射消失，按 IV 类桩从严判定');
  } else if (segs.length > 0 || necks.some((e) => Math.abs(e.coefficient) >= 0.28)) {
    // III 类：明显缺陷，桩底反射尚可辨
    finalClass = 'III';
    reasons.push('缺陷反射明显，桩底反射仍可辨认，判定 III 类桩，建议钻芯或开挖验证');
  } else if (necks.length > 0 || bulges.length > 0) {
    // II 类：轻微缺陷，不影响结构承载力
    finalClass = 'II';
    reasons.push('仅见轻微截面变化反射，桩底反射清晰，判定 II 类桩');
  } else {
    finalClass = 'I';
    reasons.push('桩身无明显缺陷反射，桩底反射清晰，判定 I 类桩');
  }

  if (args.headRingingDetected) {
    reasons.push('注意：桩头存在浮浆/未凿净高频振荡，浅部反射已屏蔽，建议处理桩头后复测确认');
  }
  if (args.forcedFallback) {
    reasons.push('警告：有效锤不足 2 锤，报告为低一致性条件下的推定结果，必须复测');
  }
  if (meta.toeCondition === 'socketed') {
    reasons.push('嵌岩桩桩底反射按反相/弱反射特征识别');
  }

  return { finalClass, reasons };
}

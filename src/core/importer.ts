// 实测数据导入：支持 CSV 与 JSON 两种格式
//
// CSV 格式（UTF-8，可含表头，# 开头为注释）：
//   # 每根桩用 META 行给出设计参数，后跟若干 BLOW 行，再跟数据点
//   META,pileId,x,y,designLength,diameter,concreteGrade,toeCondition
//   BLOW,blowId,dt
//   a0,a1,a2,...            （单行加速度序列，m/s²）
// 多锤则重复 BLOW + 数据行。
//
// JSON 格式：
//   { "piles": [ { "meta": {...PileMeta}, "blows": [ {"id","dt","acceleration":[...]} ] } ] }

import type { BlowData, PileMeta, PileTest, ToeCondition } from './types.ts';

export interface ImportResult {
  tests: PileTest[];
  errors: string[];
}

const VALID_GRADES = new Set([
  'C20', 'C25', 'C30', 'C35', 'C40', 'C45', 'C50', 'C55', 'C60',
]);

export function parsePileJson(text: string): ImportResult {
  const errors: string[] = [];
  const tests: PileTest[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { tests, errors: [`JSON 解析失败：${(e as Error).message}`] };
  }
  const root = data as { piles?: unknown[] };
  if (!root || !Array.isArray(root.piles)) {
    return { tests, errors: ['JSON 顶层需为 { "piles": [...] } 结构'] };
  }
  root.piles.forEach((raw, i) => {
    const pile = raw as {
      meta?: Record<string, unknown>;
      blows?: Record<string, unknown>[];
    };
    const meta = parseMeta(pile.meta, i);
    if ('error' in meta) {
      errors.push(meta.error);
      return;
    }
    const blows = parseBlows(pile.blows, meta.value.id, errors);
    if (blows.length === 0) {
      errors.push(`第 ${i + 1} 根桩 ${meta.value.id} 无有效锤击数据`);
      return;
    }
    tests.push({ meta: meta.value, blows });
  });
  return { tests, errors };
}

function parseMeta(
  raw: Record<string, unknown> | undefined,
  index: number,
): { value: PileMeta } | { error: string } {
  if (!raw) return { error: `第 ${index + 1} 根桩缺少 meta 字段` };
  const id = String(raw.id ?? `P-${index + 1}`);
  const designLength = Number(raw.designLength);
  const diameter = Number(raw.diameter ?? 0.8);
  const concreteGrade = String(raw.concreteGrade ?? 'C30');
  const toeCondition = String(raw.toeCondition ?? 'friction') as ToeCondition;
  if (!Number.isFinite(designLength) || designLength <= 0)
    return { error: `桩 ${id} 的 designLength 非法` };
  if (!VALID_GRADES.has(concreteGrade))
    return { error: `桩 ${id} 的混凝土强度等级 ${concreteGrade} 不受支持` };
  if (toeCondition !== 'friction' && toeCondition !== 'socketed')
    return { error: `桩 ${id} 的 toeCondition 须为 friction 或 socketed` };
  return {
    value: {
      id,
      x: Number(raw.x ?? 0),
      y: Number(raw.y ?? 0),
      designLength,
      diameter,
      concreteGrade,
      toeCondition,
    },
  };
}

function parseBlows(
  raw: Record<string, unknown>[] | undefined,
  pileId: string,
  errors: string[],
): BlowData[] {
  if (!Array.isArray(raw)) return [];
  const out: BlowData[] = [];
  raw.forEach((b, i) => {
    const dt = Number(b.dt);
    const arr = b.acceleration;
    if (!Number.isFinite(dt) || dt <= 0) {
      errors.push(`${pileId} 第 ${i + 1} 锤 dt 非法`);
      return;
    }
    if (!Array.isArray(arr) || arr.length < 16) {
      errors.push(`${pileId} 第 ${i + 1} 锤加速度数据过短或缺失`);
      return;
    }
    const nums = arr.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) {
      errors.push(`${pileId} 第 ${i + 1} 锤含非数值数据`);
      return;
    }
    out.push({
      id: String(b.id ?? `${pileId}-B${i + 1}`),
      dt,
      acceleration: Float64Array.from(nums),
    });
  });
  return out;
}

/** 解析自定义 CSV（META/BLOW 行 + 加速度数据行） */
export function parsePileCsv(text: string): ImportResult {
  const errors: string[] = [];
  const tests: PileTest[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  let meta: PileMeta | null = null;
  let blows: BlowData[] = [];
  let pendingBlowId = '';
  let pendingDt = 0;

  const flushPile = () => {
    if (meta) {
      if (blows.length > 0) tests.push({ meta, blows });
      else errors.push(`桩 ${meta.id} 无有效锤击数据`);
    }
    meta = null;
    blows = [];
  };

  for (const line of lines) {
    const cols = line.split(',').map((c) => c.trim());
    if (cols[0] === 'META') {
      flushPile();
      const [, id, x, y, designLength, diameter, concreteGrade, toeCondition] = cols;
      const parsed = parseMeta(
        {
          id,
          x: Number(x),
          y: Number(y),
          designLength: Number(designLength),
          diameter: Number(diameter),
          concreteGrade,
          toeCondition,
        },
        tests.length,
      );
      if ('error' in parsed) {
        errors.push(parsed.error);
      } else {
        meta = parsed.value;
      }
    } else if (cols[0] === 'BLOW') {
      pendingBlowId = cols[1];
      pendingDt = Number(cols[2]);
    } else if (meta && pendingDt > 0) {
      const nums = cols.map(Number);
      if (nums.some((n) => !Number.isFinite(n))) {
        errors.push(`${meta.id} 锤 ${pendingBlowId} 含非数值数据`);
      } else {
        blows.push({
          id: pendingBlowId || `${meta.id}-B${blows.length + 1}`,
          dt: pendingDt,
          acceleration: Float64Array.from(nums),
        });
      }
      pendingDt = 0;
    }
  }
  flushPile();
  return { tests, errors };
}

/** 自动识别格式并解析 */
export function parsePileData(text: string, filename: string): ImportResult {
  if (filename.toLowerCase().endsWith('.json') || text.trim().startsWith('{'))
    return parsePileJson(text);
  return parsePileCsv(text);
}

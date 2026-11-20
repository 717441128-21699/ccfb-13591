// 基桩低应变反射波法检测 —— 核心类型定义

/** 缺陷类型（按一维波动阻抗变化与反射相位区分） */
export type DefectType =
  | 'neck' // 缩颈：阻抗减小，速度反射与入射同相
  | 'bulge' // 扩径：阻抗增大，速度反射与入射反相
  | 'segregation' // 夹泥/离析：阻抗减小，同相且常伴二次反射
  | 'break'; // 断桩：阻抗剧烈减小，强同相多次反射，无桩底反射

/** 完整性类别 JGJ 106 */
export type IntegrityClass = 'I' | 'II' | 'III' | 'IV';

/** 桩底支承条件 */
export type ToeCondition = 'friction' | 'socketed';

/** 单段阻抗变化（合成波形用，也作为真值） */
export interface DefectSpec {
  type: DefectType;
  /** 缺陷起始深度 m */
  depth: number;
  /** 缺陷段长度 m */
  length: number;
  /**
   * 阻抗比 Z缺陷/Z正常：
   * 缩颈/夹泥 <1（夹泥更低），扩径 >1，断桩 0~0.08
   */
  impedanceRatio: number;
}

/** 单锤原始数据（加速度计采集） */
export interface BlowData {
  id: string;
  /** 加速度时程，m/s²，向下为正 */
  acceleration: Float64Array;
  /** 采样间隔 s */
  dt: number;
}

/** 基桩设计与施工资料 */
export interface PileMeta {
  id: string;
  /** 平面图坐标 m */
  x: number;
  y: number;
  /** 设计桩长 m */
  designLength: number;
  /** 设计桩径 m */
  diameter: number;
  /** 混凝土强度等级 */
  concreteGrade: string;
  toeCondition: ToeCondition;
}

/** 检测输入：一根桩的全部锤击数据 */
export interface PileTest {
  meta: PileMeta;
  blows: BlowData[];
}

/** 合成参数（真实导入的数据不需要） */
export interface SynthesisOptions {
  seed: number;
  defects?: DefectSpec[];
  /** 实测波速真值 m/s，默认按强度等级取 */
  trueWaveSpeed?: number;
  /** 噪声水平（相对加速度峰值），默认 0.015 */
  noiseLevel?: number;
  /** 是否模拟桩头浮浆/未凿干净（高频振荡） */
  headRinging?: boolean;
  /** 是否模拟双击 */
  doubleHit?: boolean;
  /** 锤数，默认 4 */
  blowCount?: number;
  /** 记录时长 s，默认自动取 2L/c*2.5 */
  duration?: number;
  /** 采样率 Hz，默认 12500（dt=80μs，工程常用） */
  sampleRate?: number;
}

/** 分析中识别到的一次反射事件 */
export interface ReflectionEvent {
  /** 相对入射峰的走时 s */
  travelTime: number;
  /** 反射位置（深度）m */
  depth: number;
  /** 反射系数估计（速度振幅比，带符号；正=同相=阻抗减小） */
  coefficient: number;
  /** 同相(阻抗减小) / 反相(阻抗增大) */
  phase: 'in' | 'out';
  /** 判读类型 */
  defectType: DefectType | 'toe' | 'unknown';
  /** 多次反射周期出现次数 */
  multiplicity: number;
  /** 该事件的可信度 0~1 */
  confidence: number;
}

/** 桩头高频振荡（浮浆/未凿干净）识别结果 */
export interface HeadRingingResult {
  detected: boolean;
  /** 高频能量占比 */
  highFreqRatio: number;
  /** 谱质心 Hz */
  spectralCentroid: number;
  /** 过零率（每毫秒） */
  zeroCrossingRate: number;
  /** 建议屏蔽的浅部截止深度 m */
  maskDepth: number;
  reason: string;
}

/** 单锤分析结果 */
export interface BlowAnalysis {
  blowId: string;
  /** 速度时程（积分+基线校正后，已按入射峰归一化） */
  velocity: Float64Array;
  /** 指数放大后的速度时程（仅用于显示/搜索） */
  amplified: Float64Array;
  dt: number;
  /** 入射峰采样点 */
  incidentIndex: number;
  /** 桩底走时 s（入射峰到桩底反射峰） */
  toeTravelTime: number | null;
  /** 桩底反射置信度 0~1 */
  toeConfidence: number;
  /** 反算波速 m/s */
  waveSpeed: number | null;
  events: ReflectionEvent[];
  headRinging: HeadRingingResult;
  /** 是否双击 */
  doubleHit: boolean;
  /** 与其余锤的相关系数（一致性阶段填充） */
  similarity: number;
  /** 是否被剔除 */
  rejected: boolean;
  rejectReason?: string;
  /** 初步类别 */
  provisionalClass: IntegrityClass;
}

/** 一根桩的完整分析报告 */
export interface PileReport {
  pileId: string;
  meta: PileMeta;
  /** 采用的有效锤数 */
  validBlows: number;
  /** 总锤数 */
  totalBlows: number;
  rejectedBlows: { blowId: string; reason: string }[];
  /** 最终判定波速 m/s */
  waveSpeed: number | null;
  toeConfidence: number;
  events: ReflectionEvent[];
  finalClass: IntegrityClass;
  /** 是否有疑问（需人工复核） */
  questionable: boolean;
  /** 判读理由（人读） */
  reasons: string[];
  headRinging: HeadRingingResult;
  analyses: BlowAnalysis[];
  /** 合成真值（仅演示/验证用，真实数据为空） */
  groundTruth?: {
    waveSpeed: number;
    defects: DefectSpec[];
  };
  /** 分析耗时 ms */
  elapsedMs: number;
}

/** 工地批次分析结果 */
export interface SiteReport {
  reports: PileReport[];
  totalElapsedMs: number;
  workerCount: number;
}

/**
 * 全局类型定义 —— 基桩低应变反射波法检测分析系统
 * 标准依据：JGJ 106-2014《建筑基桩检测技术规范》
 */

/** 桩身完整性类别（JGJ 106 表 3.5.1） */
export type IntegrityClass = 1 | 2 | 3 | 4;

/** 阻抗变化类型：扩径（阻抗增大）/ 缩颈（阻抗减小，夹泥、离析、断桩均表现为同相反射） */
export type DefectKind = 'expansion' | 'necking' | 'mud' | 'segregation' | 'break';

/** 敲击采集到的原始数据 */
export interface Blow {
  /** 锤次编号（1 起） */
  id: number;
  /** 采样率 Hz */
  sampleRate: number;
  /** 加速度计原始信号 a(t)，单位 g（无量纲化亦可，分析只看相对量） */
  accel: Float64Array;
  /** 采集时刻标签（ms 相对量，用于显示） */
  label?: string;
}

/** 单根桩的设计信息与采集数据 */
export interface PileInput {
  id: string;
  /** 平面图 x 坐标（m，虚拟坐标，用于排布） */
  x: number;
  /** 平面图 y 坐标（m） */
  y: number;
  /** 设计桩长 L (m) */
  designLength: number;
  /** 混凝土强度等级，如 C30 */
  concreteGrade: string;
  /** 设计桩径 (m) */
  diameter: number;
  /** 设计波速 (m/s)，可空；空则分析时按强度等级经验值估算 */
  designWaveSpeed?: number;
  blows: Blow[];
}

/** 识别出的反射事件（缺陷或桩底） */
export interface ReflectionEvent {
  /** 反射到达时刻（相对入射峰，s） */
  timeSec: number;
  /** 反射位置深度 (m) */
  depth: number;
  /** 归一化反射幅度（相对入射峰，已按指数放大补偿） */
  amplitudeRatio: number;
  /** 与入射脉冲同相（阻抗减小：缩颈/夹泥/离析/断桩）为 true；反相（扩径）为 false */
  samePhase: boolean;
  kind: DefectKind;
  /** 匹配滤波相关系数，用于可信度评估 */
  correlation: number;
}

/** 单锤分析结果 */
export interface BlowAnalysis {
  blowId: number;
  accepted: boolean;
  /** 被剔除原因（accepted=false 时） */
  rejectReason?: string;
  /** 入射峰位置（样本点） */
  incidentIndex: number;
  /** 预处理后的速度波形（用于绘图） */
  velocity: Float64Array;
  /** 指数放大后的速度波形（用于绘图） */
  amplified: Float64Array;
  /** 时间轴（s，相对入射峰） */
  timeAxis: Float64Array;
  /** 桩底反射事件 */
  toe?: ReflectionEvent;
  /** 缺陷反射事件（按深度排序） */
  defects: ReflectionEvent[];
  /** 反算波速 (m/s)，找不到桩底时回退设计波速 */
  waveSpeed: number;
  /** 信噪比 dB */
  snrDb: number;
  /** 桩头未凿净高频振铃判定 */
  headRinging: boolean;
  /** 二次锤击判定 */
  doubleHit: boolean;
  /** 入射峰归一化互相关（用于锤间一致性） */
  waveformFingerprint: number[];
}

/** 单根桩综合分析结果 */
export interface PileResult {
  pileId: string;
  className: IntegrityClass;
  /** 判读理由（人读，供报告使用） */
  reasons: string[];
  /** 存疑标志：需要老检测员复核 */
  questionable: boolean;
  acceptedBlowIds: number[];
  rejectedBlowIds: { id: number; reason: string }[];
  blowAnalyses: BlowAnalysis[];
  /** 综合采用的波速 (m/s) */
  waveSpeed: number;
  /** 实测桩长（用波速反算的 2L/c 时刻对应长度，正常应接近设计桩长） */
  measuredLength: number;
  /** 综合缺陷列表（深度取各有效锤中位数） */
  defects: ReflectionEvent[];
  toe?: ReflectionEvent;
  headRinging: boolean;
  /** 分析耗时 ms */
  elapsedMs: number;
}

/** 合成波形用的真值（仅合成数据携带，用于验证与教学） */
export interface SyntheticTruth {
  /** 真实波速 (m/s) */
  waveSpeed: number;
  /** 真实缺陷：深度 m、截面阻抗比 A2/A1、类型 */
  defects: { depth: number; impedanceRatio: number; kind: DefectKind; length: number }[];
  /** 真实桩底边界：自由端/持力层 */
  toeCondition: 'free' | 'soil';
  /** 真实完整性类别 */
  className: IntegrityClass;
  /** 哪几锤被故意做成坏锤及原因 */
  badBlows: { blowId: number; reason: string }[];
  headRinging: boolean;
}

export interface SyntheticPile extends PileInput {
  truth: SyntheticTruth;
}

/** Worker 任务请求 */
export type WorkerRequest =
  | { type: 'analyze'; pile: PileInput }
  | { type: 'analyzeBatch'; piles: PileInput[] }
  | { type: 'synthesize'; count: number; seed: number; options?: SynthesisOptions };

export interface SynthesisOptions {
  /** 各完整性类别的占比，默认按工地常见分布 */
  classMix?: Partial<Record<IntegrityClass, number>>;
  badBlowRate?: number;
  headRingingRate?: number;
}

/** Worker 响应 */
export type WorkerResponse =
  | { type: 'analyzeResult'; result: PileResult }
  | { type: 'batchProgress'; done: number; total: number }
  | { type: 'batchDone'; results: PileResult[]; elapsedMs: number }
  | { type: 'synthesisDone'; piles: SyntheticPile[]; elapsedMs: number }
  | { type: 'error'; message: string };

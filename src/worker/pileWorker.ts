// 基桩分析 Web Worker（ES Module 格式）
// 主线程把成批桩的检测数据分发到多个 Worker 并行分析，
// Worker 内复用与 Node 验证完全相同的核心算法，保证结果一致。

import { analyzePile } from '../core/consistency.ts';
import type { PileReport, PileTest } from '../core/types.ts';

export interface AnalyzeJob {
  test: PileTest;
  groundTruth?: PileReport['groundTruth'];
}

export type WorkerRequest =
  | { type: 'analyze'; batchId: number; jobs: AnalyzeJob[] }
  | { type: 'shutdown' };

export type WorkerResponse =
  | { type: 'progress'; batchId: number; done: number; total: number }
  | { type: 'result'; batchId: number; reports: PileReport[] }
  | { type: 'error'; batchId: number; message: string };

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'shutdown') {
    self.close();
    return;
  }
  if (msg.type !== 'analyze') return;

  try {
    const reports: PileReport[] = [];
    const total = msg.jobs.length;
    for (let i = 0; i < total; i++) {
      const job = msg.jobs[i];
      reports.push(
        analyzePile(job.test.meta, job.test.blows, job.groundTruth),
      );
      if ((i + 1) % 5 === 0 || i + 1 === total) {
        const progress: WorkerResponse = {
          type: 'progress',
          batchId: msg.batchId,
          done: i + 1,
          total,
        };
        self.postMessage(progress);
      }
    }
    const response: WorkerResponse = {
      type: 'result',
      batchId: msg.batchId,
      reports,
    };
    self.postMessage(response);
  } catch (err) {
    const response: WorkerResponse = {
      type: 'error',
      batchId: msg.batchId,
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};

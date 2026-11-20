// 分析线程池：按 CPU 核数创建 Worker，把桩均分到各 Worker 并行分析，
// 聚合进度与结果。不支持 Worker 的环境自动降级为主线程串行执行。

import { analyzePile } from '../core/consistency.ts';
import type { PileReport, PileTest } from '../core/types.ts';
import type {
  AnalyzeJob,
  WorkerRequest,
  WorkerResponse,
} from './pileWorker.ts';

export interface PoolOptions {
  workerCount?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface PoolResult {
  reports: PileReport[];
  workerCount: number;
  elapsedMs: number;
}

function defaultWorkerCount(): number {
  if (typeof navigator === 'undefined' || !navigator.hardwareConcurrency) return 4;
  return Math.max(2, Math.min(8, navigator.hardwareConcurrency - 1));
}

export async function analyzeSite(
  tests: PileTest[],
  groundTruths: Map<string, PileReport['groundTruth']> | undefined,
  opts: PoolOptions = {},
): Promise<PoolResult> {
  const total = tests.length;
  const jobs: AnalyzeJob[] = tests.map((test) => ({
    test,
    groundTruth: groundTruths?.get(test.meta.id),
  }));

  const t0 = performance.now();

  // 不支持 Worker 时主线程降级
  if (typeof Worker === 'undefined') {
    const reports: PileReport[] = [];
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      reports.push(analyzePile(job.test.meta, job.test.blows, job.groundTruth));
      opts.onProgress?.(i + 1, total);
    }
    return { reports, workerCount: 1, elapsedMs: performance.now() - t0 };
  }

  const workerCount = Math.min(
    opts.workerCount ?? defaultWorkerCount(),
    Math.max(1, total),
  );
  const batches: AnalyzeJob[][] = Array.from({ length: workerCount }, () => []);
  jobs.forEach((job, i) => batches[i % workerCount].push(job));

  const progress = new Array<number>(workerCount).fill(0);
  const reportsByPile = new Map<string, PileReport>();
  let lastReported = -1;
  const reportProgress = () => {
    const done = progress.reduce((s, v) => s + v, 0);
    if (done !== lastReported) {
      lastReported = done;
      opts.onProgress?.(Math.min(done, total), total);
    }
  };

  await Promise.all(
    batches.map((batch, batchId) => {
      if (batch.length === 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const worker = new Worker(
          new URL('./pileWorker.ts', import.meta.url),
          { type: 'module' },
        );
        worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
          const msg = ev.data;
          if (msg.batchId !== batchId) return;
          if (msg.type === 'progress') {
            progress[batchId] = msg.done;
            reportProgress();
          } else if (msg.type === 'result') {
            for (const r of msg.reports) reportsByPile.set(r.pileId, r);
            worker.terminate();
            resolve();
          } else if (msg.type === 'error') {
            worker.terminate();
            reject(new Error(`Worker ${batchId} 分析失败：${msg.message}`));
          }
        };
        worker.onerror = (ev) => {
          worker.terminate();
          reject(new Error(ev.message || 'Worker 运行错误'));
        };
        const req: WorkerRequest = { type: 'analyze', batchId, jobs: batch };
        worker.postMessage(req);
      });
    }),
  );

  const reports = tests
    .map((t) => reportsByPile.get(t.meta.id))
    .filter((r): r is PileReport => r !== undefined);
  opts.onProgress?.(total, total);

  return { reports, workerCount, elapsedMs: performance.now() - t0 };
}

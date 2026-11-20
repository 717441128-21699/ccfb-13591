/// <reference lib="webworker" />
/**
 * 分析 Worker：单桩 / 批量分析 / 波形合成都在后台线程完成，
 * 保证 300 根桩分析期间主线程 UI 不卡顿。
 */
import { analyzePile } from '../lib/analyzer';
import { synthesizeSite } from '../lib/synthesizer';
import type { PileInput, WorkerRequest, WorkerResponse } from '../types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'analyze') {
      const result = analyzePile(msg.pile as PileInput);
      const response: WorkerResponse = { type: 'analyzeResult', result };
      ctx.postMessage(response);
      return;
    }
    if (msg.type === 'analyzeBatch') {
      const t0 = performance.now();
      const results = [];
      for (let i = 0; i < msg.piles.length; i++) {
        results.push(analyzePile(msg.piles[i]));
        if ((i + 1) % 16 === 0 || i === msg.piles.length - 1) {
          const progress: WorkerResponse = { type: 'batchProgress', done: i + 1, total: msg.piles.length };
          ctx.postMessage(progress);
        }
      }
      const response: WorkerResponse = {
        type: 'batchDone',
        results,
        elapsedMs: performance.now() - t0,
      };
      ctx.postMessage(response);
      return;
    }
    if (msg.type === 'synthesize') {
      const t0 = performance.now();
      const piles = synthesizeSite({
        count: msg.count,
        seed: msg.seed,
        classMix: msg.options?.classMix,
        badBlowRate: msg.options?.badBlowRate,
        headRingingRate: msg.options?.headRingingRate,
      });
      const response: WorkerResponse = {
        type: 'synthesisDone',
        piles,
        elapsedMs: performance.now() - t0,
      };
      ctx.postMessage(response);
      return;
    }
  } catch (err) {
    const response: WorkerResponse = {
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    ctx.postMessage(response);
  }
};

/**
 * Worker 池：按 navigator.hardwareConcurrency 分配，
 * 任务按桩粒度分片，结果按提交顺序回收。
 */
import type { PileInput, PileResult, SyntheticPile, SynthesisOptions, WorkerResponse } from '../types';
import WorkerUrl from './analysis.worker.ts?worker';

export class WorkerPool {
  private workers: Worker[] = [];
  private queue: { pile: PileInput; resolve: (r: PileResult) => void; reject: (e: Error) => void }[] = [];
  private nextWorker = 0;

  constructor(size?: number) {
    const n = size ?? Math.min(8, Math.max(2, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new WorkerUrl();
      w.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(w, e.data);
      w.onerror = (e: ErrorEvent) => this.onError(e.message || 'worker 错误');
      this.workers.push(w);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  private pending = new Map<Worker, { resolve: (r: PileResult) => void; reject: (e: Error) => void }>();

  private onMessage(w: Worker, msg: WorkerResponse): void {
    if (msg.type === 'analyzeResult') {
      const p = this.pending.get(w);
      this.pending.delete(w);
      p?.resolve(msg.result);
      this.drain(w);
    } else if (msg.type === 'error') {
      this.onError(msg.message);
    }
  }

  private onError(message: string): void {
    for (const [, p] of this.pending) p.reject(new Error(message));
    this.pending.clear();
    for (const task of this.queue) task.reject(new Error(message));
    this.queue.length = 0;
  }

  private drain(w: Worker): void {
    const task = this.queue.shift();
    if (!task) return;
    this.pending.set(w, { resolve: task.resolve, reject: task.reject });
    w.postMessage({ type: 'analyze', pile: task.pile } satisfies import('../types').WorkerRequest);
  }

  analyze(pile: PileInput): Promise<PileResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ pile, resolve, reject });
      const free = this.workers.find((w) => !this.pending.has(w));
      if (free) this.drain(free);
    });
  }

  async analyzeAll(piles: PileInput[], onProgress?: (done: number, total: number) => void): Promise<PileResult[]> {
    let done = 0;
    const results = await Promise.all(
      piles.map(async (p) => {
        const r = await this.analyze(p);
        done++;
        onProgress?.(done, piles.length);
        return r;
      }),
    );
    // 保持与输入相同的桩顺序
    const indexById = new Map(piles.map((p, i) => [p.id, i]));
    return results.sort((a, b) => (indexById.get(a.pileId) ?? 0) - (indexById.get(b.pileId) ?? 0));
  }

  /** 合成在独立一次性 worker 上执行（数据量大，避免占用分析池） */
  static synthesize(
    count: number,
    seed: number,
    options?: SynthesisOptions,
  ): Promise<{ piles: SyntheticPile[]; elapsedMs: number }> {
    return new Promise((resolve, reject) => {
      const w = new WorkerUrl();
      w.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data;
        if (msg.type === 'synthesisDone') {
          resolve({ piles: msg.piles, elapsedMs: msg.elapsedMs });
          w.terminate();
        } else if (msg.type === 'error') {
          reject(new Error(msg.message));
          w.terminate();
        }
      };
      w.onerror = (e: ErrorEvent) => reject(new Error(e.message));
      w.postMessage({ type: 'synthesize', count, seed, options } satisfies import('../types').WorkerRequest);
    });
  }

  dispose(): void {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    this.pending.clear();
    this.queue.length = 0;
    void this.nextWorker;
  }
}

/**
 * Work scheduler.
 *
 * Four properties, each of which exists because of a specific failure:
 *
 *   single writer per deployment   two jobs evaluating one deployment at once
 *                                  interleave checkpoint advancement. The lane
 *                                  lock here is the in-process half; the
 *                                  advisory lock in storage is the cross-process
 *                                  half, and both are needed.
 *   bounded concurrency            an agent watching thirty deployments must not
 *                                  open thirty concurrent RPC fan-outs.
 *   backpressure                   when the queue is full new work is REFUSED,
 *                                  not buffered. An unbounded queue turns a slow
 *                                  provider into an out-of-memory crash, and a
 *                                  crashed watcher reports nothing at all.
 *   bounded retry with a deadline  every job has a timeout and an attempt
 *                                  budget, so one hung endpoint cannot occupy a
 *                                  slot forever.
 *
 * Time and sleeping are injected. Nothing in this file reads a clock of its own,
 * which is what makes the retry and shutdown behaviour testable without waiting.
 */

export interface Job {
  readonly deploymentId: string;
  readonly kind: string;
}

export type JobResult = 'succeeded' | 'failed' | 'timed-out' | 'abandoned' | 'cancelled';

export interface JobOutcome {
  readonly job: Job;
  readonly result: JobResult;
  readonly attempts: number;
  readonly durationMs: number;
  /** Redacted and bounded by the caller. Never carries an endpoint or a token. */
  readonly reason: string | null;
}

export type SubmitResult = 'queued' | 'duplicate' | 'rejected-backpressure' | 'rejected-draining';

export interface SchedulerOptions {
  readonly maxConcurrency: number;
  readonly queueLimit: number;
  readonly jobTimeoutMs: number;
  /** Total attempts per job, including the first. */
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly now: () => number;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly run: (job: Job, signal: AbortSignal) => Promise<void>;
  readonly onOutcome: (outcome: JobOutcome) => void;
}

export interface SchedulerStats {
  readonly queued: number;
  readonly active: number;
  readonly draining: boolean;
  readonly rejectedForBackpressure: number;
  readonly deduplicated: number;
}

const jobKey = (job: Job): string => `${job.deploymentId} ${job.kind}`;

export class Scheduler {
  readonly #options: SchedulerOptions;
  readonly #queue: Job[] = [];
  /** One in-flight job per deployment. This IS the single-writer guarantee. */
  readonly #lanes = new Set<string>();
  readonly #queuedKeys = new Set<string>();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #shutdown = new AbortController();
  #draining = false;
  #rejected = 0;
  #deduplicated = 0;

  constructor(options: SchedulerOptions) {
    this.#options = options;
  }

  stats(): SchedulerStats {
    return {
      queued: this.#queue.length,
      active: this.#lanes.size,
      draining: this.#draining,
      rejectedForBackpressure: this.#rejected,
      deduplicated: this.#deduplicated,
    };
  }

  /**
   * Offer work.
   *
   * Returns why it was not taken rather than throwing: a refused submission is a
   * normal, countable operating state that the agent reports as backpressure,
   * not an error that should unwind a polling loop.
   */
  submit(job: Job): SubmitResult {
    if (this.#draining) return 'rejected-draining';
    const key = jobKey(job);
    // The same work already pending or running is not queued twice. A watcher
    // that falls behind must not build a backlog of identical evaluations.
    if (this.#queuedKeys.has(key) || this.#lanes.has(job.deploymentId)) {
      this.#deduplicated += 1;
      return 'duplicate';
    }
    if (this.#queue.length >= this.#options.queueLimit) {
      this.#rejected += 1;
      return 'rejected-backpressure';
    }
    this.#queue.push(job);
    this.#queuedKeys.add(key);
    return 'queued';
  }

  /**
   * Start every job the current limits allow.
   *
   * Returns as soon as the slots are filled; the jobs themselves are tracked in
   * flight and awaited by `shutdown`.
   */
  pump(): void {
    while (this.#lanes.size < this.#options.maxConcurrency) {
      const index = this.#queue.findIndex((j) => !this.#lanes.has(j.deploymentId));
      if (index === -1) return;
      const [job] = this.#queue.splice(index, 1);
      if (job === undefined) return;
      this.#queuedKeys.delete(jobKey(job));
      this.#lanes.add(job.deploymentId);
      const promise = this.#execute(job).finally(() => {
        this.#lanes.delete(job.deploymentId);
        this.#inFlight.delete(promise);
      });
      this.#inFlight.add(promise);
    }
  }

  async #execute(job: Job): Promise<void> {
    const started = this.#options.now();
    let lastReason: string | null = null;

    for (let attempt = 1; attempt <= this.#options.maxAttempts; attempt += 1) {
      if (this.#shutdown.signal.aborted) {
        this.#report(job, 'cancelled', attempt, started, lastReason);
        return;
      }
      const timeout = new AbortController();
      const timer = setTimeout(() => {
        timeout.abort(new Error('job timeout'));
      }, this.#options.jobTimeoutMs);
      let timedOut = false;
      try {
        await this.#options.run(job, AbortSignal.any([this.#shutdown.signal, timeout.signal]));
        this.#report(job, 'succeeded', attempt, started, null);
        return;
      } catch (e) {
        timedOut = timeout.signal.aborted;
        lastReason = timedOut ? 'job timeout' : e instanceof Error ? e.message : 'job failed';
      } finally {
        clearTimeout(timer);
      }

      if (this.#shutdown.signal.aborted) {
        this.#report(job, 'cancelled', attempt, started, lastReason);
        return;
      }
      if (attempt === this.#options.maxAttempts) {
        // Budget exhausted. `abandoned` is deliberately not `failed`: the agent
        // surfaces it as an unresolved deployment, never as a completed check.
        this.#report(job, timedOut ? 'timed-out' : 'abandoned', attempt, started, lastReason);
        return;
      }
      try {
        await this.#options.sleep(
          this.#options.backoffMs * 2 ** (attempt - 1),
          this.#shutdown.signal,
        );
      } catch {
        this.#report(job, 'cancelled', attempt, started, lastReason);
        return;
      }
    }
  }

  #report(
    job: Job,
    result: JobResult,
    attempts: number,
    started: number,
    reason: string | null,
  ): void {
    this.#options.onOutcome({
      job,
      result,
      attempts,
      durationMs: this.#options.now() - started,
      reason,
    });
  }

  /**
   * Graceful shutdown.
   *
   * Stop accepting, let what is running finish within the grace period, and only
   * then abort. An agent killed mid-write is safe by construction, because facts
   * and their checkpoint share a transaction, but finishing cleanly avoids a
   * needless replay on the next start.
   */
  async shutdown(graceMs: number): Promise<void> {
    this.#draining = true;
    this.#queue.length = 0;
    this.#queuedKeys.clear();

    const deadline = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#shutdown.abort(new Error('shutdown grace period elapsed'));
        resolve();
      }, graceMs);
      // Do not hold the event loop open just to enforce a deadline nobody needs.
      timer.unref();
    });

    await Promise.race([Promise.allSettled([...this.#inFlight]).then(() => undefined), deadline]);
    await Promise.allSettled([...this.#inFlight]);
  }
}

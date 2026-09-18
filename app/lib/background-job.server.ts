/**
 * Run a cron job in the background, one at a time.
 *
 * The cron worker used to wait on the HTTP response and gave up after two minutes. The
 * Shopify sync takes longer than that, so every hourly run was reported as a timeout,
 * its results (including failures) were thrown away, and the worker's lock was released
 * while the server was still working. Routes now answer 202 at once and the job runs
 * here, where its outcome is logged when it actually finishes.
 *
 * The lock lives in this process. That is sufficient because the app runs as a single
 * pm2 fork instance (ecosystem.config.cjs); running more than one instance would need a
 * lock in the database instead.
 */

const running = new Map<string, Date>();

export type StartResult = { started: true } | { started: false; runningSince: Date };

/**
 * Start `work` unless a run of `job` is already in progress. Never throws, and never
 * waits for `work`: a failure is logged, not returned.
 */
export function startBackgroundJob(job: string, work: () => Promise<unknown>): StartResult {
  const since = running.get(job);
  if (since) {
    console.warn(`[cron/${job}] skipped: previous run still in progress since ${since.toISOString()}`);
    return { started: false, runningSince: since };
  }

  const startedAt = new Date();
  running.set(job, startedAt);

  void (async () => {
    try {
      const result = await work();
      const seconds = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
      console.log(`[cron/${job}] completed in ${seconds}s`, JSON.stringify(result));
    } catch (err) {
      const seconds = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
      console.error(
        `[cron/${job}] failed after ${seconds}s:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      running.delete(job);
    }
  })();

  return { started: true };
}

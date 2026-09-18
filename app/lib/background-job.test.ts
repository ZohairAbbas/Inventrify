import { afterEach, describe, expect, it, vi } from "vitest";
import { startBackgroundJob } from "./background-job.server";

/** A job the test finishes by hand. */
function controllable<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { work: vi.fn(() => promise), resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startBackgroundJob", () => {
  it("does not start a second run while the first is in progress", async () => {
    const first = controllable<{ shops: number }>();
    const second = controllable<unknown>();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(startBackgroundJob("overlap", first.work)).toEqual({ started: true });
    const again = startBackgroundJob("overlap", second.work);

    expect(again.started).toBe(false);
    expect(second.work).not.toHaveBeenCalled();

    first.resolve({ shops: 3 });
    await flush();

    // Released once the first run finishes.
    expect(startBackgroundJob("overlap", second.work)).toEqual({ started: true });
    second.resolve(null);
    await flush();
  });

  it("logs completion with duration and the job's result", async () => {
    const job = controllable<{ shops: number; results: unknown[] }>();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    startBackgroundJob("logged", job.work);
    job.resolve({ shops: 2, results: [{ shop: "a", deleted: 4 }] });
    await flush();

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[cron\/logged\] completed in \d+\.\ds$/),
      JSON.stringify({ shops: 2, results: [{ shop: "a", deleted: 4 }] }),
    );
  });

  it("logs a failure and releases the lock", async () => {
    const job = controllable<unknown>();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    startBackgroundJob("failing", job.work);
    job.reject(new Error("boom"));
    await flush();

    expect(error).toHaveBeenCalledWith(expect.stringMatching(/^\[cron\/failing\] failed after/), "boom");
    const next = controllable<unknown>();
    expect(startBackgroundJob("failing", next.work).started).toBe(true);
    next.resolve(null);
    await flush();
  });

  it("keeps different jobs independent", async () => {
    const a = controllable<unknown>();
    const b = controllable<unknown>();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(startBackgroundJob("job-a", a.work).started).toBe(true);
    expect(startBackgroundJob("job-b", b.work).started).toBe(true);
    a.resolve(null);
    b.resolve(null);
    await flush();
  });
});

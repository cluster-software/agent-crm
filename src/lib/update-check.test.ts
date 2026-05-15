import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  cachePath,
  compareVersions,
  configDir,
  lockPath,
  notifyIfOutdated,
  parseVersion,
  scheduleBackgroundRefreshIfStale,
  writeCache,
} from "./update-check.js";

function captureStream(): { stream: Writable; output: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return {
    stream,
    output: () => Buffer.concat(chunks).toString("utf8"),
  };
}

describe("parseVersion", () => {
  it("parses valid semver triples", () => {
    expect(parseVersion("0.1.0")).toEqual([0, 1, 0]);
    expect(parseVersion("0.10.5")).toEqual([0, 10, 5]);
    expect(parseVersion("12.34.56")).toEqual([12, 34, 56]);
  });

  it("rejects pre-release suffixes", () => {
    expect(parseVersion("0.9.0-dev")).toBeNull();
    expect(parseVersion("1.0.0-rc.1")).toBeNull();
  });

  it("rejects malformed strings", () => {
    expect(parseVersion("0.1")).toBeNull();
    expect(parseVersion("v0.1.0")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("compares numerically, not lexically", () => {
    // This is the classic bug — string compare would say "0.10.0" < "0.9.0".
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
  });

  it("orders by major, minor, patch", () => {
    expect(compareVersions("1.0.0", "0.99.0")).toBe(1);
    expect(compareVersions("0.7.0", "0.1.0")).toBe(1);
    expect(compareVersions("0.9.0", "0.9.0")).toBe(0);
  });

  it("returns 0 when either side is unparseable", () => {
    expect(compareVersions("0.9.0-dev", "0.9.0")).toBe(0);
    expect(compareVersions("garbage", "0.9.0")).toBe(0);
  });
});

describe("update-check cache + notify", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "acrm-update-check-"));
    process.env.ACRM_CONFIG_DIR = tmp;
    delete process.env.ACRM_NO_UPDATE_CHECK;
    delete process.env.NO_UPDATE_NOTIFIER;
    delete process.env.CI;
  });

  afterEach(() => {
    delete process.env.ACRM_CONFIG_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("honors ACRM_CONFIG_DIR for cache location", () => {
    expect(configDir()).toBe(tmp);
    expect(cachePath()).toBe(path.join(tmp, "update-check.json"));
  });

  it("writes the cache file with 0600 permissions", () => {
    writeCache("0.9.0");
    const mode = statSync(cachePath()).mode & 0o777;
    expect(mode & 0o077).toBe(0);
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8"));
    expect(parsed.latest_version).toBe("0.9.0");
    expect(typeof parsed.checked_at).toBe("number");
  });

  it("warns when cache shows a newer version", () => {
    writeCache("0.9.0");
    const { stream, output } = captureStream();
    notifyIfOutdated("0.1.0", stream);
    expect(output()).toMatch(/A newer @agent-crm\/cli is available: 0\.9\.0/);
    expect(output()).toMatch(/you are using 0\.1\.0/);
    expect(output()).toMatch(/npm install -g @agent-crm\/cli@latest/);
  });

  it("stays silent when current version equals cached latest", () => {
    writeCache("0.9.0");
    const { stream, output } = captureStream();
    notifyIfOutdated("0.9.0", stream);
    expect(output()).toBe("");
  });

  it("stays silent when current version is newer than cached latest", () => {
    writeCache("0.9.0");
    const { stream, output } = captureStream();
    notifyIfOutdated("0.10.0", stream);
    expect(output()).toBe("");
  });

  it("stays silent when no cache exists", () => {
    const { stream, output } = captureStream();
    notifyIfOutdated("0.1.0", stream);
    expect(output()).toBe("");
  });

  it("stays silent when cache JSON is malformed", () => {
    writeFileSync(cachePath(), "not json", { encoding: "utf8" });
    const { stream, output } = captureStream();
    notifyIfOutdated("0.1.0", stream);
    expect(output()).toBe("");
  });

  it("stays silent on a dev/pre-release current version", () => {
    writeCache("0.9.0");
    const { stream, output } = captureStream();
    notifyIfOutdated("0.9.0-dev", stream);
    expect(output()).toBe("");
  });

  for (const optOut of ["ACRM_NO_UPDATE_CHECK", "NO_UPDATE_NOTIFIER", "CI"]) {
    it(`stays silent when ${optOut} is set`, () => {
      writeCache("0.9.0");
      process.env[optOut] = "1";
      const { stream, output } = captureStream();
      notifyIfOutdated("0.1.0", stream);
      expect(output()).toBe("");
      delete process.env[optOut];
    });
  }
});

describe("scheduleBackgroundRefreshIfStale", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "acrm-update-refresh-"));
    process.env.ACRM_CONFIG_DIR = tmp;
    delete process.env.ACRM_NO_UPDATE_CHECK;
    delete process.env.NO_UPDATE_NOTIFIER;
    delete process.env.CI;
  });

  afterEach(() => {
    delete process.env.ACRM_CONFIG_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  function fakeSpawn() {
    const unref = vi.fn();
    const fn = vi.fn().mockReturnValue({ unref });
    // Cast through unknown to satisfy the spawn typing — we only exercise
    // the two methods the production code actually uses.
    return { fn: fn as unknown as typeof import("node:child_process").spawn, calls: fn, unref };
  }

  it("spawns a detached worker when cache is missing", () => {
    const { fn, calls, unref } = fakeSpawn();
    const scheduled = scheduleBackgroundRefreshIfStale("0.9.0", {
      workerPath: "/fake/worker.js",
      spawnFn: fn,
    });
    expect(scheduled).toBe(true);
    expect(calls).toHaveBeenCalledOnce();
    const [, args, opts] = calls.mock.calls[0];
    expect(args).toEqual(["/fake/worker.js"]);
    expect((opts as { detached?: boolean }).detached).toBe(true);
    expect(unref).toHaveBeenCalledOnce();
  });

  it("does not spawn when cache is fresh", () => {
    writeCache("0.9.0");
    const { fn, calls } = fakeSpawn();
    const scheduled = scheduleBackgroundRefreshIfStale("0.9.0", {
      workerPath: "/fake/worker.js",
      spawnFn: fn,
    });
    expect(scheduled).toBe(false);
    expect(calls).not.toHaveBeenCalled();
  });

  it("spawns when cache is older than the TTL", () => {
    // Hand-write a cache with an ancient timestamp.
    writeFileSync(
      cachePath(),
      JSON.stringify({
        checked_at: Date.now() - 48 * 60 * 60 * 1000,
        latest_version: "0.9.0",
      }),
    );
    const { fn, calls } = fakeSpawn();
    const scheduled = scheduleBackgroundRefreshIfStale("0.9.0", {
      workerPath: "/fake/worker.js",
      spawnFn: fn,
    });
    expect(scheduled).toBe(true);
    expect(calls).toHaveBeenCalledOnce();
  });

  it("respects the lock file to avoid concurrent worker storms", () => {
    writeFileSync(lockPath(), String(Date.now()));
    const { fn, calls } = fakeSpawn();
    const scheduled = scheduleBackgroundRefreshIfStale("0.9.0", {
      workerPath: "/fake/worker.js",
      spawnFn: fn,
    });
    expect(scheduled).toBe(false);
    expect(calls).not.toHaveBeenCalled();
  });

  it("does not spawn when opted out", () => {
    process.env.ACRM_NO_UPDATE_CHECK = "1";
    const { fn, calls } = fakeSpawn();
    const scheduled = scheduleBackgroundRefreshIfStale("0.9.0", {
      workerPath: "/fake/worker.js",
      spawnFn: fn,
    });
    expect(scheduled).toBe(false);
    expect(calls).not.toHaveBeenCalled();
  });

  it("does not spawn for dev/pre-release current versions", () => {
    const { fn, calls } = fakeSpawn();
    const scheduled = scheduleBackgroundRefreshIfStale("0.9.0-dev", {
      workerPath: "/fake/worker.js",
      spawnFn: fn,
    });
    expect(scheduled).toBe(false);
    expect(calls).not.toHaveBeenCalled();
  });
});

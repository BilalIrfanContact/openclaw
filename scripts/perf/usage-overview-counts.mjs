// Measurement preload for usage-overview-measure.ts: counts work in every thread.
// The main thread injects this file into each Worker's execArgv, so worker-pool
// threads report their own counters through a process-wide BroadcastChannel.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isMainThread, threadId } from "node:worker_threads";

const require = createRequire(import.meta.url);
const self = fileURLToPath(import.meta.url);
const zero = () => ({
  sqlExec: 0,
  sqlPrepare: 0,
  zstdDecompress: 0,
  zstdDecompressBytes: 0,
  sha256: 0,
  sha256Bytes: 0,
  jsonParse: 0,
  jsonParseBytes: 0,
  // Decoded rollup or partition bodies that carry usage buckets.
  bucketJsonParse: 0,
  workerPostMessage: 0,
  workerMessages: 0,
  workersCreated: 0,
  eluActiveMs: 0,
  cpuMs: 0,
});
let counters = zero();
let eluBase = performance.eventLoopUtilization();
let cpuBase = process.threadCpuUsage();
const withElu = () => {
  const delta = performance.eventLoopUtilization(eluBase);
  const cpu = process.threadCpuUsage(cpuBase);
  return { ...counters, eluActiveMs: delta.active, cpuMs: (cpu.user + cpu.system) / 1000 };
};
const resetCounters = () => {
  counters = zero();
  eluBase = performance.eventLoopUtilization();
  cpuBase = process.threadCpuUsage();
};

const crypto = require("node:crypto");
const originalHash = crypto.hash;
crypto.hash = function (algorithm, data, ...rest) {
  if (String(algorithm).toLowerCase() === "sha256") {
    counters.sha256++;
    counters.sha256Bytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  }
  return originalHash.call(this, algorithm, data, ...rest);
};
const originalCreateHash = crypto.createHash;
crypto.createHash = function (algorithm, ...rest) {
  const hash = originalCreateHash.call(this, algorithm, ...rest);
  if (String(algorithm).toLowerCase() === "sha256") {
    counters.sha256++;
    const update = hash.update;
    hash.update = function (data, ...args) {
      counters.sha256Bytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
      return update.call(this, data, ...args);
    };
  }
  return hash;
};
const zlib = require("node:zlib");
const originalZstd = zlib.zstdDecompressSync;
zlib.zstdDecompressSync = function (...args) {
  const out = originalZstd.apply(this, args);
  counters.zstdDecompress++;
  counters.zstdDecompressBytes += out.byteLength;
  return out;
};
const originalParse = JSON.parse;
JSON.parse = function (text, reviver) {
  counters.jsonParse++;
  counters.jsonParseBytes += typeof text === "string" ? text.length : 0;
  const value = originalParse.call(this, text, reviver);
  if (value && typeof value === "object" && value.buckets && value.untimestamped) {
    counters.bucketJsonParse += Object.keys(value.buckets).length > 0 ? 1 : 0;
  }
  return value;
};
const sqlite = require("node:sqlite");
const probe = new sqlite.DatabaseSync(":memory:");
const Statement = probe.prepare("select 1").constructor;
probe.close();
for (const method of ["all", "get", "run", "iterate"]) {
  const original = Statement.prototype[method];
  Statement.prototype[method] = function (...args) {
    counters.sqlExec++;
    return original.apply(this, args);
  };
}
const originalPrepare = sqlite.DatabaseSync.prototype.prepare;
sqlite.DatabaseSync.prototype.prepare = function (...args) {
  counters.sqlPrepare++;
  return originalPrepare.apply(this, args);
};

// Windowed CPU profiles for every thread: only the measured reads, not boot or convergence.
const profileDir = process.env.USAGE_OVERVIEW_PROFILE_DIR;
let profiler;
const post = (method, params) =>
  new Promise((resolve, reject) => {
    profiler.post(method, params, (error, value) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } else {
        resolve(value);
      }
    });
  });
let profiling = false;
async function startProfile() {
  if (!profileDir) {
    return;
  }
  profiler ??= new (require("node:inspector").Session)();
  try {
    profiler.connect();
  } catch {
    // Already connected from an earlier window.
  }
  if (profiling) {
    // A new window discards the samples recorded before it.
    await post("Profiler.stop");
  }
  profiling = true;
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 200 });
  await post("Profiler.start");
}
async function stopProfile(name) {
  if (!profileDir || !profiler) {
    return;
  }
  if (!profiling) {
    return;
  }
  profiling = false;
  const { profile } = await post("Profiler.stop");
  // Idle pool threads produce empty profiles; keep only threads that ran code.
  if (profile.samples.length > 50) {
    require("node:fs").writeFileSync(
      require("node:path").join(profileDir, name),
      JSON.stringify(profile),
    );
  }
}

const channel = new BroadcastChannel("usage-overview-counters");
channel.unref?.();
// Node BroadcastChannel has no target-origin parameter.
const broadcast = (message) => {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  channel.postMessage(message);
};

if (isMainThread) {
  const workerThreads = require("node:worker_threads");
  const OriginalWorker = workerThreads.Worker;
  class CountingWorker extends OriginalWorker {
    constructor(filename, options = {}) {
      const execArgv = [...(options.execArgv ?? process.execArgv)];
      if (!execArgv.includes(self)) {
        execArgv.push("--import", self);
      }
      super(filename, { ...options, execArgv });
      counters.workersCreated++;
      this.on("message", () => {
        counters.workerMessages++;
      });
    }
    postMessage(...args) {
      counters.workerPostMessage++;
      return super.postMessage(...args);
    }
  }
  workerThreads.Worker = CountingWorker;
  syncBuiltinESMExports();

  const replies = new Map();
  channel.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.kind === "counters" && replies.has(data.id)) {
      replies.get(data.id).push(data);
    }
  });
  let nextId = 1;
  const collect = async (reset) => {
    const id = nextId++;
    replies.set(id, []);
    broadcast({ kind: reset ? "reset" : "snapshot", id });
    await delay(300);
    const workerReplies = replies.get(id);
    replies.delete(id);
    const main = withElu();
    if (reset) {
      resetCounters();
    }
    const workers = zero();
    for (const reply of workerReplies) {
      for (const key of Object.keys(workers)) {
        workers[key] += reply.counters[key] ?? 0;
      }
    }
    return { main, workers, workerThreadsReplied: workerReplies.length };
  };
  process.on("message", async (message) => {
    if (message?.channel !== "usage-overview-counters") {
      return;
    }
    if (message.action === "profile-start" || message.action === "profile-stop") {
      const id = nextId++;
      replies.set(id, []);
      broadcast({ kind: message.action, id, name: message.name });
      await (message.action === "profile-start"
        ? startProfile()
        : stopProfile(`${message.name}-main.cpuprofile`));
      await delay(500);
      replies.delete(id);
      process.send?.({ channel: "usage-overview-counters", requestId: message.requestId });
      return;
    }
    const result = await collect(message.action === "reset");
    process.send?.({ channel: "usage-overview-counters", requestId: message.requestId, ...result });
  });
} else {
  void startProfile();
  channel.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.kind === "profile-start") {
      void startProfile();
    } else if (data?.kind === "profile-stop") {
      void stopProfile(`${data.name}-worker-${threadId}.cpuprofile`);
    } else if (data?.kind === "reset" || data?.kind === "snapshot") {
      broadcast({ kind: "counters", id: data.id, threadId, counters: withElu() });
      if (data.kind === "reset") {
        resetCounters();
      }
    }
  });
}
syncBuiltinESMExports();

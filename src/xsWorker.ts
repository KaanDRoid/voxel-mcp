import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { compileXs, runXsOnVolume, type XsRunOptions, type XsRunResult } from "./xsEval.js";
import type { VoxModelData } from "./vox.js";
import { currentRequestSignal, throwIfRequestAborted } from "./requestContext.js";

interface ShaderJob {
  source: string;
  argumentNames: string[];
  model: VoxModelData;
  options: XsRunOptions;
  maxVoxels: number;
}
type ShaderReply = { result: XsRunResult } | { error: string };

if (!isMainThread) {
  const job = workerData as ShaderJob;
  try {
    const program = compileXs(job.source, job.argumentNames);
    parentPort!.postMessage({ result: runXsOnVolume(program, job.model, job.options, job.maxVoxels) } satisfies ShaderReply);
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) } satisfies ShaderReply);
  }
}

/** CPU-bound evaluation runs outside the protocol thread and is forcibly terminated at the deadline. */
export function runXsInWorker(job: ShaderJob, signal: AbortSignal | undefined = currentRequestSignal()): Promise<XsRunResult> {
  return new Promise((resolve, reject) => {
    throwIfRequestAborted(signal);
    const worker = new Worker(new URL("./xsWorker.js", import.meta.url), {
      workerData: job,
      resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (error?: Error, result?: XsRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // Do not let the transaction or shared queue settle while evaluation is still running.
      void worker.terminate().then(() => {
        try {
          throwIfRequestAborted(signal);
          if (error) reject(error);
          else resolve(result!);
        } catch (reason) { reject(reason); }
      }, reject);
    };
    const abort = () => finish(new Error("Shader evaluation cancelled"));
    const timer = setTimeout(() => finish(new Error(`Shader time limit of ${job.options.timeLimitMs} ms exceeded`)), job.options.timeLimitMs + 250);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    worker.once("message", (message: ShaderReply) => {
      if ("error" in message) finish(new Error(message.error));
      else finish(undefined, message.result);
    });
    worker.once("error", error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once("exit", code => { if (!settled) finish(new Error(`Shader worker exited without a result (code ${code})`)); });
  });
}

import { AsyncLocalStorage } from "node:async_hooks";

const requests = new AsyncLocalStorage<AbortSignal>();
let fatalQueueError: Error | undefined;

/** Permanent fail-closed latch: only restarting the server clears an unconfirmed input helper. */
export function poisonRequestQueue(error: Error): void {
  fatalQueueError ??= error;
}

/** Carries the SDK request signal through legacy handler signatures. */
export function runWithRequestSignal<T>(signal: AbortSignal, operation: () => T): T {
  return requests.run(signal, operation);
}

export function currentRequestSignal(): AbortSignal | undefined {
  return requests.getStore();
}

export function throwIfRequestAborted(signal: AbortSignal | undefined = currentRequestSignal()): void {
  if (fatalQueueError) throw fatalQueueError;
  signal?.throwIfAborted();
}

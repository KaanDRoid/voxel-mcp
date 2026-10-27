import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { makeRunner } from '../src/appControl.js';
import { runWithRequestSignal, throwIfRequestAborted } from '../src/requestContext.js';
import { createTools } from '../src/tools.js';
import { ModelRegistry } from '../src/model.js';
import { MagicaConfig } from '../src/magicaConfig.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
for (const behavior of ['error', 'throw', 'silent'] as const) {
  test(`unconfirmed helper termination (${behavior}) reports a bounded fatal condition`, async () => {
    const controller = new AbortController();
    let kills = 0;
    const child = Object.assign(new EventEmitter(), {
      pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: () => {
        kills++;
        if (behavior === 'throw') throw new Error('EPERM');
        if (behavior === 'error') child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
        return behavior === 'silent';
      },
    });
    let fatal: Error | undefined;
    const run = makeRunner((() => child) as never, { terminationGraceMs: 30, onUnsafeTermination: (error: Error) => { fatal = error; } });
    const outcome = runWithRequestSignal(controller.signal, () => run('fake', {}, 1000)).then(() => 'success', error => String(error));
    controller.abort();
    const result = await Promise.race([outcome, pause(200).then(() => 'STILL_PENDING')]);
    // Clean up the old implementation after observing its failure, without a hanging test process.
    child.emit('close', 1);
    await outcome;
    assert.notEqual(result, 'STILL_PENDING', 'a lost close event must not silently hang forever');
    assert.match(result, /restart|disabled|unsafe/i);
    assert.ok(fatal, 'unsafe termination must latch a fatal condition before settling');
    assert.ok(kills >= 2, 'bounded reaping retries termination');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

test('an unsafe default helper permanently disables queued tools instead of permitting further input or mutation', async () => {
  const controller = new AbortController();
  const child = Object.assign(new EventEmitter(), {
    pid: 456, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => false,
  });
  const run = makeRunner((() => child) as never, { terminationGraceMs: 30 });
  const outcome = runWithRequestSignal(controller.signal, () => run('fake', {}, 1000)).then(() => 'success', error => String(error));
  controller.abort();
  const result = await Promise.race([outcome, pause(200).then(() => 'STILL_PENDING')]);
  child.emit('close', 1);
  await outcome;
  assert.match(result, /restart|disabled|unsafe/i);
  assert.throws(() => throwIfRequestAborted(), /restart|disabled|unsafe/i);
  let spawned = false;
  await assert.rejects(makeRunner((() => { spawned = true; return child; }) as never)('x', {}, 1000), /restart|disabled|unsafe/i);
  assert.equal(spawned, false);
  type Handler = (args: unknown, context: unknown) => Promise<{ isError?: boolean; content: { text?: string }[] }>;
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _definition: unknown, handler: Handler) => { handlers.set(name, handler); },
    registerResource: () => {}, registerPrompt: () => {},
  };
  const registry = new ModelRegistry();
  createTools(server as never, registry, new MagicaConfig());
  const response = await handlers.get('create_model')!({ sizeX: 2, sizeY: 2, sizeZ: 2 }, { mcpReq: { signal: new AbortController().signal } });
  assert.equal(response.isError, true);
  assert.match(response.content[0]!.text!, /restart|disabled|unsafe/i);
  assert.equal(registry.list().length, 0);
});

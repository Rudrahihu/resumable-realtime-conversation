/**
 * Shared helpers for tests and the verification benchmark — deterministic
 * generator control with no arbitrary sleeps, so behaviour under
 * interruption can be driven precisely from calling code.
 */

export async function* simpleGenerate(chunks) {
  for (const c of chunks) yield c;
}

/** A generator whose steps are released one at a time under caller
 *  control, instead of firing immediately — lets tests and the benchmark
 *  deterministically interleave resume()/disconnect with generation
 *  progress. `steps` is an array of
 *  { type: 'chunk', value } | { type: 'error', message }. */
export function createControllableGenerator(steps) {
  const gates = steps.map(() => {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
  });
  let releaseIndex = 0;

  async function* generate() {
    for (let i = 0; i < steps.length; i++) {
      await gates[i].promise;
      const step = steps[i];
      if (step.type === 'error') throw new Error(step.message);
      yield step.value;
    }
  }

  function release() {
    if (releaseIndex >= gates.length) throw new Error('no more steps to release');
    gates[releaseIndex].resolve();
    releaseIndex++;
  }

  return { generate, release };
}

/** Flushes the microtask queue by waiting for the next macrotask boundary.
 *  Not a timing-dependent sleep about how long generation takes — it just
 *  lets already-scheduled continuations (promise resolutions, async
 *  generator steps) run before the caller's next assertion or action. */
export function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Deterministic fake response generator.
 *
 * No real model, no network calls. `delayMs` defaults to 0 (instant) —
 * that's what every test and the benchmark rely on, since none of them
 * pass a delay. The only place that ever sets delayMs is server/index.js,
 * via the STREAM_DELAY_MS env var, purely to slow the stream down enough
 * to demonstrate a mid-stream disconnect during a live demo recording.
 *
 * Contract: an async generator that yields chunks for a given input,
 * optionally failing after N chunks for AC5-style failure testing.
 */

const DEFAULT_REPLY =
  'You said: {input}. Thanks for reaching out.';

export async function* fakeGenerate(input, { failAfter = null, delayMs = 0 } = {}) {
  const words = DEFAULT_REPLY.replace('{input}', input).split(' ');

  for (let i = 0; i < words.length; i++) {
    if (failAfter !== null && i === failAfter) {
      throw new Error('generator-injected-failure');
    }
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    yield words[i] + ' ';
  }
}
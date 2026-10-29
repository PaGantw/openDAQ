const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spectrum, nearest } = require("../static/analysis.js");
const wave = (n, fs, fn) =>
  Array.from({ length: n }, (_, i) => [i / fs, fn(i / fs, i)]);
const close = (actual, expected, tolerance = 1e-8) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${actual} != ${expected}`,
  );

test("Hann spectrum resolves a known tone with coherent-gain-corrected peak amplitude", () => {
  const r = spectrum(
    wave(1024, 4096, (t) => 7 + 3 * Math.sin(2 * Math.PI * 256 * t)),
    1024,
    "hann",
    true,
  );
  assert.equal(r.error, undefined);
  close(r.sampleRate, 4096);
  close(r.resolution, 4);
  close(r.peakFrequency, 256);
  close(r.peakAmplitude, 3);
  close(r.bins[0][1], 0);
});
test("rectangular window preserves DC when requested, and removes it by default", () => {
  const data = wave(512, 2048, () => 4);
  close(spectrum(data, 512, "rectangular", false).bins[0][1], 4);
  assert.equal(spectrum(data, 512).peakFrequency, null);
});
test("single-sided Nyquist amplitude is not doubled", () => {
  const r = spectrum(
    wave(512, 1024, (_, i) => 2.5 * (i % 2 ? -1 : 1)),
    512,
    "rectangular",
    false,
  );
  close(r.peakFrequency, 512);
  close(r.peakAmplitude, 2.5);
});
test("FFT agrees with independent direct DFT for every positive-frequency bin", () => {
  const n = 64,
    data = wave(
      n,
      2048,
      (t, i) =>
        0.3 +
        Math.sin(2 * Math.PI * 96 * t) +
        0.4 * Math.cos(2 * Math.PI * 288 * t) +
        0.01 * (i % 5),
    );
  const r = spectrum(data, n, "hann", false);
  const weights = data.map((_, i) => (1 - Math.cos((2 * Math.PI * i) / n)) / 2),
    gain = weights.reduce((a, b) => a + b, 0);
  for (let k = 0; k <= n / 2; k++) {
    let re = 0,
      im = 0;
    for (let i = 0; i < n; i++) {
      re += weights[i] * data[i][1] * Math.cos((2 * Math.PI * k * i) / n);
      im -= weights[i] * data[i][1] * Math.sin((2 * Math.PI * k * i) / n);
    }
    close(
      r.bins[k][1],
      (Math.hypot(re, im) / gain) * (k === 0 || k === n / 2 ? 1 : 2),
    );
  }
});
test("uses the newest complete frame instead of stale buffered samples", () => {
  const data = wave(2048, 4096, (t, i) =>
    Math.sin(2 * Math.PI * (i < 1024 ? 128 : 512) * t),
  );
  close(spectrum(data, 1024).peakFrequency, 512);
});
test("does not manufacture a spectrum from insufficient, gapped or nonfinite samples", () => {
  assert.ok(
    spectrum(
      wave(20, 1000, () => 1),
      512,
    ).error,
  );
  for (const value of [null, NaN, Infinity]) {
    const data = wave(512, 1000, () => 1);
    data[200][1] = value;
    assert.ok(spectrum(data, 512).error);
  }
  const data = wave(512, 1000, () => 1);
  data[200][0] += 0.0002;
  assert.ok(spectrum(data, 512).error);
  data[200][0] = data[199][0];
  assert.ok(spectrum(data, 512).error);
});
test("rejects invalid size and window options", () => {
  for (const n of [0, 63, 100, 16384, 512.5]) assert.ok(spectrum([], n).error);
  assert.ok(spectrum([], 512, "unknown").error);
});
test("cursor snaps to real finite samples and handles boundaries", () => {
  const data = [
    [0, 1],
    [0.1, null],
    [0.2, 3],
    [0.3, 4],
  ];
  assert.deepEqual(nearest(data, 0.15), [0.2, 3]);
  assert.deepEqual(nearest(data, -1), [0, 1]);
  assert.deepEqual(nearest(data, 5), [0.3, 4]);
  assert.equal(nearest([], 1), null);
});

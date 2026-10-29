/* Pure numerical helpers shared by the browser and the Node regression tests. */
(function (root) {
  "use strict";
  function nearest(points, time) {
    let found = null,
      distance = Infinity;
    for (const point of points) {
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
      const delta = Math.abs(point[0] - time);
      if (delta < distance) {
        distance = delta;
        found = point;
      }
    }
    return found ? [...found] : null;
  }
  function spectrum(points, size = 1024, window = "hann", removeDC = true) {
    if (
      !Number.isInteger(size) ||
      size < 64 ||
      size > 8192 ||
      size & (size - 1)
    )
      return { error: "FFT 長度必須為 64–8192 的 2 次方" };
    if (!["hann", "rectangular"].includes(window))
      return { error: "不支援的窗函數" };
    if (points.length < size)
      return {
        error: `等待完整資料：需要 ${size} 筆，目前 ${points.length} 筆`,
      };
    const samples = points.slice(-size);
    if (samples.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1])))
      return { error: "資料包含缺失或非數值樣本，無法計算頻譜" };
    const dt = (samples[size - 1][0] - samples[0][0]) / (size - 1);
    if (!(dt > 0) || !Number.isFinite(1 / dt))
      return { error: "訊號時間軸無效" };
    const tolerance = Math.max(
      dt * 0.01,
      Number.EPSILON * Math.max(1, Math.abs(samples[size - 1][0])) * 16,
    );
    if (
      samples
        .slice(1)
        .some(
          (p, i) =>
            p[0] <= samples[i][0] ||
            Math.abs(p[0] - samples[i][0] - dt) > tolerance,
        )
    )
      return { error: "時間軸非等間隔或有資料中斷，暫不計算 FFT" };
    const mean = removeDC
      ? samples.reduce((sum, p) => sum + p[1] / size, 0)
      : 0;
    const real = new Float64Array(size),
      imag = new Float64Array(size);
    let windowSum = 0;
    for (let i = 0; i < size; i++) {
      const w =
        window === "hann" ? 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size) : 1;
      real[i] = (samples[i][1] - mean) * w;
      windowSum += w;
    }
    for (let i = 1, j = 0; i < size; i++) {
      let bit = size >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
      }
    }
    for (let length = 2; length <= size; length <<= 1) {
      const angle = (-2 * Math.PI) / length,
        stepR = Math.cos(angle),
        stepI = Math.sin(angle);
      for (let start = 0; start < size; start += length) {
        let wr = 1,
          wi = 0;
        for (let j = 0; j < length / 2; j++) {
          const a = start + j,
            b = a + length / 2;
          const tr = wr * real[b] - wi * imag[b],
            ti = wr * imag[b] + wi * real[b];
          real[b] = real[a] - tr;
          imag[b] = imag[a] - ti;
          real[a] += tr;
          imag[a] += ti;
          const next = wr * stepR - wi * stepI;
          wi = wr * stepI + wi * stepR;
          wr = next;
        }
      }
    }
    const sampleRate = 1 / dt,
      resolution = sampleRate / size,
      bins = [];
    let peakIndex = removeDC ? 1 : 0;
    for (let i = 0; i <= size / 2; i++) {
      const factor = i === 0 || i === size / 2 ? 1 : 2;
      const amplitude = (factor * Math.hypot(real[i], imag[i])) / windowSum;
      if (!Number.isFinite(amplitude)) return { error: "數值超出頻譜計算範圍" };
      bins.push([i * resolution, amplitude]);
    }
    for (let i = peakIndex + 1; i < bins.length; i++)
      if (bins[i][1] > bins[peakIndex][1]) peakIndex = i;
    return {
      bins,
      size,
      sampleRate,
      resolution,
      window,
      removeDC,
      peakFrequency: bins[peakIndex][1] > 1e-12 ? bins[peakIndex][0] : null,
      peakAmplitude: bins[peakIndex][1],
    };
  }
  const api = { nearest, spectrum };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DAQAnalysis = api;
})(globalThis);

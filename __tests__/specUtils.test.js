import { describe, it, expect } from "vitest";
import { METRICS, evaluateSpec, specVerdict, validateSpec, specDomain } from "../lib/specUtils.js";

const RATE = 1000; // 1 ms samples
const dt = 1 / RATE;
const series = (fn, tEnd) => Array.from({ length: Math.round(tEnd * RATE) + 1 }, (_, k) => fn(k * dt));

// First order: y = 1 - e^(-t/tau)
const tau = 0.5;
const first = series((t) => 1 - Math.exp(-t / tau), 10);
// Underdamped second order, unit step: wn = 2, zeta = 0.3
const wn = 2, zeta = 0.3, wd = wn * Math.sqrt(1 - zeta * zeta), phi = Math.acos(zeta);
const second = series((t) => 1 - Math.exp(-zeta * wn * t) * Math.sin(wd * t + phi) / Math.sqrt(1 - zeta * zeta), 20);
const tran = (y) => ({ kind: "tran", y, sampleRate: RATE });
const m = (name, capture, params = {}) => METRICS[name].measure(capture.kind === "tran" ? { y: capture.y, dt: 1 / capture.sampleRate } : capture, { ...(METRICS[name].params || {}), ...params });

describe("time-domain metrics against analytic answers", () => {
  it("first order: final value 1, no overshoot, rise time 2.197 tau, 2 % settling 3.912 tau", () => {
    expect(m("finalValue", tran(first))).toBeCloseTo(1, 4);
    expect(m("overshootPct", tran(first))).toBeCloseTo(0, 6);
    expect(m("riseTime", tran(first))).toBeCloseTo(Math.log(9) * tau, 2);
    expect(m("settlingTime", tran(first))).toBeCloseTo(-Math.log(0.02) * tau, 2);
  });

  it("second order: overshoot = 100 exp(-pi zeta / sqrt(1 - zeta^2))", () => {
    const expected = 100 * Math.exp(-Math.PI * zeta / Math.sqrt(1 - zeta * zeta));
    expect(m("overshootPct", tran(second))).toBeCloseTo(expected, 1);
    expect(m("peak", tran(second))).toBeCloseTo(1 + expected / 100, 3);
  });

  it("steady-state error, value at t, windowed average / ripple / rms", () => {
    const y = series((t) => 0.9 + 0.05 * Math.sin(2 * Math.PI * 50 * t), 1);
    expect(m("steadyStateError", tran(first), { target: 1 })).toBeLessThan(1e-4);
    expect(m("valueAt", tran(first), { t: tau })).toBeCloseTo(1 - Math.exp(-1), 4);
    expect(m("average", tran(y), { from: 0.5, to: 1 })).toBeCloseTo(0.9, 3);
    expect(m("ripplePkPk", tran(y))).toBeCloseTo(0.1, 3);
    expect(m("rms", tran(series(() => 2, 1)))).toBeCloseTo(2, 9);
  });

  it("never-rising signals give no rise time instead of a wrong number", () => {
    expect(m("riseTime", tran(series(() => 0, 1)))).toBeNull();
  });

  it("handles 200k-sample captures (no spread-argument stack overflow)", () => {
    const y = Array.from({ length: 200_000 }, (_, i) => Math.sin(i / 1000));
    expect(m("peak", { kind: "tran", y, sampleRate: 1e5 })).toBeCloseTo(1, 3);
  });
});

describe("AC metrics: RC low-pass, fc = 1591.5 Hz", () => {
  const fc = 1 / (2 * Math.PI * 1e3 * 100e-9);
  const f = Array.from({ length: 101 }, (_, i) => 10 ** (1 + i * 0.05)); // 10 Hz .. 1 MHz, 20/decade
  const H = f.map((x) => ({ re: 1 / (1 + (x / fc) ** 2), im: -(x / fc) / (1 + (x / fc) ** 2) }));
  const ac = { kind: "ac", f, magDb: H.map((h) => 20 * Math.log10(Math.hypot(h.re, h.im))), phaseDeg: H.map((h) => (Math.atan2(h.im, h.re) * 180) / Math.PI) };

  it("f3dB, gain and phase at fc, low-frequency gain", () => {
    expect(m("f3dB", ac) / fc).toBeCloseTo(1, 2);
    expect(m("gainAt", ac, { f: fc })).toBeCloseTo(-3.01, 1);
    expect(m("phaseAt", ac, { f: fc })).toBeCloseTo(-45, 0);
    expect(m("dcGainDb", ac)).toBeCloseTo(0, 3);
    expect(m("unityGainFreq", ac)).toBeNull(); // starts at 0 dB and only falls: never crosses up through it
  });
});

describe("evaluateSpec / specVerdict", () => {
  const spec = [
    { metric: "overshootPct", op: "<=", value: 40 },
    { metric: "finalValue", op: "≈", value: 1, tol: 0.01 },
    { metric: "settlingTime", op: "<=", value: 1 },
  ];

  it("passes and fails check by check", () => {
    const r = evaluateSpec(spec, tran(second));
    expect(r.checks.map((c) => c.passed)).toEqual([true, true, false]);
    expect(r.passed).toBe(false);
    expect(specVerdict(r)).toMatchObject({ passed: false, score: "66.67", message: "1 of 3 checks failed" });
    const ok = evaluateSpec(spec.slice(0, 2), tran(second));
    expect(specVerdict(ok)).toMatchObject({ passed: true, score: "100.00", message: "Accepted" });
  });

  it("refuses a capture from the wrong analysis, and non-finite samples", () => {
    expect(evaluateSpec([{ metric: "f3dB", op: ">=", value: 1 }], tran(first)).error).toMatch(/AC sweep/);
    expect(evaluateSpec(spec, tran([0, NaN, 1])).error).toMatch(/finite/);
    expect(specVerdict(evaluateSpec(spec, tran([0, NaN, 1])))).toMatchObject({ passed: false, message: "Not graded" });
  });

  it("validates what a creator wrote", () => {
    expect(validateSpec([])).toHaveLength(1);
    expect(validateSpec([{ metric: "nope", op: "<", value: "x" }])).toHaveLength(3);
    expect(validateSpec([{ metric: "finalValue", op: "≈", value: 1 }])[0]).toMatch(/tolerance/);
    expect(validateSpec([{ metric: "finalValue", op: "<=", value: 1 }, { metric: "f3dB", op: ">=", value: 1 }])[0]).toMatch(/Mix/);
    expect(specDomain(spec)).toBe("tran");
  });
});

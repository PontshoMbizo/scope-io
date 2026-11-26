import { describe, it, expect } from "vitest";
import { goldensFromRun, goldensReady } from "../lib/goldenCapture.js";
import { decodeWaveform } from "../lib/waveformCodec.js";

const step = (n, rate) => Array.from({ length: n }, (_, k) => 1 - Math.exp(-(k / rate) / 0.5));
const spiceTran = (runs) => ({ ok: true, code: "{\"format\":\"fulgurspice-schematic\"}", capture: { kind: "tran", runs } });
const run = (y, rate = 100) => ({ sampleRate: rate, output: y, input: [] });

describe("goldensFromRun", () => {
  it("fulgurspice signal, waveform: one packed golden at full resolution", () => {
    const y = step(501, 100);
    const r = goldensFromRun({ simulatorType: "fulgurspice", testType: "signal", testConfig: { criteria: "waveform" }, payload: spiceTran([run(y)]) });
    expect(r.ok).toBe(true);
    expect(r.goldens.test1.decimation).toBe(1);
    expect(r.goldens.test1.sampleRate).toBe(100);
    expect(decodeWaveform(r.goldens.test1.samples)[250]).toBeCloseTo(y[250], 5);
    expect(r.referenceCode).toContain("fulgurspice");
  });

  it("fulgurspice load: three goldens from the three sweep runs, or a clear error with one run", () => {
    const r = goldensFromRun({ simulatorType: "fulgurspice", testType: "load", testConfig: { criteria: "waveform" }, payload: spiceTran([run([0, 1]), run([0, 2]), run([0, 3])]) });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.goldens).sort()).toEqual(["specSnapshot", "test1", "test2", "test3"]);
    const one = goldensFromRun({ simulatorType: "fulgurspice", testType: "load", testConfig: { criteria: "waveform" }, payload: spiceTran([run([0, 1])]) });
    expect(one.ok).toBe(false);
  });

  it("spec criteria: the reference must meet its own spec", () => {
    const tc = { criteria: "spec", spec: [{ metric: "finalValue", op: "≈", value: 1, tol: 0.01 }] };
    expect(goldensFromRun({ simulatorType: "fulgurspice", testType: "signal", testConfig: tc, payload: spiceTran([run(step(1001, 100))]) }).ok).toBe(true);
    const bad = goldensFromRun({ simulatorType: "fulgurspice", testType: "signal", testConfig: { ...tc, spec: [{ metric: "finalValue", op: "≈", value: 2, tol: 0.01 }] }, payload: spiceTran([run(step(1001, 100))]) });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/does not meet the spec — Final value: 1/);
  });

  it("AC sweeps only with spec checks", () => {
    const payload = { ok: true, code: "{}", capture: { kind: "ac", runs: [{ f: [10, 100, 1000, 10000], magDb: [0, -0.1, -3.5, -20], phaseDeg: [0, -5, -45, -84] }] } };
    expect(goldensFromRun({ simulatorType: "fulgurspice", testType: "signal", testConfig: { criteria: "waveform" }, payload }).error).toMatch(/transient/);
    const ok = goldensFromRun({ simulatorType: "fulgurspice", testType: "signal", testConfig: { criteria: "spec", spec: [{ metric: "f3dB", op: ">=", value: 500 }] }, payload });
    expect(ok.ok).toBe(true);
    expect(ok.goldens.test1).toMatchObject({ kind: "ac", samples: "" });
  });

  it("fulgurlab: takes the chosen scope input, with the diagram's sample step", () => {
    const payload = { ok: true, code: JSON.stringify({ settings: { tf: 1, dt: 0.01 } }), scopes: { response: { t: [0, 0.01, 0.02], y: [[0, 0.5, 0.75], [9, 9, 9]] } } };
    const r = goldensFromRun({ simulatorType: "fulgurlab", testType: "signal", testConfig: { criteria: "waveform", scope: "response", input: 0 }, payload });
    expect(r.ok).toBe(true);
    expect(r.goldens.test1.sampleRate).toBeCloseTo(100, 9);
    expect(decodeWaveform(r.goldens.test1.samples)).toEqual([0, 0.5, 0.75]);
    expect(goldensFromRun({ simulatorType: "fulgurlab", testType: "signal", testConfig: { criteria: "waveform" }, payload }).error).toMatch(/Pick the scope/);
    expect(goldensFromRun({ simulatorType: "fulgurlab", testType: "signal", testConfig: { scope: "nope" }, payload }).error).toMatch(/no trace/);
  });

  it("passes a failed run's log through", () => {
    expect(goldensFromRun({ simulatorType: "fulgurlab", testType: "signal", payload: { ok: false, log: "Algebraic loop" } })).toEqual({ ok: false, error: "Algebraic loop" });
  });

  it("goldensReady: complete, and captured against the current spec", () => {
    const tc = { criteria: "spec", spec: [{ metric: "finalValue", op: "≈", value: 1, tol: 0.01 }] };
    const r = goldensFromRun({ simulatorType: "fulgurspice", testType: "signal", testConfig: tc, payload: spiceTran([run(step(1001, 100))]) });
    expect(goldensReady({ testType: "signal", testConfig: tc, goldens: r.goldens })).toBe(true);
    expect(goldensReady({ testType: "signal", testConfig: { ...tc, spec: [] }, goldens: r.goldens })).toBe(false);
    expect(goldensReady({ testType: "load", testConfig: tc, goldens: r.goldens })).toBe(false);
  });
});

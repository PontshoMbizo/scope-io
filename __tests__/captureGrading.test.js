import { describe, it, expect, vi } from "vitest";
import { gradeContinuousCapture, resimulateFulgurlab } from "../lib/captureGrading.js";
import { encodeWaveform } from "../lib/waveformCodec.js";

const RATE = 100;
const N = 1001;
const ys = (tau) => Array.from({ length: N }, (_, k) => 1 - Math.exp(-(k / RATE) / tau));
const golden = { test1: { samples: encodeWaveform(ys(0.5)), sampleRate: RATE, decimation: 1, decimationError: 0 } };
const problem = { timeStep: String(1 / RATE) };

const starter = {
  version: 1,
  settings: { tf: 10, dt: 0.01 },
  blocks: [
    { id: "step", type: "step", params: { time: 0 }, locked: true },
    { id: "plant", type: "transferFn", params: { num: [1], den: [0.5, 1] }, locked: true },
    { id: "k", type: "gain", params: { gain: 1 } },
    { id: "response", type: "scope", params: { inputs: 1 }, locked: true },
  ],
  links: [],
};

describe("gradeContinuousCapture", () => {
  const base = { problem, testType: "signal", topics: ["Control Systems"], solutionsMap: golden, testKey: "test1" };

  it("waveform: the reference itself is accepted, a slower response is not", () => {
    const ok = gradeContinuousCapture({ ...base, testbench: { criteria: "waveform" }, capture: { kind: "tran", output: ys(0.5), input: [], sampleRate: RATE } });
    expect(ok.ok).toBe(true);
    expect(ok.passed).toBe(true);
    expect(ok.testResult.type).toBe("analog");
    const slow = gradeContinuousCapture({ ...base, testbench: { criteria: "waveform" }, capture: { kind: "tran", output: ys(2), input: [], sampleRate: RATE } });
    expect(slow.passed).toBe(false);
  });

  it("waveform: refuses a different time step and an AC capture", () => {
    const r = gradeContinuousCapture({ ...base, testbench: {}, capture: { kind: "tran", output: ys(0.5), sampleRate: RATE * 2 } });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.error).toMatch(/time step/);
    expect(gradeContinuousCapture({ ...base, testbench: {}, capture: { kind: "ac", f: [1, 2], magDb: [0, -1] } }).error).toMatch(/transient/);
  });

  it("spec: any design meeting the spec passes, with the reference trace for display", () => {
    const testbench = { criteria: "spec", spec: [{ metric: "finalValue", op: "≈", value: 1, tol: 0.01 }, { metric: "settlingTime", op: "<=", value: 4 }] };
    const fast = gradeContinuousCapture({ ...base, testbench, capture: { kind: "tran", output: ys(0.2), sampleRate: RATE } });
    expect(fast.passed).toBe(true);
    expect(fast.testResult).toMatchObject({ type: "spec", domain: "tran" });
    expect(fast.testResult.solutionData).toHaveLength(N);
    const slow = gradeContinuousCapture({ ...base, testbench, capture: { kind: "tran", output: ys(2), sampleRate: RATE } });
    expect(slow.passed).toBe(false);
    expect(slow.testResult.checks[1].passed).toBe(false);
  });

  it("rejects non-finite or oversized captures", () => {
    expect(gradeContinuousCapture({ ...base, testbench: { criteria: "spec", spec: [{ metric: "peak", op: "<=", value: 1 }] }, capture: { kind: "tran", output: [0, Infinity], sampleRate: RATE } }).status).toBe(400);
    expect(gradeContinuousCapture({ ...base, testbench: {}, capture: { kind: "tran", output: new Array(200_001).fill(0), sampleRate: RATE } }).status).toBe(400);
  });
});

describe("resimulateFulgurlab", () => {
  const testbench = { scope: "response", input: 0 };
  const okBody = { ok: true, scopes: { response: { t: [0, 0.01, 0.02], y: [[0, 0.5, 0.7]] } } };
  const reply = (status, body) => vi.fn(async () => ({ status, json: async () => body }));
  const p = { starterCode: JSON.stringify(starter) };
  const submit = (net) => ({ netlist: JSON.stringify(net) });
  const opts = (fetchImpl) => ({ apiUrl: "http://lab", token: "t0k", fetchImpl });

  it("sends the diagram with the grader token and returns the scope trace at 1/dt", async () => {
    const f = reply(200, okBody);
    const net = structuredClone(starter); net.blocks[2].params.gain = 7;
    const r = await resimulateFulgurlab({ problem: p, testbench, capturedData: submit(net) }, opts(f));
    expect(r.ok).toBe(true);
    expect(r.capture).toMatchObject({ kind: "tran", output: [0, 0.5, 0.7], sampleRate: 100, timeLabels: ["0.0000", "10.0000", "20.0000"] });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("http://lab/api/simulate");
    expect(init.headers.Authorization).toBe("Bearer t0k");
    expect(JSON.parse(init.body).blocks[2].params.gain).toBe(7);
  });

  it("refuses a tampered locked block before simulating anything", async () => {
    const f = reply(200, okBody);
    const net = structuredClone(starter); net.blocks[1].params.den = [0.01, 1];
    const r = await resimulateFulgurlab({ problem: p, testbench, capturedData: submit(net) }, opts(f));
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(r.error).toMatch(/locked block "plant" was changed/);
    expect(f).not.toHaveBeenCalled();
  });

  it("turns server answers into learner-facing errors", async () => {
    const bad = await resimulateFulgurlab({ problem: p, testbench, capturedData: submit(starter) }, opts(reply(422, { ok: false, error: "The diagram has problems", issues: [{ message: "input 1 of Gain \"k\" is not connected" }] })));
    expect(bad).toMatchObject({ ok: false, status: 400 });
    expect(bad.error).toMatch(/not connected/);
    expect((await resimulateFulgurlab({ problem: p, testbench, capturedData: submit(starter) }, opts(reply(429, {})))).status).toBe(503);
    const noScope = await resimulateFulgurlab({ problem: p, testbench: { scope: "other" }, capturedData: submit(starter) }, opts(reply(200, okBody)));
    expect(noScope.error).toMatch(/"other" produced no trace/);
    const down = await resimulateFulgurlab({ problem: p, testbench, capturedData: submit(starter) }, opts(vi.fn(async () => { throw new TypeError("fetch failed"); })));
    expect(down).toMatchObject({ ok: false, status: 502 });
  });

  it("needs a configured server, JSON text and a readable starter", async () => {
    expect((await resimulateFulgurlab({ problem: p, testbench, capturedData: submit(starter) }, { apiUrl: "" })).status).toBe(503);
    expect((await resimulateFulgurlab({ problem: p, testbench, capturedData: { netlist: "{nope" } }, opts(reply(200, okBody)))).status).toBe(400);
    expect((await resimulateFulgurlab({ problem: p, testbench, capturedData: {} }, opts(reply(200, okBody)))).status).toBe(400);
    expect((await resimulateFulgurlab({ problem: { starterCode: "" }, testbench, capturedData: submit(starter) }, opts(reply(200, okBody)))).status).toBe(500);
    expect((await resimulateFulgurlab({ problem: p, testbench, capturedData: { netlist: "x".repeat(600_000) } }, opts(reply(200, okBody)))).status).toBe(413);
  });
});

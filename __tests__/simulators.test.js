import { describe, it, expect } from "vitest";
import { getSimulator, isContinuousSim, bridgeConfig, captureFromPayload, gradePayload, fulgurlabScopes, starterTimeStep, parseSpiceNumber } from "../lib/simulators.js";

describe("simulator registry", () => {
  it("defaults to circuitjs and knows every grade kind", () => {
    expect(getSimulator(undefined).grade).toBe("circuitjs");
    expect(getSimulator("fpga").grade).toBe("sequence");
    expect(getSimulator("fulgurlab").grade).toBe("resim");
    expect(getSimulator("fulgurspice").grade).toBe("trace");
    expect(getSimulator("nope")).toBeNull();
    expect(isContinuousSim("fulgurlab") && isContinuousSim("fulgurspice") && !isContinuousSim("mcu")).toBe(true);
  });

  it("bridge config: spice load problems sweep RLOAD over the three loads, only outside export", () => {
    const tb = { noload: 1e12, maxload: 100, minload: 10, output: "vout", input: "vin" };
    expect(bridgeConfig("fulgurspice", "solve", "load", tb)).toEqual({
      probes: { output: "vout", input: "vin" }, lockAnalysis: true, theme: "light",
      sweep: { param: "RLOAD", values: "1000000000000 100 10" },
    });
    expect(bridgeConfig("fulgurspice", "export", "load", tb).sweep).toBeUndefined();
    expect(bridgeConfig("fulgurlab", "capture", "signal")).toEqual({ lockSettings: true, theme: "light" });
    expect(bridgeConfig("fpga", "solve", "signal")).toBeUndefined();
  });

  it("turns a spice transient payload into one analog capture, or a load sweep", () => {
    const run = (v) => ({ sampleRate: 1000, output: [v, v, v], input: [] });
    const single = captureFromPayload("fulgurspice", { ok: true, code: "{}", capture: { kind: "tran", runs: [run(1)] } }, "signal");
    expect(single).toMatchObject({ ok: true, kind: "tran", data: { output: [1, 1, 1], input: [0, 0, 0] }, sampleRate: 1000, timeLabels: ["0.0000", "1.0000", "2.0000"] });
    const sweep = captureFromPayload("fulgurspice", { ok: true, code: "{}", capture: { kind: "tran", runs: [run(1), run(2), run(3)] } }, "load");
    expect(sweep.type).toBe("loadSweep");
    expect(sweep.tests.test3.data.output).toEqual([3, 3, 3]);
    expect(captureFromPayload("fulgurspice", { ok: true, capture: { kind: "tran", runs: [run(1)] } }, "load").ok).toBe(false);
    expect(captureFromPayload("fulgurspice", { ok: false, log: "boom" }, "signal")).toEqual({ ok: false, log: "boom" });
  });

  it("builds the grade request body per simulator", () => {
    expect(gradePayload("fulgurlab", "signal", { code: "{\"a\":1}" })).toEqual({ netlist: "{\"a\":1}" });
    expect(gradePayload("mcu", "signal", { changes: [1] })).toEqual({ changes: [1] });
    expect(gradePayload("fulgurspice", "signal", { kind: "ac", f: [1], magDb: [0], phaseDeg: [0] })).toEqual({ kind: "ac", f: [1], magDb: [0], phaseDeg: [0] });
    expect(gradePayload("fulgurspice", "signal", { kind: "tran", data: { output: [1], input: [0] }, sampleRate: 5, timeLabels: ["0"] })).toEqual({ kind: "tran", output: [1], input: [0], sampleRate: 5, timeLabels: ["0"] });
    expect(gradePayload("circuitjs", "digital", { table: [1] })).toEqual({ table: [1] });
  });

  it("reads scopes and time steps from starters", () => {
    const net = { settings: { dt: 0.05 }, blocks: [{ id: "s", type: "scope", params: { inputs: 2 } }, { id: "sub", type: "subsystem", system: { blocks: [{ id: "s2", type: "scope", name: "Inner" }] } }] };
    expect(fulgurlabScopes(JSON.stringify(net))).toEqual([{ id: "s", name: "s", inputs: 2 }, { id: "sub/s2", name: "Inner", inputs: 1 }]);
    expect(starterTimeStep("fulgurlab", net)).toBe(0.05);
    expect(starterTimeStep("fulgurspice", { analysis: { kind: "tran", step: "10u", stop: "1m" } })).toBeCloseTo(1e-5, 12);
    expect(parseSpiceNumber("1MEG")).toBe(1e6);
    expect(parseSpiceNumber("4.7m")).toBeCloseTo(4.7e-3, 12);
    expect(parseSpiceNumber("abc")).toBeNull();
  });
});

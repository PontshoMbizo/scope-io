import { describe, it, expect } from "vitest";
import { checkLocked, canonical } from "../lib/fulgurlabIntegrity.js";

const starter = () => ({
  version: 1,
  settings: { tf: 10, dt: 0.01 },
  blocks: [
    { id: "step", type: "step", params: { time: 0, final: 1 }, locked: true, x: 0, y: 0 },
    { id: "plant", type: "transferFn", params: { num: [1], den: [1, 2, 1] }, locked: true, name: "Plant" },
    { id: "ctrl", type: "gain", params: { gain: 1 } },
    { id: "fwd", type: "subsystem", locked: true, system: { blocks: [{ id: "in", type: "inport", params: { index: 1 } }, { id: "out", type: "outport", params: { index: 1 } }], links: [{ from: { block: "in", port: 0 }, to: { block: "out", port: 0 } }] } },
    { id: "scope", type: "scope", params: { inputs: 1 }, locked: true },
  ],
  links: [],
});

describe("checkLocked", () => {
  it("accepts a submission that only changes unlocked blocks, moves locked ones and rewires", () => {
    const sub = starter();
    sub.blocks[2].params.gain = 25;
    sub.blocks[0].x = 300;
    sub.blocks[1] = { ...sub.blocks[1], params: { den: [1, 2, 1], num: [1] } }; // key order differs
    sub.links = [{ from: { block: "step", port: 0 }, to: { block: "ctrl", port: 0 } }];
    sub.blocks.push({ id: "pid", type: "pid", params: { p: 1, i: 1, d: 0 } });
    expect(checkLocked(starter(), sub)).toEqual({ ok: true, errors: [] });
  });

  it("rejects a changed, replaced or missing locked block", () => {
    const changed = starter(); changed.blocks[1].params.den = [1, 1];
    expect(checkLocked(starter(), changed).errors[0]).toMatch(/"Plant" \(plant\) was changed/);
    const replaced = starter(); replaced.blocks[1] = { id: "plant", type: "gain", params: { gain: 1 } };
    expect(checkLocked(starter(), replaced).errors[0]).toMatch(/replaced by a gain block/);
    const missing = starter(); missing.blocks = missing.blocks.filter((b) => b.id !== "scope");
    expect(checkLocked(starter(), missing).errors[0]).toMatch(/"scope" is missing/);
  });

  it("checks the inside of a locked subsystem", () => {
    const sub = starter();
    sub.blocks[3].system.blocks.push({ id: "g", type: "gain", params: { gain: 9 } });
    expect(checkLocked(starter(), sub).ok).toBe(false);
  });

  it("rejects changed run settings and non-diagrams", () => {
    const sub = starter(); sub.settings.tf = 100;
    expect(checkLocked(starter(), sub).errors[0]).toMatch(/stop time must stay 10/);
    expect(checkLocked(starter(), "nope").ok).toBe(false);
  });

  it("canonical JSON ignores key order and undefined", () => {
    expect(canonical({ b: 1, a: [1, { y: 2, x: undefined }] })).toBe(canonical({ a: [1, { y: 2 }], b: 1 }));
  });
});

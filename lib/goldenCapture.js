// Creator Studio: turn the reference run a continuous simulator (fulgurlab, fulgurspice) sent back
// into the golden docs a problem stores. Pure, so the rules are tested without a browser:
//   - waveform criteria: a transient trace per test key, packed (and decimated for long load runs)
//     exactly like CircuitJS goldens, so /api/grade's analog path reads them unchanged;
//   - spec criteria: the reference must pass its own spec (catches a spec nobody can meet), and its
//     trace is kept for the Solutions tab and the result chart, not for grading.

import { captureFromPayload, LOAD_PARAM } from "./simulators.js";
import { encodeWaveform, decimate, computeDecimation } from "./waveformCodec.js";
import { gradingUtils } from "./gradingUtils.js";
import { evaluateSpec, validateSpec } from "./specUtils.js";

// A packed float32 sample is ~5.3 base64 characters; keep a golden doc well under Firestore's 1 MiB.
export const MAX_GOLDEN_SAMPLES = 100_000;

/** Test keys a problem's testType grades. */
const keysFor = (testType) => (testType === "load" ? ["test1", "test2", "test3"] : ["test1"]);

/** The spec snapshot a set of goldens was checked against, so editing the spec forces a re-capture. */
export const specSnapshot = (testConfig) => (testConfig?.criteria === "spec" ? JSON.stringify(testConfig.spec || []) : "");

/** fulgurlab: the graded scope's input trace from a capture-mode payload ({ code, scopes }). */
function fulgurlabCaptures(payload, testConfig) {
  const scope = String(testConfig?.scope || "");
  if (!scope) return { error: "Pick the scope to grade first, then capture again." };
  const trace = payload.scopes?.[scope];
  const y = trace?.y?.[Number(testConfig.input) || 0];
  if (!Array.isArray(y)) return { error: `Scope "${scope}" (input ${(Number(testConfig.input) || 0) + 1}) produced no trace.` };
  let dt = NaN;
  try { dt = Number(JSON.parse(payload.code).settings?.dt); } catch { /* checked below */ }
  if (!(dt > 0)) return { error: "The diagram has no sample step." };
  return { captures: { test1: { kind: "tran", data: { output: y }, sampleRate: 1 / dt } } };
}

/**
 * @param {{ simulatorType: string, testType: string, testConfig: object, payload: object }} args
 * @returns {{ ok: true, goldens: object, referenceCode: string, summary: string } | { ok: false, error: string }}
 */
export function goldensFromRun({ simulatorType, testType, testConfig = {}, payload }) {
  if (!payload) return { ok: false, error: "The simulator sent nothing back." };
  if (payload.ok === false) return { ok: false, error: payload.log || "The reference run failed." };
  const criteria = testConfig.criteria === "spec" ? "spec" : "waveform";
  if (criteria === "spec") {
    const errors = validateSpec(testConfig.spec);
    if (errors.length) return { ok: false, error: `Fix the spec first: ${errors.join("; ")}` };
  }

  let captures;
  if (simulatorType === "fulgurlab") {
    const r = fulgurlabCaptures(payload, testConfig);
    if (r.error) return { ok: false, error: r.error };
    captures = r.captures;
  } else if (simulatorType === "fulgurspice") {
    const c = captureFromPayload(simulatorType, payload, testType);
    if (c.ok === false) return { ok: false, error: c.log };
    captures = c.type === "loadSweep" ? c.tests : { test1: c };
    if (testType === "load" && c.type !== "loadSweep") {
      return { ok: false, error: `Expected three runs (one per load). Give the load resistor the value {${LOAD_PARAM}}.` };
    }
  } else {
    return { ok: false, error: `${simulatorType} goldens are not continuous traces.` };
  }

  const goldens = {};
  for (const key of keysFor(testType)) {
    const cap = captures[key];
    if (!cap) return { ok: false, error: `No capture for ${key}.` };
    if (cap.kind === "ac") {
      if (criteria !== "spec") return { ok: false, error: "Waveform match needs a transient analysis. Use spec checks for an AC sweep." };
      const r = evaluateSpec(testConfig.spec, { kind: "ac", f: cap.f, magDb: cap.magDb, phaseDeg: cap.phaseDeg });
      if (r.error || !r.passed) return { ok: false, error: failText(r, key, testType) };
      goldens[key] = { kind: "ac", samples: "", sampleRate: null, decimation: 1, decimationError: 0, length: cap.f.length };
      continue;
    }
    const output = cap.data?.output || [];
    if (output.length < 2) return { ok: false, error: `${key}: the reference run produced no samples.` };
    if (!output.every((v) => typeof v === "number" && isFinite(v))) return { ok: false, error: `${key}: the reference trace has values that are not finite numbers.` };
    if (criteria === "spec") {
      const r = evaluateSpec(testConfig.spec, { kind: "tran", y: output, sampleRate: cap.sampleRate });
      if (r.error || !r.passed) return { ok: false, error: failText(r, key, testType) };
    }
    // Same storage as CircuitJS goldens: signal problems keep full resolution, long load runs decimate.
    const D = computeDecimation(output.length, testType);
    const stored = decimate(output, D);
    if (stored.length > MAX_GOLDEN_SAMPLES) {
      return { ok: false, error: `${key}: ${output.length.toLocaleString()} samples is more than a problem can store (${MAX_GOLDEN_SAMPLES.toLocaleString()}). Use a larger step or a shorter run.` };
    }
    goldens[key] = {
      kind: "tran",
      samples: encodeWaveform(stored),
      sampleRate: cap.sampleRate,
      decimation: D,
      decimationError: D > 1 ? gradingUtils.decimationError(output, D) : 0,
      length: output.length,
    };
  }
  const n = Object.values(goldens)[0].length;
  return {
    ok: true,
    goldens: { ...goldens, specSnapshot: specSnapshot(testConfig) },
    referenceCode: payload.code || "",
    summary: `${keysFor(testType).length === 3 ? "All three loads" : "Reference"} captured (${n.toLocaleString()} ${goldens.test1.kind === "ac" ? "frequencies" : "samples"}${criteria === "spec" ? ", spec met" : ""}).`,
  };
}

function failText(r, key, testType) {
  if (r.error) return r.error;
  const failed = r.checks.filter((c) => !c.passed)
    .map((c) => `${c.label}: ${c.actual === null ? "not found" : Number(c.actual.toPrecision(4))} (target ${c.op} ${c.value}${c.op === "≈" ? ` ± ${c.tol}` : ""})`);
  return `Your reference${testType === "load" ? ` (${key})` : ""} does not meet the spec — ${failed.join("; ")}. Fix the reference or the spec.`;
}

/** Are the stored goldens complete and still valid for the current spec? */
export function goldensReady(problem) {
  const g = problem.goldens || {};
  if (!keysFor(problem.testType).every((k) => g[k])) return false;
  return g.specSnapshot === specSnapshot(problem.testConfig);
}

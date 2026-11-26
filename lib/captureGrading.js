// Capture grading for /api/grade, pure enough to test without Firestore: the
// caller passes the problem doc and its solution docs. Moved out of the route
// unchanged (gradeAnalogCapture) or alongside it (the fulgurlab / fulgurspice
// graders). The route stays the trust boundary: it reads the problem from
// Firestore and only ever hands these functions that data plus the request body.

import { gradingUtils } from "./gradingUtils.js";
import { signalUtils } from "./signalUtils.js";
import { decodeWaveform, decimate } from "./waveformCodec.js";
import { evaluateSpec, specVerdict } from "./specUtils.js";
import { checkLocked } from "./fulgurlabIntegrity.js";

// Hard caps so a hostile payload can't make the FFT/NRMSE loops chew CPU.
export const MAX_ANALOG_SAMPLES = 200_000;
const MAX_AC_POINTS = 10_000;
// Allowed relative drift between the user's capture rate and the stored
// solution rate before we refuse to compare waveforms sample-by-sample.
const SAMPLE_RATE_TOLERANCE = 0.05;
// fulgurlab re-simulation: the body cap the fulgurlab server enforces, and how
// long a run may take before the grade gives up.
const MAX_NETLIST_BYTES = 512 * 1024;
const FULGURLAB_TIMEOUT_MS = 25_000;

// Validate + grade a single analog (load/signal) capture against its golden.
// Returns { ok: true, testResult, passed } or { ok: false, status, error }.
// This is the analog half of the trust boundary — both the single-test path
// and the batched load-sweep path run every capture through it, so validation
// (shape, size, sample rate, dead output) and grading live in exactly one place.
export function gradeAnalogCapture({ problem, testType, testbench, topics, solutionsMap, testKey, capturedData }) {
  if (!capturedData || !Array.isArray(capturedData.output) || !Array.isArray(capturedData.input)) {
    return { ok: false, status: 400, error: "capturedData.output and .input must be arrays for analog problems" };
  }
  if (capturedData.output.length > MAX_ANALOG_SAMPLES || capturedData.input.length > MAX_ANALOG_SAMPLES) {
    return { ok: false, status: 400, error: `capturedData arrays exceed the maximum of ${MAX_ANALOG_SAMPLES} samples` };
  }
  const allFinite = (arr) => arr.every(v => typeof v === "number" && isFinite(v));
  if (!allFinite(capturedData.output) || !allFinite(capturedData.input)) {
    return { ok: false, status: 400, error: "capturedData arrays must contain only finite numbers" };
  }

  const { output: userVout = [], input: userVin = [], timeLabels = [], sampleRate = 1 } = capturedData;
  const resistanceMap = {
    test1: testbench.noload || 1e12,
    test2: testbench.maxload || 1,
    test3: testbench.minload || 1,
  };
  const activeResistance = Number(resistanceMap[testKey]);
  const solKey = testType === "signal" ? "test1" : testKey;
  const solutionDoc = solutionsMap[solKey] || {};
  // Decode the golden (packed "f32:" form or legacy newline text — handled
  // transparently). The golden may be stored decimated; `decimation` is the
  // stored stride (1 for legacy/undecimated docs).
  const solOutData = decodeWaveform(solutionDoc.samples || "");
  const D = Math.max(1, Math.floor(Number(solutionDoc.decimation) || 1));

  if (solOutData.length === 0) {
    console.error(`[grade] Empty solution data for key ${solKey}`);
    return { ok: false, status: 500, error: "Solution data is missing or malformed. Contact the problem creator." };
  }

  // Decimate the user capture by the same stride so we compare like-for-like
  // against the (possibly decimated) golden. D=1 → no-op (legacy behavior).
  const userVoutDec = decimate(userVout, D);
  const userVinDec = decimate(userVin, D);

  // A submission shorter than the solution would only be compared over its own
  // length — matching the first N samples would be enough to pass. Require a
  // full-length capture (expressed in full-resolution samples for the user).
  if (userVoutDec.length < solOutData.length) {
    return {
      ok: false,
      status: 400,
      error: `Capture too short: got ${userVout.length} samples, expected at least ${solOutData.length * D}. Reset the simulator and capture the full window.`,
    };
  }

  // Comparing sample-by-sample is meaningless if the user's simulator runs at a
  // different time step than the one the solution was captured with. The rate
  // check uses the user's *full* capture rate against the problem's declared
  // step / the golden's stored (full) rate — decimation doesn't change it.
  const userRate = Number(sampleRate);
  const declaredStep = Number(problem.timeStep);
  const declaredRate = declaredStep > 0 ? 1 / declaredStep : NaN;
  const storedRate = Number(solutionDoc.sampleRate);
  const within = (ref) =>
    isFinite(ref) && ref > 0 && Math.abs(userRate - ref) / ref <= SAMPLE_RATE_TOLERANCE;
  const haveReference =
    (isFinite(declaredRate) && declaredRate > 0) || (isFinite(storedRate) && storedRate > 0);
  if (isFinite(userRate) && userRate > 0 && haveReference) {
    if (!within(declaredRate) && !within(storedRate)) {
      console.warn(`[grade] Rate mismatch for ${testKey}: userRate=${userRate}, declaredRate=${declaredRate}, storedRate=${storedRate}`);
      return {
        ok: false,
        status: 400,
        error: "Simulation time step doesn't match this problem's reference. Reset the circuit template (which restores the correct time step) and capture again.",
      };
    }
  }

  // Align lengths after decimation so the NRMSE/FFT compare like-for-like (and
  // so getFrequencyData's vin.length === vout.length precondition always holds,
  // even when the user captured a few samples more than the golden).
  const m = Math.min(userVoutDec.length, solOutData.length);
  const uOut = userVoutDec.slice(0, m);
  const uIn = userVinDec.slice(0, m);
  const sOut = solOutData.slice(0, m);
  const labels = decimate(timeLabels, D).slice(0, m);
  // Spectral frequencies scale with the decimated rate.
  const effectiveRate = userRate / D;

  // Reject obviously-miswired captures (floating output / probe on the wrong
  // node / open circuit) with an actionable message rather than an opaque NRMSE
  // miss. Does not fire when the golden is itself flat (legitimate DC problems).
  if (gradingUtils.isDeadOutput(uOut, sOut)) {
    return {
      ok: false,
      status: 400,
      error: "Output never changed — check that the voltmeter is across the output node and the circuit isn't floating or open.",
    };
  }

  const targetBode = signalUtils.getFrequencyData(uIn, sOut, effectiveRate);
  const userBode = signalUtils.getFrequencyData(uIn, uOut, effectiveRate);

  // Hybrid analog grade: 70% time-domain NRMSE, 20% frequency-domain, 10% key
  // features. Aligned magnitude spectra (uOut/sOut are equal-length → same FFT
  // size → directly comparable bins, unlike the bin-skipping Bode arrays).
  const userMag = signalUtils.getMagnitudeSpectrum(uOut);
  const goldMag = signalUtils.getMagnitudeSpectrum(sOut);
  const dtDecimated = effectiveRate > 0 ? 1 / effectiveRate : 1;
  const hybrid = gradingUtils.calculateHybridError({
    user: uOut, golden: sOut, userSpectrum: userMag, goldenSpectrum: goldMag, dt: dtDecimated,
  });

  // Headroom for the error the decimation itself injects into the reference
  // (computed + stored at publish time). 0 for legacy/undecimated goldens, so
  // the pass decision is identical to a plain hybrid grade there.
  const decimationTolerance = Number(solutionDoc.decimationError) || 0;
  const effectiveError = Math.max(0, hybrid.error - decimationTolerance);

  const verdict = gradingUtils.getVerdict(effectiveError, topics, false);
  const testResult = {
    type: "analog",
    isSignalOnly: testType === "signal",
    resistance: activeResistance,
    timeLabels: labels,
    userData: uOut,
    solutionData: sOut,
    verdict: {
      ...verdict,
      // nrmse kept for back-compat with the existing Results UI; the hybrid
      // breakdown is exposed alongside for richer feedback.
      nrmse: hybrid.timeError,
      hybridError: hybrid.error,
      effectiveError,
      decimationTolerance,
      components: {
        time: hybrid.timeError,
        freq: hybrid.freqError,
        feature: hybrid.featureError,
        weights: gradingUtils.HYBRID_WEIGHTS,
      },
    },
    freqLabels: targetBode.freq,
    // getFrequencyData skips near-zero bins per call, so the user's and the
    // golden's freq arrays can differ — each series must carry its own x-axis.
    userFreqLabels: userBode.freq,
    userSpectrum: userBode.outputSpectrum,
    solutionSpectrum: targetBode.outputSpectrum,
    userBodeMag: userBode.bodeMag,
    userBodePhase: userBode.bodePhase,
    solutionBodeMag: targetBode.bodeMag,
    solutionBodePhase: targetBode.bodePhase,
  };
  return { ok: true, testResult, passed: !!verdict.passed };
}

const finiteArray = (a, max) => Array.isArray(a) && a.length <= max && a.every((v) => typeof v === "number" && isFinite(v));

// Grade one continuous capture (fulgurspice trace, or a re-simulated fulgurlab
// scope) by the problem's criteria: "spec" measures it and checks each target;
// anything else is the CircuitJS-style hybrid waveform match against the golden.
// `capture` is { kind: "tran", output, input, sampleRate, timeLabels } or
// { kind: "ac", f, magDb, phaseDeg }. Returns the same shape as gradeAnalogCapture.
export function gradeContinuousCapture({ problem, testType, testbench, topics, solutionsMap, testKey, capture }) {
  const kind = capture?.kind === "ac" ? "ac" : "tran";
  if (kind === "ac") {
    if (!finiteArray(capture.f, MAX_AC_POINTS) || !finiteArray(capture.magDb, MAX_AC_POINTS) || (capture.phaseDeg !== undefined && !finiteArray(capture.phaseDeg, MAX_AC_POINTS))) {
      return { ok: false, status: 400, error: `An AC capture needs f, magDb (and phaseDeg) arrays of at most ${MAX_AC_POINTS} finite numbers` };
    }
  } else {
    if (!finiteArray(capture?.output, MAX_ANALOG_SAMPLES)) {
      return { ok: false, status: 400, error: `capturedData.output must be an array of at most ${MAX_ANALOG_SAMPLES} finite numbers` };
    }
  }

  if (testbench.criteria === "spec") {
    const measured = kind === "ac"
      ? { kind, f: capture.f, magDb: capture.magDb, phaseDeg: capture.phaseDeg }
      : { kind, y: capture.output, sampleRate: Number(capture.sampleRate) };
    const result = evaluateSpec(testbench.spec, measured);
    if (result.error) return { ok: false, status: 400, error: result.error };
    const verdict = specVerdict(result);
    const golden = kind === "tran" ? decodeWaveform(solutionsMap[testType === "signal" ? "test1" : testKey]?.samples || "") : [];
    const D = Math.max(1, Math.floor(Number(solutionsMap[testKey]?.decimation) || 1));
    const testResult = {
      type: "spec",
      domain: kind,
      checks: result.checks,
      verdict,
      ...(kind === "tran"
        ? {
            timeLabels: capture.timeLabels || capture.output.map((_, i) => ((i / Number(capture.sampleRate)) * 1000).toFixed(4)),
            userData: capture.output,
            // the reference run, for comparison only (not graded): undo its decimation on the time axis
            solutionData: golden.length ? capture.output.map((_, i) => golden[Math.floor(i / D)] ?? null) : undefined,
          }
        : { freqLabels: capture.f, userFreqLabels: capture.f, userBodeMag: capture.magDb, userBodePhase: capture.phaseDeg || [] }),
    };
    return { ok: true, testResult, passed: verdict.passed };
  }

  if (kind === "ac") {
    return { ok: false, status: 400, error: "This problem compares waveforms over time: set the analysis to transient." };
  }
  const n = capture.output.length;
  const input = Array.isArray(capture.input) && capture.input.length === n ? capture.input : new Array(n).fill(0);
  return gradeAnalogCapture({
    problem, testType, testbench, topics, solutionsMap, testKey,
    capturedData: { output: capture.output, input, timeLabels: capture.timeLabels || [], sampleRate: capture.sampleRate },
  });
}

// fulgurlab: never trust traces from the browser. Check the submitted diagram
// kept the starter's locked blocks and run settings, then simulate it on the
// fulgurlab server and take the graded scope's trace.
// Returns { ok: true, capture } or { ok: false, status, error }.
export async function resimulateFulgurlab({ problem, testbench, capturedData }, {
  apiUrl = (process.env.FULGURLAB_API_URL || "").replace(/\/$/, ""),
  token = process.env.FULGURLAB_GRADER_TOKEN || "",
  fetchImpl = fetch,
} = {}) {
  const raw = capturedData?.netlist;
  const text = typeof raw === "string" ? raw : raw && typeof raw === "object" ? JSON.stringify(raw) : null;
  if (!text) return { ok: false, status: 400, error: "capturedData.netlist must be the diagram (JSON text) for fulgurlab problems" };
  if (Buffer.byteLength(text) > MAX_NETLIST_BYTES) return { ok: false, status: 413, error: "The diagram is too large to grade." };
  let submitted, starter;
  try { submitted = JSON.parse(text); } catch { return { ok: false, status: 400, error: "The diagram is not valid JSON." }; }
  try { starter = JSON.parse(problem.starterCode || ""); } catch {
    return { ok: false, status: 500, error: "Problem is misconfigured (unreadable starter diagram). Contact the problem creator." };
  }

  const integrity = checkLocked(starter, submitted);
  if (!integrity.ok) return { ok: false, status: 400, error: integrity.errors.join("\n") };

  if (!apiUrl) {
    console.error("[grade] FULGURLAB_API_URL is not set — cannot grade fulgurlab problems.");
    return { ok: false, status: 503, error: "The block-diagram grader is not configured on this server." };
  }
  let res, body;
  try {
    res = await fetchImpl(`${apiUrl}/api/simulate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: text,
      signal: AbortSignal.timeout(FULGURLAB_TIMEOUT_MS),
    });
    body = await res.json().catch(() => null);
  } catch (err) {
    console.error("[grade] fulgurlab unreachable:", err?.name, err?.message);
    return { ok: false, status: 502, error: err?.name === "TimeoutError" ? "The simulation took too long to grade." : "The simulation server could not be reached. Try again shortly." };
  }
  if (res.status === 429) return { ok: false, status: 503, error: "The simulation server is busy. Try again in a minute." };
  if (!body || typeof body !== "object") return { ok: false, status: 502, error: `The simulation server answered ${res.status} without a result.` };
  if (!body.ok) {
    // An invalid diagram or a Scilab failure: the learner's to fix, so show why.
    const issues = Array.isArray(body.issues) ? body.issues.map((i) => `- ${i.message}`) : [];
    return { ok: false, status: res.status >= 500 ? 502 : 400, error: [body.error || "The diagram could not be simulated.", ...issues].join("\n") };
  }

  const scopeId = String(testbench.scope || "");
  const trace = body.scopes?.[scopeId];
  const y = trace?.y?.[Number(testbench.input) || 0];
  if (!Array.isArray(y) || !Array.isArray(trace.t)) {
    return { ok: false, status: 400, error: `The graded scope "${scopeId}" produced no trace. Keep the problem's scope block, and wire its input.` };
  }
  const dt = Number(submitted.settings?.dt) || Number(starter.settings?.dt);
  return {
    ok: true,
    capture: {
      kind: "tran",
      output: y,
      input: new Array(y.length).fill(0),
      sampleRate: dt > 0 ? 1 / dt : NaN,
      timeLabels: trace.t.map((t) => (t * 1000).toFixed(4)),
    },
  };
}


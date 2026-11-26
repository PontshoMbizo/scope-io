// Spec-based grading: measure a waveform and check each measurement against a target, instead of
// comparing it with a golden sample by sample. A design problem ("PID with < 10 % overshoot") has many
// right answers; a spec accepts all of them. Pure, shared by Creator Studio and /api/grade.
//
// A spec is stored on the problem (testbench.spec) as a list of checks:
//   { metric: "overshootPct", op: "<=", value: 10 }
//   { metric: "settlingTime", params: { band: 0.02 }, op: "<=", value: 2 }
//   { metric: "finalValue", op: "≈", value: 1, tol: 0.01 }
// A capture is { kind: "tran", y: number[], sampleRate } (sample k at t = k / sampleRate)
//            or { kind: "ac", f: number[], magDb: number[], phaseDeg: number[] }.

const tail = (y, frac = 0.05) => y.slice(Math.max(0, y.length - Math.max(1, Math.floor(y.length * frac))));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
// Loops, not Math.max(...a): a capture can have 200k samples, more than the engine's argument limit.
const maxOf = (a) => { let m = -Infinity; for (const v of a) if (v > m) m = v; return m; };
const minOf = (a) => { let m = Infinity; for (const v of a) if (v < m) m = v; return m; };

/** Linear interpolation of y over ascending x; null outside the range. */
function interp(x, y, xv) {
  const n = x.length;
  if (!n || xv < x[0] || xv > x[n - 1]) return null;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (x[mid] <= xv) lo = mid; else hi = mid; }
  const dx = x[hi] - x[lo];
  return dx === 0 ? y[lo] : y[lo] + ((y[hi] - y[lo]) * (xv - x[lo])) / dx;
}

/** Index i where y first crosses `level` (going from y[0]'s side to the other), as a fractional index; null if never. */
function firstCrossing(y, level, from = 0) {
  const above = y[from] >= level;
  for (let i = from + 1; i < y.length; i++) {
    if ((y[i] >= level) !== above) {
      const d = y[i] - y[i - 1];
      return d === 0 ? i : i - 1 + (level - y[i - 1]) / d;
    }
  }
  return null;
}

/** Interpolate on log-frequency, which is how Bode data is spaced. */
const logInterp = (f, y, fv) => (fv > 0 ? interp(f.map(Math.log10), y, Math.log10(fv)) : null);

function stepInfo(y) {
  const y0 = y[0];
  const final = mean(tail(y));
  return { y0, final, step: final - y0 };
}

function windowOf(y, dt, params = {}) {
  const tEnd = (y.length - 1) * dt;
  const from = Number.isFinite(Number(params.from)) ? Number(params.from) : tEnd * 0.8;
  const to = Number.isFinite(Number(params.to)) ? Number(params.to) : tEnd;
  const i0 = Math.max(0, Math.ceil(from / dt - 1e-9)), i1 = Math.min(y.length - 1, Math.floor(to / dt + 1e-9));
  return i1 >= i0 ? y.slice(i0, i1 + 1) : [];
}

/**
 * Every metric a spec can check. `domain` says which capture it needs; `params` lists the optional
 * parameters the creator can set (with defaults); `unit` is for display.
 */
export const METRICS = {
  // ── time domain ──
  finalValue: { label: "Final value", unit: "", domain: "tran", hint: "Mean of the last 5 % of the run",
    measure: ({ y }) => stepInfo(y).final },
  peak: { label: "Maximum", unit: "", domain: "tran", measure: ({ y }) => maxOf(y) },
  minimum: { label: "Minimum", unit: "", domain: "tran", measure: ({ y }) => minOf(y) },
  overshootPct: { label: "Overshoot", unit: "%", domain: "tran", hint: "Beyond the final value, as % of the step",
    measure: ({ y }) => {
      const { final, step } = stepInfo(y);
      if (Math.abs(step) < 1e-12) return 0;
      const extreme = step > 0 ? maxOf(y) : minOf(y);
      return Math.max(0, ((extreme - final) / step) * 100);
    } },
  riseTime: { label: "Rise time (10–90 %)", unit: "s", domain: "tran",
    measure: ({ y, dt }) => {
      const { y0, step } = stepInfo(y);
      if (Math.abs(step) < 1e-12) return null;
      const a = firstCrossing(y, y0 + 0.1 * step), b = firstCrossing(y, y0 + 0.9 * step);
      return a === null || b === null ? null : (b - a) * dt;
    } },
  settlingTime: { label: "Settling time", unit: "s", domain: "tran", params: { band: 0.02 }, hint: "Last time outside ±band × step of the final value",
    measure: ({ y, dt }, p) => {
      const { final, step } = stepInfo(y);
      const band = (Number(p.band) > 0 ? Number(p.band) : 0.02) * (Math.abs(step) > 1e-12 ? Math.abs(step) : Math.max(Math.abs(final), 1e-12));
      for (let i = y.length - 1; i >= 0; i--) if (Math.abs(y[i] - final) > band) return Math.min(i + 1, y.length - 1) * dt;
      return 0;
    } },
  steadyStateError: { label: "Steady-state error", unit: "", domain: "tran", params: { target: 1 }, hint: "|target − final value|",
    measure: ({ y }, p) => Math.abs((Number.isFinite(Number(p.target)) ? Number(p.target) : 1) - stepInfo(y).final) },
  valueAt: { label: "Value at t", unit: "", domain: "tran", params: { t: 0 },
    measure: ({ y, dt }, p) => interp(y.map((_, i) => i * dt), y, Number(p.t) || 0) },
  rms: { label: "RMS", unit: "", domain: "tran", params: { from: undefined, to: undefined }, hint: "Over [from, to] s; default the last 20 %",
    measure: ({ y, dt }, p) => { const w = windowOf(y, dt, p); return w.length ? Math.sqrt(mean(w.map((v) => v * v))) : null; } },
  average: { label: "Average", unit: "", domain: "tran", params: { from: undefined, to: undefined }, hint: "Over [from, to] s; default the last 20 %",
    measure: ({ y, dt }, p) => { const w = windowOf(y, dt, p); return w.length ? mean(w) : null; } },
  ripplePkPk: { label: "Ripple (peak to peak)", unit: "", domain: "tran", params: { from: undefined, to: undefined }, hint: "Over [from, to] s; default the last 20 %",
    measure: ({ y, dt }, p) => { const w = windowOf(y, dt, p); return w.length ? maxOf(w) - minOf(w) : null; } },
  // ── frequency domain (AC analysis) ──
  dcGainDb: { label: "Low-frequency gain", unit: "dB", domain: "ac", measure: ({ magDb }) => magDb[0] },
  peakGainDb: { label: "Peak gain", unit: "dB", domain: "ac", measure: ({ magDb }) => maxOf(magDb) },
  f3dB: { label: "−3 dB frequency", unit: "Hz", domain: "ac", hint: "First frequency 3 dB below the low-frequency gain",
    measure: ({ f, magDb }) => {
      const level = magDb[0] - 3;
      const i = firstCrossing(magDb, level);
      if (i === null) return null;
      const k = Math.floor(i), w = i - k;
      return k + 1 < f.length ? 10 ** (Math.log10(f[k]) + w * (Math.log10(f[k + 1]) - Math.log10(f[k]))) : f[k];
    } },
  unityGainFreq: { label: "Unity-gain frequency", unit: "Hz", domain: "ac",
    measure: ({ f, magDb }) => {
      const i = firstCrossing(magDb, 0);
      if (i === null) return null;
      const k = Math.floor(i), w = i - k;
      return k + 1 < f.length ? 10 ** (Math.log10(f[k]) + w * (Math.log10(f[k + 1]) - Math.log10(f[k]))) : f[k];
    } },
  gainAt: { label: "Gain at f", unit: "dB", domain: "ac", params: { f: 1000 }, measure: ({ f, magDb }, p) => logInterp(f, magDb, Number(p.f)) },
  phaseAt: { label: "Phase at f", unit: "°", domain: "ac", params: { f: 1000 }, measure: ({ f, phaseDeg }, p) => logInterp(f, phaseDeg, Number(p.f)) },
};

export const OPS = ["<=", ">=", "≈"];

/** Problems with a spec as written by a creator; [] when it is usable. */
export function validateSpec(spec) {
  const errors = [];
  if (!Array.isArray(spec) || spec.length === 0) return ["Add at least one check"];
  spec.forEach((c, i) => {
    const where = `Check ${i + 1}`;
    if (!METRICS[c?.metric]) errors.push(`${where}: unknown metric "${c?.metric}"`);
    if (!OPS.includes(c?.op)) errors.push(`${where}: the comparison must be <=, >= or ≈`);
    if (!Number.isFinite(Number(c?.value))) errors.push(`${where}: the target must be a number`);
    if (c?.op === "≈" && !(Number(c?.tol) >= 0)) errors.push(`${where}: ≈ needs a tolerance of 0 or more`);
  });
  const domains = new Set(spec.map((c) => METRICS[c?.metric]?.domain).filter(Boolean));
  if (domains.size > 1) errors.push("Mix of time-domain and AC checks: a problem runs one analysis");
  return errors;
}

/** The analysis a spec needs ("tran" or "ac"), or null for an empty or invalid spec. */
export const specDomain = (spec) => (Array.isArray(spec) && METRICS[spec[0]?.metric]?.domain) || null;

function captureProblem(capture, domain) {
  if (!capture || typeof capture !== "object") return "No capture to measure";
  if (domain === "tran") {
    if (!Array.isArray(capture.y) || capture.y.length < 2) return "The capture has no time-domain samples";
    if (!(Number(capture.sampleRate) > 0)) return "The capture has no sample rate";
    if (!capture.y.every(Number.isFinite)) return "The capture has values that are not finite numbers";
    return null;
  }
  const { f, magDb, phaseDeg } = capture;
  if (!Array.isArray(f) || f.length < 2 || !Array.isArray(magDb) || magDb.length !== f.length) return "The capture has no AC sweep";
  if (Array.isArray(phaseDeg) && phaseDeg.length !== f.length) return "The AC capture's phase and frequency lists differ in length";
  if (!f.every((v) => Number.isFinite(v) && v > 0) || !magDb.every(Number.isFinite)) return "The AC capture has values that are not finite numbers";
  return null;
}

/**
 * Measure a capture and check it against a spec.
 * Returns { passed, checks: [{ metric, label, unit, op, value, tol, actual, passed }], error? }.
 */
export function evaluateSpec(spec, capture) {
  const errors = validateSpec(spec);
  if (errors.length) return { passed: false, checks: [], error: `The problem's spec is invalid: ${errors.join("; ")}` };
  const domain = specDomain(spec);
  const kind = capture?.kind || (Array.isArray(capture?.y) ? "tran" : Array.isArray(capture?.f) ? "ac" : null);
  if (kind !== domain) {
    return { passed: false, checks: [], error: domain === "ac" ? "This problem is checked on an AC sweep: set the analysis to AC" : "This problem is checked on a transient run: set the analysis to transient" };
  }
  const bad = captureProblem(capture, domain);
  if (bad) return { passed: false, checks: [], error: bad };

  const data = domain === "tran"
    ? { y: capture.y, dt: 1 / Number(capture.sampleRate) }
    : { f: capture.f, magDb: capture.magDb, phaseDeg: capture.phaseDeg || capture.f.map(() => 0) };
  const checks = spec.map((c) => {
    const m = METRICS[c.metric];
    const params = { ...(m.params || {}), ...(c.params || {}) };
    let actual = m.measure(data, params);
    if (!Number.isFinite(actual)) actual = null;
    const value = Number(c.value), tol = Number(c.tol) || 0;
    const passed = actual !== null && (
      c.op === "<=" ? actual <= value
        : c.op === ">=" ? actual >= value
          : Math.abs(actual - value) <= tol
    );
    return { metric: c.metric, label: m.label, unit: m.unit, params, op: c.op, value, ...(c.op === "≈" ? { tol } : {}), actual, passed };
  });
  return { passed: checks.every((c) => c.passed), checks };
}

/** Score and message in the shape gradingUtils.getVerdict returns, for the Results UI. */
export function specVerdict(result) {
  const n = result.checks.length;
  const ok = result.checks.filter((c) => c.passed).length;
  const passed = !result.error && n > 0 && ok === n;
  return {
    passed,
    score: n ? ((ok / n) * 100).toFixed(2) : "0.00",
    message: passed ? "Accepted" : result.error ? "Not graded" : `${n - ok} of ${n} check${n === 1 ? "" : "s"} failed`,
  };
}

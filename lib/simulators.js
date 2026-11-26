// One entry per simulator a problem can use (`Problems.simulatorType`). Every place that used to
// ask "is this circuitjs?" or "is this fpga?" asks the registry instead, so a new simulator is one
// entry here plus its grading branch in app/api/grade/route.js.
//
// grade:
//   "circuitjs" – same-origin CircuitJS iframe; analog/digital captures (lib/samplingUtils.js)
//   "sequence"  – embedded; the sim posts a value-change list, compared exactly (fpga, mcu)
//   "resim"     – embedded; the sim posts its diagram and scope.io's server re-simulates it (fulgurlab)
//   "trace"     – embedded; the sim posts sampled traces, graded like CircuitJS analog or by spec (fulgurspice)
//
// The NEXT_PUBLIC_* reads must stay literal so Next inlines them into the client bundle.

export const SIMULATORS = {
  circuitjs: {
    id: "circuitjs",
    label: "CircuitJS",
    embedded: false,
    grade: "circuitjs",
  },
  fpga: {
    id: "fpga",
    label: "FPGA · Tang Nano 9K",
    embedded: true,
    grade: "sequence",
    codeFormat: "text",
    src: process.env.NEXT_PUBLIC_NIKA_URL,
    title: "FPGA / Verilog",
    envVar: "NEXT_PUBLIC_NIKA_URL",
  },
  mcu: {
    id: "mcu",
    label: "MCU · STM32 Blue Pill",
    embedded: true,
    grade: "sequence",
    codeFormat: "text",
    src: process.env.NEXT_PUBLIC_STM_URL,
    title: "MCU / Bare-metal C",
    envVar: "NEXT_PUBLIC_STM_URL",
  },
  fulgurlab: {
    id: "fulgurlab",
    label: "Control system · fulgurlab",
    embedded: true,
    grade: "resim",
    codeFormat: "json",
    src: process.env.NEXT_PUBLIC_FULGURLAB_URL,
    title: "Control Systems / Block Diagrams",
    envVar: "NEXT_PUBLIC_FULGURLAB_URL",
  },
  fulgurspice: {
    id: "fulgurspice",
    label: "Circuit · SPICE",
    embedded: true,
    grade: "trace",
    codeFormat: "json",
    src: process.env.NEXT_PUBLIC_FULGURSPICE_URL,
    title: "Circuits / SPICE",
    envVar: "NEXT_PUBLIC_FULGURSPICE_URL",
  },
};

/** The registry entry for a problem's simulatorType; absent means the original engine, CircuitJS. */
export const getSimulator = (type) => SIMULATORS[type || "circuitjs"] || null;
export const isEmbeddedSim = (type) => !!getSimulator(type)?.embedded;
/** Simulators graded on continuous waveforms (waveform match or spec checks). */
export const isContinuousSim = (type) => ["resim", "trace"].includes(getSimulator(type)?.grade);

/** Props for <SimulatorEmbed> ({ src, title, envVar }). */
export const embedProps = (type) => {
  const s = getSimulator(type);
  return s?.embedded ? { src: s.src, title: s.title, envVar: s.envVar } : {};
};

/** The load-sweep parameter a fulgurspice load problem's locked load resistor uses: R = {RLOAD}. */
export const LOAD_PARAM = "RLOAD";

/**
 * The `config` sent in scopeio:init (bridge protocol 2) for a simulator, mode and problem testbench.
 * `testbench` is the stored problem testbench (or the creator's in-progress one).
 */
export function bridgeConfig(type, mode, testType, testbench = {}) {
  const locked = mode !== "export";
  if (type === "fulgurlab") return { lockSettings: locked, theme: "light" };
  if (type === "fulgurspice") {
    const loads = [testbench.noload ?? 1e12, testbench.maxload, testbench.minload];
    return {
      probes: { output: testbench.output || "out", ...(testbench.input ? { input: testbench.input } : {}) },
      lockAnalysis: locked,
      // the problem's analysis wins over whatever a saved draft carries
      ...(locked && testbench.analysis ? { analysis: testbench.analysis } : {}),
      theme: "light",
      ...(testType === "load" && locked && loads.every((v) => Number(v) > 0)
        ? { sweep: { param: LOAD_PARAM, values: loads.map((v) => String(Number(v))).join(" ") } }
        : {}),
    };
  }
  return undefined;
}

const msLabels = (n, sampleRate) => Array.from({ length: n }, (_, i) => ((i / sampleRate) * 1000).toFixed(4));

/** One fulgurspice transient run in the shape AutoMarker / the grade API take for analog captures. */
function tranCapture(run) {
  return {
    kind: "tran",
    data: { output: run.output, input: run.input?.length === run.output.length ? run.input : run.output.map(() => 0) },
    sampleRate: run.sampleRate,
    timeLabels: msLabels(run.output.length, run.sampleRate),
  };
}

/**
 * Turn an embedded simulator's scopeio:result payload into what AutoMarker grades.
 *   sequence (fpga/mcu): unchanged ({ code, ok, log, changes }).
 *   resim (fulgurlab):   { ok, code, log } — the server re-simulates `code`.
 *   trace (fulgurspice): one analog capture, a { type: "loadSweep", tests } for load problems, or an AC capture.
 * A failed run stays { ok: false, log } so AutoMarker shows the simulator's message.
 */
export function captureFromPayload(type, payload, testType) {
  const sim = getSimulator(type);
  if (!payload || payload.ok === false || sim?.grade !== "trace") return payload;
  const cap = payload.capture;
  if (!cap || !Array.isArray(cap.runs) || cap.runs.length === 0) {
    return { ok: false, code: payload.code, log: "The simulator sent no capture to grade." };
  }
  if (cap.kind === "ac") {
    const r = cap.runs[0];
    return { ok: true, code: payload.code, kind: "ac", f: r.f, magDb: r.magDb, phaseDeg: r.phaseDeg };
  }
  if (testType === "load") {
    if (cap.runs.length < 3) return { ok: false, code: payload.code, log: "A load problem needs three runs (no load, max load, min load)." };
    return {
      ok: true,
      code: payload.code,
      type: "loadSweep",
      tests: { test1: tranCapture(cap.runs[0]), test2: tranCapture(cap.runs[1]), test3: tranCapture(cap.runs[2]) },
    };
  }
  return { ok: true, code: payload.code, ...tranCapture(cap.runs[0]) };
}

/** The `capturedData` body for /api/grade from one capture AutoMarker holds. */
export function gradePayload(type, testType, data) {
  const grade = getSimulator(type)?.grade;
  if (grade === "sequence") return { changes: data.changes };
  if (grade === "resim") return { netlist: data.code };
  const analog = {
    output: data.data?.output || [],
    input: data.data?.input || [],
    timeLabels: data.timeLabels,
    sampleRate: data.sampleRate,
  };
  if (grade === "trace") {
    return data.kind === "ac"
      ? { kind: "ac", f: data.f, magDb: data.magDb, phaseDeg: data.phaseDeg }
      : { kind: "tran", ...analog };
  }
  return testType === "digital" ? { table: data.table } : analog;
}

/** Scope ids (id paths for scopes inside subsystems) in a fulgurlab diagram, for the creator's picker. */
export function fulgurlabScopes(code) {
  let net;
  try { net = typeof code === "string" ? JSON.parse(code) : code; } catch { return []; }
  const out = [];
  const walk = (level, prefix) => {
    for (const b of level?.blocks || []) {
      if (b.type === "scope") out.push({ id: prefix + b.id, name: b.name || b.id, inputs: Number(b.params?.inputs) || 1 });
      if (b.type === "subsystem" && b.system) walk(b.system, `${prefix}${b.id}/`);
    }
  };
  walk(net, "");
  return out;
}

/** The time grid of a starter: fulgurlab settings.dt, or a fulgurspice transient step (seconds). */
export function starterTimeStep(type, code) {
  try {
    const doc = typeof code === "string" ? JSON.parse(code) : code;
    if (type === "fulgurlab") return Number(doc?.settings?.dt) || null;
    if (type === "fulgurspice" && doc?.analysis?.kind === "tran") return parseSpiceNumber(doc.analysis.step);
  } catch { /* not JSON yet */ }
  return null;
}

/** The analysis kind of a fulgurspice starter ("tran", "ac", …), or null. */
export function spiceAnalysisKind(code) {
  try { return JSON.parse(code)?.analysis?.kind || null; } catch { return null; }
}

const SPICE_MULT = { t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, "µ": 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
/** "10u" -> 1e-5. SPICE rules: m = milli, meg = mega, case-insensitive. Null when not a number. */
export function parseSpiceNumber(text) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmuµnpf])?[a-z]*$/i.exec(String(text ?? "").trim());
  if (!m) return null;
  const v = Number(m[1]) * (m[2] ? SPICE_MULT[m[2].toLowerCase()] : 1);
  return Number.isFinite(v) ? v : null;
}

/**
 * The stored `testbench` of a fulgurlab / fulgurspice problem, from the creator's testConfig.
 * The grade route, the solve page's bridge config and the creator's capture all read this shape:
 *   fulgurlab:   { criteria, scope, input, spec? }
 *   fulgurspice: { criteria, output, input, analysis, spec?, noload?, maxload?, minload? }
 */
export function buildContinuousTestbench(type, testType, testConfig = {}, starterCode = "") {
  const criteria = testConfig.criteria === "spec" ? "spec" : "waveform";
  const spec = criteria === "spec" ? { spec: testConfig.spec || [] } : {};
  if (type === "fulgurlab") {
    return { criteria, scope: String(testConfig.scope || ""), input: Number(testConfig.input) || 0, ...spec };
  }
  let analysis = null;
  try { analysis = JSON.parse(starterCode)?.analysis || null; } catch { /* not saved yet */ }
  return {
    criteria,
    output: String(testConfig.output || "out").trim(),
    input: String(testConfig.input || "").trim(),
    ...(analysis ? { analysis } : {}),
    ...spec,
    ...(testType === "load"
      ? { noload: 1e12, maxload: Number(testConfig.rMax), minload: Number(testConfig.rMin) }
      : {}),
  };
}

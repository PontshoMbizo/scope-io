"use client";

import { Zap, Activity, Binary, CircuitBoard, Cpu, Workflow, Waves, Gauge } from "lucide-react";

// fulgurspice replaces CircuitJS for new analog problems; the CircuitJS load and
// signal strategies stay (marked Legacy) for problems written against it.
const STRATEGIES = [
  {
    id: "spice-signal",
    testType: "signal",
    simulatorType: "fulgurspice",
    icon: Waves,
    label: "Circuit Signal",
    tag: "Analog · SPICE",
    desc: "The learner draws a schematic and runs it in ngspice. Grade one net's waveform against your reference, or check specs such as rise time or the −3 dB frequency.",
    needs: 'A net label on the graded wire ("out") · fulgurspice',
  },
  {
    id: "spice-load",
    testType: "load",
    simulatorType: "fulgurspice",
    icon: Gauge,
    label: "Circuit Load Test",
    tag: "Power · SPICE",
    desc: "Runs the circuit at three load resistances (No-load / Max / Min) in one Submit and grades each run.",
    needs: 'A locked load resistor with value {RLOAD} · fulgurspice',
  },
  {
    id: "control",
    testType: "signal",
    simulatorType: "fulgurlab",
    icon: Workflow,
    label: "Control System",
    tag: "Blocks · Scilab",
    desc: "A Simulink-style block diagram. scope.io re-simulates the submitted diagram itself, then grades one scope trace against your reference or a spec (overshoot, settling time…).",
    needs: "A locked plant and graded Scope · fulgurlab",
  },
  {
    id: "load",
    testType: "load",
    simulatorType: "circuitjs",
    icon: Zap,
    label: "Load Test",
    tag: "Legacy · CircuitJS",
    desc: "Grades the output voltage across three resistive loads (No-load / Max / Min). One Submit sweeps all three.",
    needs: 'Output voltmeter labelled "output"',
  },
  {
    id: "signal",
    testType: "signal",
    simulatorType: "circuitjs",
    icon: Activity,
    label: "Signal Test",
    tag: "Legacy · CircuitJS",
    desc: "Grades a single output waveform in the time and frequency domain. Best for filters, amplifiers and shaping.",
    needs: "One golden capture",
  },
  {
    id: "digital",
    testType: "digital",
    simulatorType: "circuitjs",
    icon: Binary,
    label: "Digital Test",
    tag: "Logic / Gates",
    desc: "Clock-synchronised bit-vector comparison against a golden truth table. Exact match required.",
    needs: 'Clock, "clk" node, "Output0…" bus',
  },
  {
    id: "fpga",
    testType: "signal",
    simulatorType: "fpga",
    icon: CircuitBoard,
    label: "FPGA / Verilog",
    tag: "Hardware / RTL",
    desc: "Grades one named signal's value-change sequence (e.g. an LED bus) against a golden VCD capture from a self-checking testbench.",
    needs: "Tang Nano 9K · fpgasim",
  },
  {
    id: "mcu",
    testType: "signal",
    simulatorType: "mcu",
    icon: Cpu,
    label: "MCU / Bare-metal C",
    tag: "Embedded / Firmware",
    desc: "Grades one traced GPIO pin's value-change sequence against a golden run of the reference firmware.",
    needs: "STM32 Blue Pill · mcusim",
  },
];

// Default testConfig per strategy (moved from the old TopicSection).
const DEFAULT_CONFIG = {
  load: { noLoad: 1e12, rMax: 100, rMin: 10 },
  signal: { isSignal: true },
  digital: { payload1: "", payload2: "", payload3: "" },
  fpga: { testbench: "", signal: "", duration: 2000000 },
  mcu: { engine: "mainline", signal: "" },
  "spice-signal": { criteria: "waveform", output: "out", input: "in", spec: [] },
  "spice-load": { criteria: "waveform", output: "out", input: "", noLoad: 1e12, rMax: 100, rMin: 10, spec: [] },
  control: {
    criteria: "spec",
    scope: "",
    input: 0,
    spec: [
      { metric: "overshootPct", op: "<=", value: 10 },
      { metric: "settlingTime", op: "<=", value: 5, params: { band: 0.02 } },
      { metric: "finalValue", op: "≈", value: 1, tol: 0.02 },
    ],
  },
};

/** The card a problem's (simulatorType, testType) pair selects. */
export const strategyId = (p) =>
  p.simulatorType === "fulgurspice" ? `spice-${p.testType}`
    : p.simulatorType === "fulgurlab" ? "control"
      : p.simulatorType && p.simulatorType !== "circuitjs" ? p.simulatorType
        : p.testType;

export default function StrategySection({ problem, updateProblem }) {
  // Embedded sims share testType values with the CircuitJS strategies, so the
  // selected card is keyed off simulatorType first.
  const currentId = strategyId(problem);

  const choose = (s) => {
    if (s.id === currentId) return;
    updateProblem({
      testType: s.testType,
      simulatorType: s.simulatorType,
      testConfig: structuredClone(DEFAULT_CONFIG[s.id]),
      starterCode: "",
      templateCircuit: "",
      goldens: {},
      referenceCode: "",
      // Reset captures so a type switch can't carry stale solutions.
      solutions: {},
      captureRates: {},
      decimations: {},
      decimationErrors: {},
    });
  };

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="max-w-3xl mx-auto py-12 px-6 space-y-8">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Step 1</p>
          <h2 className="text-3xl font-black uppercase tracking-tighter text-blue-600">Validation Strategy</h2>
          <p className="text-sm text-slate-500 mt-2">
            How should the submitted circuit be graded? This drives the template and golden capture.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4">
          {STRATEGIES.map((s) => {
            const Icon = s.icon;
            const selected = s.id === currentId;
            return (
              <button
                key={s.id}
                onClick={() => choose(s)}
                className={`flex items-start gap-4 p-5 rounded-2xl border-2 text-left transition-all shadow-sm
                  ${selected ? "border-blue-600 bg-blue-50" : "border-slate-200 bg-white hover:border-blue-300"}`}
              >
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0
                  ${selected ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-400"}`}>
                  <Icon size={20} strokeWidth={2.2} />
                </div>
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-black uppercase tracking-tight ${selected ? "text-blue-700" : "text-slate-700"}`}>{s.label}</span>
                    <span className="rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest bg-slate-100 text-slate-400">{s.tag}</span>
                  </div>
                  <p className="text-xs text-slate-500 leading-relaxed">{s.desc}</p>
                  <p className="text-[10px] font-mono text-slate-400 pt-1">Requires: {s.needs}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

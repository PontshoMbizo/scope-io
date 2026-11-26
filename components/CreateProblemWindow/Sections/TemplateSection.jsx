"use client";

import { CheckCircle2 } from "lucide-react";
import Simulator from "@/components/Simulator";
import SimulatorEmbed from "@/components/SimulatorEmbed";
import { bridgeConfig, embedProps, isEmbeddedSim } from "@/lib/simulators";
import { strategyId } from "./StrategySection";

// Per-strategy labelling conventions the captured circuit must follow
// (see docs/CREATOR-CONVENTIONS.md).
const CONVENTIONS = {
  load: ['Place one voltmeter across the output, info labelled "output"', 'Optional "input" node for the reference'],
  signal: ['One voltmeter across the output', 'Optional "input" node for the reference'],
  digital: ['A "square wave gen" acts as the clock', 'Label a node "clk"', 'Output bus nodes "Output0", "Output1", … (LSB first)'],
  fpga: ['Write the starter Verilog module (can be an incomplete stub)', 'Click "Save starter" — no need to compile first'],
  mcu: ['Write the starter firmware (can be an incomplete stub)', 'Click "Save starter" — no need to build first'],
  control: [
    'Draw what the learner starts from: source, plant, a Scope for the response (leave the controller to them)',
    'Select a block and tick "Locked" in Properties for everything the learner must not change — at least the plant and the graded Scope',
    "Set the stop time and sample step now: they are fixed for the learner and the grader",
    'Click "Save starter"',
  ],
  "spice-signal": [
    'Put a net label (e.g. "out") on the wire you will grade, and optionally "in" on the input',
    'Tick "Locked for learners" on parts they must keep (source, load)',
    "Set the analysis now (transient for waveform match; AC for −3 dB / gain checks): learners can't change it",
    'Click "Save starter"',
  ],
  "spice-load": [
    'Draw the load as a resistor with value {RLOAD} and tick "Locked for learners"',
    'Put a net label (e.g. "out") on the output wire',
    "Use a transient analysis; to try it here, add .param RLOAD=1k under SPICE directives",
    'Click "Save starter"',
  ],
};

const hasLoadParam = (code) => /\{\s*rload\s*\}/i.test(code || "");

export default function TemplateSection({ problem, updateProblem }) {
  const type = problem.testType || "load";
  const isEmbedded = isEmbeddedSim(problem.simulatorType);
  const captured = isEmbedded ? !!problem.starterCode : !!problem.templateCircuit;
  const conventionKey = isEmbedded ? strategyId(problem) : type;
  const missingLoad = strategyId(problem) === "spice-load" && captured && !hasLoadParam(problem.starterCode);

  const handleCapture = (_data, sim) => {
    if (!sim) return;
    updateProblem({ templateCircuit: sim.exportCircuit() });
  };

  return (
    <section className="flex h-full w-full bg-white">
      {/* SIMULATOR */}
      <div className={`w-[70%] h-full ${isEmbedded ? "bg-white" : "bg-[#070707]"}`}>
        {isEmbedded ? (
          <SimulatorEmbed
            {...embedProps(problem.simulatorType)}
            bridge={{
              mode: "export",
              starterCode: problem.starterCode || "",
              config: bridgeConfig(problem.simulatorType, "export", type, {}),
              // A new starter invalidates any golden captured against the old one.
              onResult: (r) => r?.code && updateProblem({ starterCode: r.code, solutions: {}, goldens: {}, referenceCode: "" }),
            }}
          />
        ) : (
          <Simulator mode="export" onSubmit={handleCapture} />
        )}
      </div>

      {/* SIDEBAR */}
      <div className="w-[30%] h-full p-7 flex flex-col gap-5 border-l border-slate-200 bg-slate-50 overflow-y-auto">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Step 3</p>
          <h2 className="text-2xl font-black uppercase tracking-tighter text-blue-600">Starter Template</h2>
          <p className="text-xs text-slate-500 mt-1">
            {isEmbedded
              ? 'Author the starter code, then click "Save starter" in the simulator.'
              : "Design the circuit the solver starts from, then Submit to capture it."}
          </p>
        </div>

        {/* Capture status */}
        <div className={`p-5 rounded-2xl border text-center transition-all
          ${captured ? "bg-green-50 border-green-200" : "bg-white border-dashed border-slate-300"}`}>
          {captured ? (
            <div className="flex items-center justify-center gap-2 text-green-700">
              <CheckCircle2 size={18} />
              <span className="text-sm font-black uppercase tracking-tight">{isEmbedded ? "Starter Code Saved" : "Template Captured"}</span>
            </div>
          ) : isEmbedded ? (
            <p className="text-sm font-bold text-slate-500">Write the starter, then click <span className="text-blue-600">Save starter</span> in the simulator</p>
          ) : (
            <p className="text-sm font-bold text-slate-500">Design, then click <span className="text-blue-600">Submit</span> in the simulator</p>
          )}
        </div>

        {missingLoad && (
          <div className="px-4 py-3 rounded-xl text-xs font-bold bg-red-50 text-red-600 border border-red-200">
            No part uses {"{RLOAD}"}: give the load resistor the value {"{RLOAD}"} so each test can set it.
          </div>
        )}

        {/* Conventions hint */}
        <div className="p-5 bg-white border border-slate-200 rounded-2xl shadow-sm space-y-2">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Labelling — {conventionKey}</p>
          <ul className="space-y-1.5">
            {CONVENTIONS[conventionKey].map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] text-slate-500 leading-relaxed">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400 mt-1.5 shrink-0" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

"use client";

import { Check, X } from "lucide-react";
import { GeneralUtils } from "@/lib/GeneralUtils";
import { isContinuousSim, isEmbeddedSim, spiceAnalysisKind, starterTimeStep } from "@/lib/simulators";
import { goldensReady } from "@/lib/goldenCapture";
import { validateSpec } from "@/lib/specUtils";

const requiredTests = GeneralUtils.requiredTests;

const diffBadge = {
  Easy: "bg-green-100 text-green-700",
  Medium: "bg-amber-100 text-amber-700",
  Hard: "bg-red-100 text-red-600",
};

const STRATEGY_LABEL = { fpga: "FPGA / Verilog", mcu: "MCU / Bare-metal C", fulgurlab: "Control system (fulgurlab)", fulgurspice: "Circuit (fulgurspice)" };

export default function ReviewSection({ problem, statusMessage, goToStep }) {
  const type = problem.testType || "load";
  const isEmbedded = isEmbeddedSim(problem.simulatorType);
  const isContinuous = isContinuousSim(problem.simulatorType);
  const tc = problem.testConfig || {};
  const req = requiredTests(type);
  const capturedCount = isContinuous
    ? req.filter((k) => problem.goldens?.[k]).length
    : req.filter((k) => problem.solutions?.[k]).length;

  const loadsValid = type !== "load"
    || (Number(problem.testConfig?.rMax) > 0 && Number(problem.testConfig?.rMin) > 0);
  const signalValid = !isEmbedded || !!problem.testConfig?.signal?.trim();

  const graded = problem.simulatorType === "fulgurlab"
    ? (tc.scope ? `scope ${tc.scope}, input ${(Number(tc.input) || 0) + 1}` : "")
    : (tc.output ? `net ${tc.output}${tc.input ? ` (input ${tc.input})` : ""}` : "");
  const continuousChecks = [
    { ok: !!problem.testType, label: "Validation strategy chosen", step: 0 },
    { ok: !!problem.title.trim(), label: "Title set", step: 1 },
    { ok: problem.topics.length > 0, label: `At least one topic (${problem.topics.length}/2)`, step: 1 },
    { ok: !!problem.description.trim(), label: "Description written", step: 1 },
    { ok: !!problem.starterCode, label: "Starter saved", step: 2 },
    ...(problem.simulatorType === "fulgurspice"
      ? [{ ok: ["tran", "ac"].includes(spiceAnalysisKind(problem.starterCode)), label: "Starter uses a transient or AC analysis", step: 2 }]
      : []),
    { ok: !!graded, label: `Graded ${problem.simulatorType === "fulgurlab" ? "scope" : "net"} chosen`, step: 3 },
    ...(type === "load" ? [{ ok: loadsValid, label: "Max / Min loads are positive", step: 3 }] : []),
    ...(tc.criteria === "spec" ? [{ ok: validateSpec(tc.spec).length === 0, label: `Spec is complete (${(tc.spec || []).length} checks)`, step: 3 }] : []),
    { ok: goldensReady(problem), label: tc.criteria === "spec" ? "Reference captured and meets the spec" : `Reference captured (${capturedCount}/${req.length})`, step: 3 },
  ];

  // Each requirement → { ok, label, step }
  const checks = isContinuous ? continuousChecks : [
    { ok: !!problem.testType, label: "Validation strategy chosen", step: 0 },
    { ok: !!problem.title.trim(), label: "Title set", step: 1 },
    { ok: problem.topics.length > 0, label: `At least one topic (${problem.topics.length}/2)`, step: 1 },
    { ok: !!problem.description.trim(), label: "Description written", step: 1 },
    {
      ok: isEmbedded ? !!problem.starterCode : !!problem.templateCircuit,
      label: isEmbedded ? "Starter code saved" : "Starter template captured",
      step: 2,
    },
    {
      ok: capturedCount === req.length,
      label: isEmbedded
        ? `Reference solution captured (signal: ${problem.testConfig?.signal || "—"})`
        : `Golden captures (${capturedCount}/${req.length})`,
      step: 3,
    },
    ...(type === "load" ? [{ ok: loadsValid, label: "Max / Min loads are positive", step: 3 }] : []),
    ...(isEmbedded ? [{ ok: signalValid, label: "Signal / pin name set", step: 3 }] : []),
  ];

  const row = (label, value) => (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-[10px] font-black uppercase tracking-widest text-slate-400 shrink-0">{label}</span>
      <span className="text-sm text-slate-700 text-right">{value}</span>
    </div>
  );

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="max-w-2xl mx-auto py-12 px-6 space-y-6">
        <div>
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Step 5</p>
          <h2 className="text-3xl font-black uppercase tracking-tighter text-blue-600">Review &amp; Publish</h2>
          <p className="text-sm text-slate-500 mt-2">Confirm everything below, then publish to the challenge library.</p>
        </div>

        {/* Summary */}
        <div className="p-6 rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="text-lg font-black uppercase tracking-tight text-slate-800">{problem.title || "Untitled"}</h3>
            <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest ${diffBadge[problem.difficulty] || "bg-slate-100 text-slate-500"}`}>{problem.difficulty}</span>
          </div>
          <div className="flex flex-wrap gap-2 mb-3">
            {problem.topics.map((t) => (
              <span key={t} className="rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-500">{t}</span>
            ))}
          </div>
          <div className="divide-y divide-slate-100">
            {row("Strategy", isEmbedded ? STRATEGY_LABEL[problem.simulatorType] : `${type} test`)}
            {type === "load" && row("Loads", `Max ${problem.testConfig?.rMax ?? "—"} Ω · Min ${problem.testConfig?.rMin ?? "—"} Ω`)}
            {row("Captures", `${capturedCount} / ${req.length}`)}
            {isContinuous ? (
              <>
                {row("Graded", graded || "—")}
                {row("Criteria", tc.criteria === "spec" ? `Spec checks (${(tc.spec || []).length})` : "Waveform match")}
                {row("Time step", starterTimeStep(problem.simulatorType, problem.starterCode) ? `${starterTimeStep(problem.simulatorType, problem.starterCode)} s` : "—")}
              </>
            ) : isEmbedded ? (
              <>
                {row("Signal / pin", problem.testConfig?.signal || "—")}
                {problem.simulatorType === "mcu" && row("Engine", problem.testConfig?.engine || "mainline")}
                {problem.simulatorType === "fpga" && row("Duration", `${problem.testConfig?.duration ?? 2000000} ns`)}
              </>
            ) : (
              <>
                {row("Sample count", String(problem.sampleCount))}
                {row("Time step", `${problem.timeStep} s`)}
              </>
            )}
          </div>
        </div>

        {/* Checklist */}
        <div className="p-6 rounded-2xl border border-slate-200 bg-white shadow-sm space-y-2">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Publish Checklist</p>
          {checks.map((c, i) => (
            <button
              key={i}
              onClick={() => goToStep(c.step)}
              className="w-full flex items-center gap-3 py-1.5 text-left group"
            >
              <span className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 ${c.ok ? "bg-green-100 text-green-600" : "bg-red-100 text-red-500"}`}>
                {c.ok ? <Check size={12} strokeWidth={3.5} /> : <X size={12} strokeWidth={3.5} />}
              </span>
              <span className={`text-sm ${c.ok ? "text-slate-600" : "text-red-600 font-semibold"}`}>{c.label}</span>
              {!c.ok && <span className="ml-auto text-[10px] font-black uppercase tracking-widest text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity">Fix →</span>}
            </button>
          ))}
        </div>

        {statusMessage && (
          <div className={`px-4 py-3 rounded-xl text-sm font-bold ${statusMessage.type === "error" ? "bg-red-50 text-red-600 border border-red-200" : "bg-green-50 text-green-700 border border-green-200"}`}>
            {statusMessage.text}
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { Plus, Trash2 } from "lucide-react";
import { METRICS, OPS, validateSpec } from "@/lib/specUtils";
import { fulgurlabScopes, spiceAnalysisKind } from "@/lib/simulators";

const inputClass =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono text-slate-800 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 outline-none transition-all";
const smallInput =
  "w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs font-mono text-slate-800 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 outline-none transition-all";
const label = "text-[9px] font-black uppercase tracking-widest text-slate-400";

const METRIC_GROUPS = [
  { domain: "tran", label: "Time domain (transient)" },
  { domain: "ac", label: "Frequency (AC sweep)" },
];

/**
 * Grading setup for the continuous simulators (fulgurlab, fulgurspice): what to grade (a scope
 * input, or a net) and how (waveform match against the reference, or spec checks). Any change
 * clears the captured reference, since it was checked against the old setup.
 */
export default function ContinuousConfig({ problem, updateProblem }) {
  const tc = problem.testConfig || {};
  const isLab = problem.simulatorType === "fulgurlab";
  const isLoad = problem.testType === "load";
  const scopes = isLab ? fulgurlabScopes(problem.starterCode) : [];
  const analysis = isLab ? null : spiceAnalysisKind(problem.starterCode);
  const spec = Array.isArray(tc.spec) ? tc.spec : [];
  const specErrors = tc.criteria === "spec" ? validateSpec(spec) : [];

  const set = (patch) => updateProblem({ testConfig: { ...tc, ...patch }, goldens: {}, referenceCode: "" });
  const setCheck = (i, patch) => set({ spec: spec.map((c, k) => (k === i ? { ...c, ...patch } : c)) });
  const addCheck = () => {
    const metric = analysis === "ac" ? "f3dB" : "finalValue";
    set({ spec: [...spec, { metric, op: "<=", value: 0 }] });
  };

  const selectedScope = scopes.find((s) => s.id === tc.scope);

  return (
    <div className="p-4 bg-white border border-slate-200 rounded-2xl shadow-sm space-y-4">
      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Grading</p>

      {/* What is graded */}
      {isLab ? (
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2 space-y-1">
            <label className={label}>Scope to grade</label>
            <select className={inputClass} value={tc.scope || ""} onChange={(e) => set({ scope: e.target.value, input: 0 })}>
              <option value="">Choose…</option>
              {scopes.map((s) => <option key={s.id} value={s.id}>{s.name}{s.name !== s.id ? ` (${s.id})` : ""}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className={label}>Input</label>
            <select className={inputClass} value={Number(tc.input) || 0} onChange={(e) => set({ input: Number(e.target.value) })} disabled={!selectedScope}>
              {Array.from({ length: selectedScope?.inputs || 1 }, (_, i) => <option key={i} value={i}>{i + 1}</option>)}
            </select>
          </div>
          {scopes.length === 0 && <p className="col-span-3 text-[11px] text-red-600">The starter has no Scope block. Add one (and lock it) in the Template step.</p>}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className={label}>Output net</label>
            <input className={inputClass} placeholder="out" value={tc.output || ""} onChange={(e) => set({ output: e.target.value.trim() })} />
          </div>
          <div className="space-y-1">
            <label className={label}>Input net (optional)</label>
            <input className={inputClass} placeholder="in" value={tc.input || ""} onChange={(e) => set({ input: e.target.value.trim() })} />
          </div>
          {isLoad && (
            <>
              <div className="space-y-1">
                <label className={label}>Max load (Ω)</label>
                <input type="number" className={inputClass} value={tc.rMax ?? ""} onChange={(e) => set({ rMax: e.target.value })} />
              </div>
              <div className="space-y-1">
                <label className={label}>Min load (Ω)</label>
                <input type="number" className={inputClass} value={tc.rMin ?? ""} onChange={(e) => set({ rMin: e.target.value })} />
              </div>
            </>
          )}
          <p className="col-span-2 text-[11px] text-slate-500">
            Analysis from the starter: <span className="font-mono font-bold">{analysis || "—"}</span>
            {analysis === "ac" && " (spec checks only)"}
            {analysis && !["tran", "ac"].includes(analysis) && <span className="text-red-600"> — use a transient or AC analysis</span>}
          </p>
        </div>
      )}

      {/* How it is graded */}
      <div className="space-y-1">
        <label className={label}>Criteria</label>
        <div className="inline-flex w-full p-1 rounded-xl bg-slate-200 gap-0.5">
          {[["waveform", "Match waveform"], ["spec", "Spec checks"]].map(([id, text]) => (
            <button
              key={id}
              type="button"
              onClick={() => set({ criteria: id })}
              className={`flex-1 rounded-lg px-2 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all
                ${(tc.criteria || "waveform") === id ? "bg-blue-600 text-white shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
            >
              {text}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          {tc.criteria === "spec"
            ? "Measures the learner's trace and checks each target. Any design that meets the spec passes."
            : "Compares the learner's trace with your reference: 70 % time, 20 % spectrum, 10 % features, against the topic's error limit."}
        </p>
      </div>

      {tc.criteria === "spec" && (
        <div className="space-y-2">
          {spec.map((c, i) => {
            const m = METRICS[c.metric];
            const paramKeys = Object.keys(m?.params || {});
            return (
              <div key={i} className="p-2 rounded-xl border border-slate-200 bg-slate-50 space-y-1.5">
                <div className="flex gap-1.5">
                  <select className={smallInput} value={c.metric} onChange={(e) => setCheck(i, { metric: e.target.value, params: undefined })}>
                    {METRIC_GROUPS.map((g) => (
                      <optgroup key={g.domain} label={g.label}>
                        {Object.entries(METRICS).filter(([, d]) => d.domain === g.domain).map(([id, d]) => (
                          <option key={id} value={id}>{d.label}{d.unit ? ` (${d.unit})` : ""}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  <button type="button" className="shrink-0 px-2 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors" aria-label="Remove check" onClick={() => set({ spec: spec.filter((_, k) => k !== i) })}>
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="flex gap-1.5 items-center">
                  <select className={`${smallInput} w-16 shrink-0`} value={c.op} onChange={(e) => setCheck(i, { op: e.target.value })}>
                    {OPS.map((op) => <option key={op} value={op}>{op === "<=" ? "≤" : op === ">=" ? "≥" : "≈"}</option>)}
                  </select>
                  <input type="number" className={smallInput} value={c.value ?? ""} onChange={(e) => setCheck(i, { value: e.target.value === "" ? "" : Number(e.target.value) })} aria-label="Target" />
                  {c.op === "≈" && (
                    <>
                      <span className="text-xs text-slate-400">±</span>
                      <input type="number" className={smallInput} value={c.tol ?? ""} onChange={(e) => setCheck(i, { tol: e.target.value === "" ? "" : Number(e.target.value) })} aria-label="Tolerance" />
                    </>
                  )}
                </div>
                {paramKeys.length > 0 && (
                  <div className="flex gap-1.5 items-center">
                    {paramKeys.map((k) => (
                      <label key={k} className="flex items-center gap-1 text-[10px] font-mono text-slate-500 flex-1">
                        {k}
                        <input
                          type="number"
                          className={smallInput}
                          placeholder={m.params[k] === undefined ? "auto" : String(m.params[k])}
                          value={c.params?.[k] ?? ""}
                          onChange={(e) => setCheck(i, { params: { ...(c.params || {}), [k]: e.target.value === "" ? undefined : Number(e.target.value) } })}
                        />
                      </label>
                    ))}
                  </div>
                )}
                {m?.hint && <p className="text-[10px] text-slate-400">{m.hint}</p>}
              </div>
            );
          })}
          <button type="button" onClick={addCheck} className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-slate-300 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:border-blue-400 hover:text-blue-600 transition-colors">
            <Plus size={13} /> Add check
          </button>
          {specErrors.length > 0 && (
            <ul className="text-[11px] text-red-600 space-y-0.5">{specErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          )}
        </div>
      )}
    </div>
  );
}

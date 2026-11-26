# fulgurlab and fulgurspice

Two continuous-time simulators, graded on waveforms rather than on value-change lists:

| `simulatorType` | Simulator | Engine | Runs | Graded from |
|---|---|---|---|---|
| `fulgurlab` | Simulink-style block diagrams | Scilab/Xcos on the fulgurlab server | server | **scope.io's server re-simulates** the submitted diagram |
| `fulgurspice` | KiCad-style schematics | ngspice (WebAssembly) | the learner's browser | the traces the browser posts |

fulgurspice replaces CircuitJS for new analog problems. The CircuitJS Load and Signal strategies
are marked *Legacy* in Creator Studio and stay only so the existing problems keep working.

## Where the code is

| File | Holds |
|---|---|
| `lib/simulators.js` | The registry: every `simulatorType`, how it is graded (`circuitjs`, `sequence`, `resim`, `trace`), the bridge `config` per mode, payload → capture → request-body conversion, and the stored testbench shape |
| `lib/specUtils.js` | Spec checks: metrics (overshoot, settling time, rise time, final value, ripple, f-3dB, gain/phase at f, …), `evaluateSpec`, `specVerdict` |
| `lib/fulgurlabIntegrity.js` | `checkLocked`: the starter's locked blocks and run settings must be unchanged in a submission |
| `lib/goldenCapture.js` | Creator Studio: reference run → golden docs (and the reference must meet its own spec) |
| `lib/captureGrading.js` | `resimulateFulgurlab`, `gradeContinuousCapture`, and the CircuitJS `gradeAnalogCapture` (moved out of the route unchanged); `app/api/grade/route.js` dispatches to them by the registry's `grade` |
| `components/CreateProblemWindow/Sections/ContinuousConfig.jsx` | Graded scope or net, waveform/spec toggle, spec editor |

## The bridge (protocol 2)

Both simulators speak the same `scopeio:*` messages as fpgasim and mcusim, plus two additions that
the older sims ignore:

- `scopeio:init` carries `protocol: 2` and a `config` object (`bridgeConfig` in `lib/simulators.js`):
  - fulgurlab: `{ lockSettings, theme }`;
  - fulgurspice: `{ probes: { output, input? }, analysis?, sweep?, lockAnalysis, theme }`.

  `SimulatorEmbed` re-sends init when `config` changes; the sims treat a repeat init as a settings
  update and never re-seed the code.
- `scopeio:change { code }` arrives about 0.8 s after the learner stops editing. `SolveProblem`
  stores it as the `draft_<problemId>` draft, so a refresh no longer loses work done since the last
  Submit (TASKS.md #26) for these sims.

Modes: `export` (Save starter), `capture` (Capture golden), `solve` (Submit). In `solve`, locked
blocks and parts can be moved and wired but not changed or deleted, and the run settings (fulgurlab
stop time and step, fulgurspice analysis) are read-only. The simulator repos document their side in
`docs/embedding.md`.

## Problem documents

`Problems/{id}`: `testType` `signal` or `load`, `simulatorType`, `starterCode` (the starter as JSON
text), `timeStep` (fulgurlab `dt`, or the spice transient step), and a `testbench`
(`buildContinuousTestbench`):

```jsonc
// fulgurlab
{ "criteria": "spec", "scope": "response", "input": 0,
  "spec": [{ "metric": "overshootPct", "op": "<=", "value": 10 },
           { "metric": "settlingTime", "params": { "band": 0.02 }, "op": "<=", "value": 5 }] }
// fulgurspice (a load problem)
{ "criteria": "waveform", "output": "out", "input": "", "analysis": { "kind": "tran", "step": "10u", "stop": "5m" },
  "noload": 1e12, "maxload": 100, "minload": 10 }
```

- `solutionWaveform/{test1..3}`: `{ kind, samples, sampleRate, decimation, decimationError }`, in the
  same packed format as CircuitJS goldens. With spec criteria the trace is only displayed. For an AC
  spec, `samples` is empty.
- `private/reference`: `{ simulatorType, code }`, the reference design. Firestore rules deny every
  client read, because a readable reference diagram would be a copyable answer to a re-simulated problem.

## Grading

```
fulgurlab:   Submit -> {netlist: code} -> /api/grade
               -> checkLocked(starterCode, netlist)        400 if a locked block or setting changed
               -> POST $FULGURLAB_API_URL/api/simulate      (Bearer $FULGURLAB_GRADER_TOKEN, 25 s)
               -> scopes[testbench.scope].y[testbench.input]
               -> gradeContinuousCapture
fulgurspice: Submit -> capture (resampled at the analysis step) -> /api/grade -> gradeContinuousCapture
               (load problems: three runs, RLOAD = no load / max / min, through the batch path)

gradeContinuousCapture: criteria "spec"  -> evaluateSpec -> { type: "spec", checks, verdict }
                        otherwise        -> gradeAnalogCapture (70/20/10 hybrid NRMSE, as for CircuitJS)
```

Trust: fulgurlab is graded from what the server itself simulated, so a posted trace can't be
forged, but the reference trace in `solutionWaveform` is still readable. fulgurspice still trusts
the browser, like CircuitJS, fpgasim and mcusim. Its next step is a hardened ngspice grading server
(fulgurspice TASKS.md, Phase 5).

## Configuration

```
NEXT_PUBLIC_FULGURLAB_URL=    # https://lab.pontsho-mbizo.co.za/   (dev: http://localhost:5173)
NEXT_PUBLIC_FULGURSPICE_URL=  # https://spice.pontsho-mbizo.co.za/ (dev: http://localhost:5174)
FULGURLAB_API_URL=            # server-only: https://lab.pontsho-mbizo.co.za (dev: http://127.0.0.1:8080)
FULGURLAB_GRADER_TOKEN=       # server-only: equals FULGUR_GRADER_TOKEN on the fulgurlab server
```

Both apps must be frameable by scope.io (`frame-ancestors` in their nginx config). Deploy the
`firestore.rules` change for `private/`.

import { NextResponse } from "next/server";
import { adminDb, adminAuth, FieldValue } from "@/lib/firebaseAdmin";
import { db } from "@/lib/firebase";
import { doc, getDoc, collection, getDocs } from "firebase/firestore";
import { gradingUtils } from "@/lib/gradingUtils";
import { getSimulator } from "@/lib/simulators";
import { gradeAnalogCapture, gradeContinuousCapture, resimulateFulgurlab } from "@/lib/captureGrading";

// firebase-admin requires the Node.js runtime — never let this route be
// promoted to the Edge runtime.
export const runtime = "nodejs";
// fulgurlab problems re-simulate the submission on the fulgurlab server
// (usually well under a second, capped at 25 s below).
export const maxDuration = 30;


// Hard caps so a hostile payload can't make the FFT/NRMSE loops chew CPU
// (the analog caps live with the analog grader in lib/captureGrading.js).
const MAX_DIGITAL_ROWS = 10_000;
// A batched load submission carries up to three captures in one body. Cap the
// combined sample count so an oversized batch is rejected (413) rather than
// chewing CPU or tripping the platform body limit — the client then falls back
// to grading each load in a separate request.
const MAX_BATCH_SAMPLES = 1_200_000;

// In-memory sliding-window rate limiter, keyed by verified uid or client IP.
// Resets on server restart. On serverless (Vercel) this is per-instance and
// therefore best-effort: at hobby-tier traffic requests usually land on one
// warm instance, so it still catches rapid-fire abuse. If real abuse appears
// or the app scales to many instances, swap for Upstash Redis (free tier) —
// keep this function's signature and only change its internals.
const _rateLimitMap = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 15;
function checkRateLimit(key) {
  const now = Date.now();
  // Opportunistic pruning so the map can't grow unbounded.
  if (_rateLimitMap.size > 5_000) {
    for (const [k, times] of _rateLimitMap) {
      if (times.every(t => now - t >= RATE_WINDOW_MS)) _rateLimitMap.delete(k);
    }
  }
  const times = (_rateLimitMap.get(key) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (times.length >= RATE_MAX) return false;
  _rateLimitMap.set(key, [...times, now]);
  return true;
}

// Extract and verify the Firebase ID token from the Authorization header.
// With Admin SDK: cryptographic verification — uid is trustworthy.
// Without Admin SDK: an unverified decode is only acceptable in development.
// In production a missing Admin SDK means we treat everyone as anonymous
// rather than trusting a forgeable token.
async function getUserIdFromRequest(request) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  if (adminAuth) {
    try {
      const decoded = await adminAuth.verifyIdToken(token);
      return decoded.uid;
    } catch {
      return null;
    }
  }

  if (process.env.NODE_ENV === "production") {
    console.error("[grade] Admin SDK not configured in production — refusing unverified tokens.");
    return null;
  }

  // Dev fallback: decode without signature verification.
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.user_id || payload.sub || null;
  } catch {
    return null;
  }
}

// Per-instance TTL cache for problem + solution docs. Solution waveforms are
// ~30k-line strings; re-reading them from Firestore on every submission is the
// single biggest read cost in the app. Problems are immutable after publish in
// practice, so a short TTL is safe. On serverless this only helps warm
// instances — which is exactly where repeated submissions land.
const _problemCache = new Map();
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 50;

// Fetch the problem doc and its solutionWaveform subcollection.
// Prefers the Admin SDK (bypasses rules, single trust path); falls back to
// the client SDK for local development without a service account.
async function fetchProblemAndSolutions(problemId) {
  const cached = _problemCache.get(problemId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const value = await _fetchProblemAndSolutionsUncached(problemId);
  // Don't cache misses (problem may be mid-publish); cap the cache size.
  if (value.problem) {
    if (_problemCache.size >= CACHE_MAX_ENTRIES) {
      const oldest = _problemCache.keys().next().value;
      _problemCache.delete(oldest);
    }
    _problemCache.set(problemId, { at: Date.now(), value });
  }
  return value;
}

async function _fetchProblemAndSolutionsUncached(problemId) {
  const solutions = {};
  if (adminDb) {
    const pSnap = await adminDb.collection("Problems").doc(problemId).get();
    if (!pSnap.exists) return { problem: null, solutions };
    const sSnap = await adminDb.collection("Problems").doc(problemId).collection("solutionWaveform").get();
    sSnap.forEach(d => { solutions[d.id] = d.data(); });
    return { problem: pSnap.data(), solutions };
  }
  const pSnap = await getDoc(doc(db, "Problems", problemId));
  if (!pSnap.exists()) return { problem: null, solutions };
  const sSnap = await getDocs(collection(db, "Problems", problemId, "solutionWaveform"));
  sSnap.forEach(d => { solutions[d.id] = d.data(); });
  return { problem: pSnap.data(), solutions };
}

// Persist UserProgress for the newly-passed test keys via the Admin SDK (uid
// from the verified token only). Merges with any existing progress and returns
// whether the problem is now fully complete. Writes once per call — the batch
// path passes all passed keys together instead of one write per test.
async function writeUserProgress({ verifiedUid, problemId, testType, passedKeys }) {
  const requiredTests = testType === "signal" ? ["test1"] : ["test1", "test2", "test3"];
  if (!verifiedUid || passedKeys.length === 0) return false;

  if (!adminDb) {
    // Dev fallback: no Admin SDK — progress is not persisted.
    console.warn("[grade] Admin SDK not configured — progress not persisted.");
    return requiredTests.every(k => passedKeys.includes(k));
  }

  const progressRef = adminDb.collection("UserProgress").doc(`${verifiedUid}_${problemId}`);
  const progressSnap = await progressRef.get();
  const passedTests = {
    ...(progressSnap.exists ? (progressSnap.data().passedTests || {}) : {}),
    ...Object.fromEntries(passedKeys.map(k => [k, true])),
  };
  const isCompleted = requiredTests.every(k => passedTests[k]);
  await progressRef.set({
    userId: verifiedUid,
    problemId,
    passedTests,
    status: isCompleted ? "completed" : "in_progress",
    ...(isCompleted ? { completedAt: FieldValue.serverTimestamp(), score: 100 } : {}),
  }, { merge: true });
  return isCompleted;
}

export async function POST(request) {
  try {
    // Authenticate first — userId comes from the verified token, never the body.
    const verifiedUid = await getUserIdFromRequest(request);

    const body = await request.json();
    const { problemId, testKey, capturedData } = body;

    // Rate-limit everyone: verified users by uid, anonymous users by IP.
    const rateKey = verifiedUid
      || `ip:${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"}`;
    if (!checkRateLimit(rateKey)) {
      return NextResponse.json(
        { error: "Too many submissions. Wait a minute and try again." },
        { status: 429 }
      );
    }

    // problemId is required for every request shape.
    if (!problemId || typeof problemId !== "string") {
      return NextResponse.json({ error: "Missing required field: problemId" }, { status: 400 });
    }

    // A batched submission (load sweep) carries up to three captures under
    // `captures`; the single-test path carries one under `testKey`/`capturedData`.
    const isBatch = body.captures && typeof body.captures === "object" && !Array.isArray(body.captures);

    if (!isBatch) {
      if (!testKey || !capturedData) {
        return NextResponse.json(
          { error: "Missing required fields: problemId, testKey, capturedData" },
          { status: 400 }
        );
      }
      if (!["test1", "test2", "test3"].includes(testKey)) {
        return NextResponse.json({ error: `Invalid testKey: "${testKey}"` }, { status: 400 });
      }
    }

    // Fetch problem + solutions server-side. testType, topics and testbench
    // are read from the problem document — NEVER from the request body, where
    // a client could substitute lenient values to lower its own bar.
    const { problem, solutions: solutionsMap } = await fetchProblemAndSolutions(problemId);
    if (!problem) {
      return NextResponse.json({ error: "Problem not found" }, { status: 404 });
    }

    const testType = problem.testType?.trim() || (problem.isDigital ? "digital" : "load");
    const topics = Array.isArray(problem.topics) ? problem.topics : [];
    const testbench = problem.testbench || {};
    // Engine discriminator, orthogonal to testType — absent on every problem
    // created before this field existed, so default to the original engine.
    const simulatorType = problem.simulatorType || "circuitjs";
    const sim = getSimulator(simulatorType);
    if (!sim) {
      console.error(`[grade] Problem ${problemId} has unknown simulatorType "${simulatorType}"`);
      return NextResponse.json(
        { error: "Problem is misconfigured (unknown simulator). Contact the problem creator." },
        { status: 500 }
      );
    }

    if (!["load", "signal", "digital"].includes(testType)) {
      console.error(`[grade] Problem ${problemId} has invalid testType "${testType}"`);
      return NextResponse.json(
        { error: "Problem is misconfigured (invalid testType). Contact the problem creator." },
        { status: 500 }
      );
    }

    // ── Batch path: one body grades all three load captures, one problem-doc
    // lookup, one UserProgress write, one rate-limit hit. ──
    if (isBatch) {
      if (testType !== "load" || !["circuitjs", "trace"].includes(sim.grade)) {
        return NextResponse.json(
          { error: "Batched grading is only supported for load problems." },
          { status: 400 }
        );
      }
      const keys = Object.keys(body.captures).filter(k => ["test1", "test2", "test3"].includes(k));
      if (keys.length === 0) {
        return NextResponse.json(
          { error: "captures must include at least one of test1, test2, test3." },
          { status: 400 }
        );
      }
      // Combined size guard — a batch over the cap is refused with 413 so the
      // client can fall back to grading each load in its own request.
      let totalSamples = 0;
      for (const k of keys) {
        const c = body.captures[k] || {};
        totalSamples += (Array.isArray(c.output) ? c.output.length : 0)
          + (Array.isArray(c.input) ? c.input.length : 0);
      }
      if (totalSamples > MAX_BATCH_SAMPLES) {
        return NextResponse.json(
          { error: `Batch exceeds ${MAX_BATCH_SAMPLES} combined samples; grade loads individually.` },
          { status: 413 }
        );
      }

      const testResults = {};
      const errors = {};
      const passedKeys = [];
      for (const k of keys) {
        const res = sim.grade === "trace"
          ? gradeContinuousCapture({ problem, testType, testbench, topics, solutionsMap, testKey: k, capture: body.captures[k] })
          : gradeAnalogCapture({ problem, testType, testbench, topics, solutionsMap, testKey: k, capturedData: body.captures[k] });
        if (res.ok) {
          testResults[k] = res.testResult;
          if (res.passed) passedKeys.push(k);
        } else {
          errors[k] = res.error;
        }
      }
      const isCompleted = await writeUserProgress({ verifiedUid, problemId, testType, passedKeys });
      return NextResponse.json({ testResults, errors, isCompleted });
    }

    // ── Single-test path (signal/digital, or one load tab). ──
    let testResult;

    if (sim.grade === "resim" || sim.grade === "trace") {
      // fulgurlab (re-simulated here) and fulgurspice (trace from the browser):
      // waveform match or spec checks, by testbench.criteria.
      let capture = capturedData;
      if (sim.grade === "resim") {
        const r = await resimulateFulgurlab({ problem, testbench, capturedData });
        if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
        capture = r.capture;
      }
      const res = gradeContinuousCapture({ problem, testType, testbench, topics, solutionsMap, testKey, capture });
      if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
      testResult = { ...res.testResult, simulatorType };
    } else if (sim.grade === "sequence") {
      // FPGA/MCU: exact-sequence grading of one named signal/pin, extracted
      // client-side (inside the embedded sim, before the postMessage bridge
      // sent it here) from a VCD or pin trace. testType stays "signal" for
      // these — requiredTests/writeUserProgress below need no changes.
      if (!Array.isArray(capturedData.changes)) {
        return NextResponse.json(
          { error: "capturedData.changes must be an array for fpga/mcu problems" },
          { status: 400 }
        );
      }
      if (capturedData.changes.length > MAX_DIGITAL_ROWS) {
        return NextResponse.json(
          { error: `capturedData.changes exceeds the maximum of ${MAX_DIGITAL_ROWS} entries` },
          { status: 400 }
        );
      }

      const golden = solutionsMap[testKey];
      if (!golden || !Array.isArray(golden.changes) || golden.changes.length === 0) {
        console.error(`[grade] Missing/malformed ${simulatorType} golden for problem ${problemId} key ${testKey}`);
        return NextResponse.json(
          { error: "Solution data is missing or malformed. Contact the problem creator." },
          { status: 500 }
        );
      }

      const grade = gradingUtils.gradeSequence(capturedData.changes, golden.changes);
      const verdict = gradingUtils.getVerdict(grade.matchRatio, topics, true);
      // Reported as type "digital" (with the engine kept alongside for
      // display) so the existing Logic Analyzer / Truth Table UI in
      // Results.jsx renders this with no changes — a sequence-of-changes
      // grade is structurally identical to a digital cycle table.
      testResult = {
        type: "digital",
        simulatorType,
        signal: testbench.signal || "",
        table: grade.details.map(d => ({ cycle: d.index, expected: d.expected, actual: d.actual, passed: d.passed })),
        verdict: { ...verdict, matchRatio: grade.matchRatio },
        summary: { total: grade.total, correct: grade.correctCount },
      };
    } else if (testType === "digital") {
      if (!Array.isArray(capturedData.table)) {
        return NextResponse.json(
          { error: "capturedData.table must be an array for digital problems" },
          { status: 400 }
        );
      }
      if (capturedData.table.length > MAX_DIGITAL_ROWS) {
        return NextResponse.json(
          { error: `capturedData.table exceeds the maximum of ${MAX_DIGITAL_ROWS} rows` },
          { status: 400 }
        );
      }

      const userTable = capturedData.table;
      const goldenValues = (solutionsMap[testKey]?.samples || "").trim().split("\n")
        .map(val => parseInt(val.trim(), 10))
        .filter(Number.isFinite);

      // Guard against a missing or malformed solution doc — surface a clear
      // message so the creator knows to fix the problem, not the user.
      if (goldenValues.length === 0) {
        console.error(`[grade] Empty digital solution for problem ${problemId} key ${testKey}`);
        return NextResponse.json(
          { error: "Solution data is missing or malformed. Contact the problem creator." },
          { status: 500 }
        );
      }

      const goldenTable = goldenValues.map(v => ({ decimalOutput: v }));
      const grade = gradingUtils.gradeDigital(userTable, goldenTable);
      const verdict = gradingUtils.getVerdict(grade.matchRatio, topics, true);
      testResult = {
        type: "digital",
        table: grade.details,
        verdict: { ...verdict, matchRatio: grade.matchRatio },
        summary: { total: grade.totalCycles, correct: grade.correctCount },
      };
    } else {
      const res = gradeAnalogCapture({ problem, testType, testbench, topics, solutionsMap, testKey, capturedData });
      if (!res.ok) {
        return NextResponse.json({ error: res.error }, { status: res.status });
      }
      testResult = res.testResult;
    }

    // Write UserProgress via Admin SDK. uid comes from verified token only.
    const isCompleted = testResult.verdict?.passed
      ? await writeUserProgress({ verifiedUid, problemId, testType, passedKeys: [testKey] })
      : false;

    return NextResponse.json({ testResult, isCompleted });
  } catch (err) {
    console.error("Grade API error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

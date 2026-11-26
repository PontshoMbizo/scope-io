// Locked-block check for fulgurlab submissions. The editor stops a learner from changing a locked
// block, but the diagram reaches /api/grade from the browser, so the server checks again: every
// block the starter marked `locked` must still be there, at the same id path, with the same type and
// parameters (a locked subsystem: its whole inside too), and the stop time and sample step must be
// the starter's. Otherwise a learner could replace the plant with something easier, or stretch the
// run. Pure.

/** JSON with object keys sorted, so equal values compare equal whatever order they were written in. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The part of a block a learner may not change: type, params and, for a subsystem, its inside. */
function essence(b) {
  return canonical({
    type: b.type,
    params: b.params || {},
    ...(b.system ? { system: { blocks: (b.system.blocks || []).map((x) => ({ id: x.id, e: essence(x) })), links: b.system.links || [] } } : {}),
  });
}

/** Map of id path ("plant", "fwd/pid") -> block, for every block at every level. */
function blocksByPath(net) {
  const out = new Map();
  const walk = (level, prefix) => {
    for (const b of level?.blocks || []) {
      if (!b || typeof b.id !== "string") continue;
      out.set(prefix + b.id, b);
      if (b.system) walk(b.system, `${prefix}${b.id}/`);
    }
  };
  walk(net, "");
  return out;
}

/**
 * @returns {{ ok: boolean, errors: string[] }}  errors are written for the learner
 */
export function checkLocked(starter, submitted) {
  const errors = [];
  if (!submitted || typeof submitted !== "object" || !Array.isArray(submitted.blocks)) {
    return { ok: false, errors: ["The submission is not a fulgurlab diagram"] };
  }
  const want = blocksByPath(starter);
  const have = blocksByPath(submitted);
  for (const [path, b] of want) {
    if (!b.locked) continue;
    const label = b.name ? `"${b.name}" (${path})` : `"${path}"`;
    const got = have.get(path);
    if (!got) errors.push(`The locked block ${label} is missing. Reset to the template, or put it back.`);
    else if (got.type !== b.type) errors.push(`The locked block ${label} was replaced by a ${got.type} block.`);
    else if (essence(got) !== essence(b)) errors.push(`The locked block ${label} was changed. Its parameters are part of the problem.`);
  }
  const s0 = starter?.settings || {}, s1 = submitted.settings || {};
  for (const [k, name] of [["tf", "stop time"], ["dt", "sample step"]]) {
    if (s0[k] !== undefined && Number(s1[k]) !== Number(s0[k])) errors.push(`The ${name} must stay ${s0[k]} s (yours is ${s1[k]} s).`);
  }
  return { ok: errors.length === 0, errors };
}

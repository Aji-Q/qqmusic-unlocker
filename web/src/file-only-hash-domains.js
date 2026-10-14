// Exact keyHash prefix feasibility; no private data or PRGA oracle.
export function pruneHashDomains(candidate, budget = 1_000_000, checkpoint = () => {}) {
  const { hash, choices } = candidate,
    allowed = choices.map(() => new Set()),
    path = [],
    stats = { visits: 0, solutions: 0, maxStop: 0, acceptWork: 0 };
  checkpoint();
  function visit(index, value) {
    if (++stats.visits > budget) throw new Error('hash domain budget');
    if ((stats.visits & 255) === 0) checkpoint();
    if (index === 512) {
      if (value === hash) accept(index);
      return;
    }
    for (const seed of choices[index]) {
      path[index] = seed;
      if (!seed) {
        visit(index + 1, value);
        continue;
      }
      const next = (value * seed) >>> 0;
      if (!next || next <= value) {
        if (value === hash) accept(index + 1);
      } else if (next <= hash) visit(index + 1, next);
    }
  }
  function retain(index, seed) {
    if (++stats.acceptWork > 5_000_000) throw new Error('hash domain acceptance budget');
    if ((stats.acceptWork & 1023) === 0) checkpoint();
    allowed[index].add(seed);
  }
  function accept(stop) {
    stats.solutions++;
    stats.maxStop = Math.max(stats.maxStop, stop);
    for (let i = 0; i < stop; i++) retain(i, path[i]);
    for (let i = stop; i < 512; i++) for (const seed of choices[i]) retain(i, seed);
  }
  visit(0, 1);
  return {
    candidate: { ...candidate, choices: allowed.map((s) => [...s]) },
    stats,
  };
}

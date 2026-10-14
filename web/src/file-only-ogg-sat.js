import { completeStream } from './file-only-ogg-equations.js';
function fail(message, code = 'recovery_unresolved') {
  const error = new Error(message);
  error.code = code;
  throw error;
}
/** Exact integer lacing sums complement the original CRC equations. */
export async function solveLacing(cipher, obs, candidate, checkpoint = () => {}) {
  const result = completeStream(cipher, obs, candidate, {
      system: true,
      checkpoint,
    }),
    { unknown, pivots, rhs, frames } = result.system,
    k = new Map(obs.known),
    sh = result.shifts,
    indices = new Map(unknown.map((j, i) => [j, i * 8 + 2]));
  const start = performance.now();
  const { Cadical, createModule } = await import('cadical-wasm');
  const solver =
    typeof process !== 'undefined' && process.versions?.node
      ? await Cadical.create({ quiet: true })
      : new Cadical(await createModule({ locateFile: () => '/vendor/cadical.wasm' }), {
          quiet: true,
        });
  let next = unknown.length * 8 + 2,
    clauses = 0;
  const clause = (a) => {
    if (++clauses > 1_000_000 || next > 250_000) fail('SAT memory budget');
    if ((clauses & 1023) === 0) checkpoint();
    solver.addClause(a);
  };
  try {
    solver.setTerminate(() => performance.now() - start > 30000);
    clause([1]);
    const cache = new Map();
    function xor(a, b) {
      if (a === -1) return b;
      if (b === -1) return a;
      if (a === 1) return -b;
      if (b === 1) return -a;
      if (a === b) return -1;
      if (a === -b) return 1;
      const id = [a, b].sort((x, y) => x - y).join(',');
      if (cache.has(id)) return cache.get(id);
      const c = next++;
      clause([a, b, -c]);
      clause([-a, -b, -c]);
      clause([a, -b, c]);
      clause([-a, b, c]);
      cache.set(id, c);
      return c;
    }
    function and(a, b) {
      if (a === -1 || b === -1) return -1;
      if (a === 1) return b;
      if (b === 1 || a === b) return a;
      if (a === -b) return -1;
      const c = next++;
      clause([-a, -b, c]);
      clause([a, -c]);
      clause([b, -c]);
      return c;
    }
    function or(a, b) {
      return -and(-a, -b);
    }
    for (let p = 0; p < pivots.length; p++)
      if (pivots[p]) {
        let acc = -1;
        for (let w = 0; w < pivots[p].length; w++) {
          let bits = pivots[p][w];
          while (bits) {
            const b = 31 - Math.clz32(bits & -bits);
            acc = xor(acc, w * 32 + b + 2);
            bits = (bits & (bits - 1)) >>> 0;
          }
        }
        clause([rhs[p] ? acc : -acc]);
      }
    function keyIndex(off) {
      const d = sh.get(Math.floor(off / 5120));
      return d === undefined ? undefined : (off % 5120) + d;
    }
    function byte(off) {
      const j = keyIndex(off);
      return j === undefined || !k.has(j) ? null : cipher[off] ^ k.get(j);
    }
    function byteBits(off) {
      const j = keyIndex(off);
      if (j === undefined) throw new Error('unknown shift');
      return Array.from({ length: 16 }, (_, b) => {
        if (b >= 8) return -1;
        if (k.has(j)) return ((cipher[off] ^ k.get(j)) >> b) & 1 ? 1 : -1;
        return (cipher[off] >> b) & 1 ? -(indices.get(j) + b) : indices.get(j) + b;
      });
    }
    function add(a, b) {
      const out = [];
      let carry = -1;
      for (let i = 0; i < 16; i++) {
        const t = xor(a[i], b[i]);
        out.push(xor(t, carry));
        carry = or(and(a[i], b[i]), and(t, carry));
      }
      clause([-carry]);
      return out;
    }
    const domains = new Map(obs.lacingDomains ?? []);
    for (const [j, values] of domains) {
      if (k.has(j) || !indices.has(j)) continue;
      const allowed = new Set(values),
        idx = indices.get(j);
      for (let v = 0; v < 256; v++)
        if (!allowed.has(v))
          clause(Array.from({ length: 8 }, (_, b) => ((v >> b) & 1 ? -(idx + b) : idx + b)));
    }
    let sumRows = 0,
      countBranches = 0;
    for (const [begin, end] of frames) {
      checkpoint();
      const knownCount = byte(begin + 26),
        j = keyIndex(begin + 26),
        counts =
          knownCount !== null
            ? [knownCount]
            : (domains.get(j) ?? Array.from({ length: 256 }, (_, i) => i))
                .map((v) => cipher[begin + 26] ^ v)
                .filter((v) => v > 0);
      if (counts.length > 32) continue;
      for (const count of counts) {
        let cond = 1;
        if (knownCount === null) {
          countBranches++;
          const bits = byteBits(begin + 26);
          for (let b = 0; b < 8; b++) cond = and(cond, (count >> b) & 1 ? bits[b] : -bits[b]);
        }
        let target = end - begin - 27 - count;
        const terms = [];
        for (let i = 0; i < count; i++) {
          const at = begin + 27 + i,
            v = byte(at);
          if (v !== null) target -= v;
          else terms.push(byteBits(at));
        }
        if (target < 0 || target > terms.length * 255) {
          clause([-cond]);
          continue;
        }
        if (!terms.length) continue;
        let sum = Array(16).fill(-1);
        for (const term of terms) sum = add(sum, term);
        sum.forEach((v, b) => clause([-cond, (target >> b) & 1 ? v : -v]));
        sumRows++;
      }
    }
    const status = solver.solve();
    if (status === 'unsatisfiable') fail('Contradictory lacing constraints', 'candidate_rejected');
    const model =
      status === 'satisfiable'
        ? unknown.map((_, i) => Array.from({ length: 8 }, (_, b) => solver.value(i * 8 + b + 2)))
        : null;
    checkpoint();
    // SAT is an optional inference pass. Unknown proves nothing and adds no bytes.
    if (model) {
      const used = new Set();
      for (let off = 128; off < cipher.length; off++) {
        if ((off & 65535) === 0) checkpoint();
        used.add(keyIndex(off));
      }
      const relevant = unknown.flatMap((j, i) =>
        used.has(j)
          ? Array.from({ length: 8 }, (_, b) => (model[i][b] ? -(i * 8 + b + 2) : i * 8 + b + 2))
          : [],
      );
      solver.constrain(relevant);
      const unique = solver.solve();
      checkpoint();
      for (let i = 0; i < unknown.length; i++) {
        checkpoint();
        if (!used.has(unknown[i])) continue;
        let value = 0,
          complete = true;
        for (let b = 0; b < 8; b++) {
          checkpoint();
          if (model[i][b]) value |= 1 << b;
          if (unique !== 'unsatisfiable' && performance.now() - start > 30000) {
            complete = false;
            break;
          }
          const check =
            unique === 'unsatisfiable'
              ? 'unsatisfiable'
              : solver.solve({
                  assumptions: [model[i][b] ? -(i * 8 + b + 2) : i * 8 + b + 2],
                  conflicts: 50000,
                });
          if (check !== 'unsatisfiable') complete = false;
        }
        if (complete) k.set(unknown[i], value);
        if (unique !== 'unsatisfiable' && performance.now() - start > 30000) break;
      }
    }
    return { ...obs, known: [...k], shifts: [...sh] };
  } finally {
    solver.dispose();
  }
}

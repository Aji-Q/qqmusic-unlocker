/** Continuous Xiph two-mode VBR profile; check the public setup before use. */
export function refineWindows(cipher, obs, checkpoint = () => {}) {
  const k = new Map(obs.known),
    sh = new Map(obs.shifts);
  const qi = (p) => (p % 5120) + sh.get(Math.floor(p / 5120)),
    byte = (p) => (k.has(qi(p)) ? cipher[p] ^ k.get(qi(p)) : null),
    u32 = (p) => {
      let v = 0;
      for (let b = 0; b < 4; b++) {
        const x = byte(p + b);
        if (x === null) return null;
        v |= x << (b * 8);
      }
      return v >>> 0;
    };
  const packets = [];
  let previousEnd = null,
    previousSeq = null,
    chain = 0;
  for (const { offset } of [...obs.pages].sort((a, b) => a.offset - b.offset)) {
    checkpoint();
    const count = byte(offset + 26),
      flag = byte(offset + 5),
      seq = u32(offset + 18);
    if (count === null || flag === null) throw new Error('missing page info');
    const lace = Array.from({ length: count }, (_, i) => byte(offset + 27 + i));
    if (lace.includes(null)) throw new Error('missing lacing');
    let pos = offset + 27 + count,
      beginning = !(flag & 1);
    if (offset !== previousEnd || seq !== previousSeq + 1) chain++;
    for (const n of lace) {
      if (beginning && n > 0) packets.push({ offset: pos, chain });
      pos += n;
      beginning = n < 255;
    }
    previousEnd = pos;
    previousSeq = seq;
  }
  let checked = 0;
  const additions = new Map(),
    details = [];
  function put(p, b, value) {
    const j = qi(p),
      v = ((cipher[p] >> b) & 1) ^ value,
      old = k.get(j);
    if (old !== undefined) {
      if (((old >> b) & 1) !== v) throw new Error('window mismatch');
      checked++;
      return;
    }
    const a = additions.get(j) ?? [0, 0];
    if (a[0] & (1 << b) && ((a[1] >> b) & 1) !== v) throw new Error('window conflict');
    a[0] |= 1 << b;
    a[1] = (a[1] & ~(1 << b)) | (v << b);
    additions.set(j, a);
  }
  for (let i = 1; i < packets.length - 1; i++) {
    if ((i & 255) === 0) checkpoint();
    const prev = packets[i - 1],
      cur = packets[i],
      next = packets[i + 1];
    if (prev.chain !== cur.chain || cur.chain !== next.chain) continue;
    const a = byte(prev.offset),
      b = byte(cur.offset),
      c = byte(next.offset);
    let mode = b === null ? null : (b >> 1) & 1;
    if (a !== null && a & 2) {
      const m = (a >> 3) & 1;
      put(cur.offset, 1, m);
      if (mode !== null && mode !== m) throw new Error('previous window mismatch');
      mode = m;
    }
    if (c !== null && c & 2) {
      const m = (c >> 2) & 1;
      put(cur.offset, 1, m);
      if (mode !== null && mode !== m) throw new Error('next window mismatch');
      mode = m;
    }
    if (mode === 1) {
      if (a !== null) put(cur.offset, 2, (a >> 1) & 1);
      if (c !== null) put(cur.offset, 3, (c >> 1) & 1);
    }
    if (b === null)
      details.push({
        index: qi(cur.offset),
        hasPrev: a !== null,
        hasNext: c !== null,
        mode,
      });
  }
  const bits = new Map((obs.knownBits ?? []).map(([j, m, v]) => [j, [m, v]]));
  for (const [j, [m, v]] of additions) {
    const [a, b] = bits.get(j) ?? [0, 0];
    if (((b ^ v) & a & m) !== 0) throw new Error('existing bit mismatch');
    bits.set(j, [a | m, b | v]);
  }

  return { ...obs, knownBits: [...bits].map(([j, [m, v]]) => [j, m, v]) };
}

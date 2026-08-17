import fs from "fs";

const norm = (s) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

const sim = (a, b) => {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - lev(a, b) / max;
};

function slotEntries(def) {
  if (Array.isArray(def)) return def.map((v) => [v, [v]]);
  return Object.entries(def).map(([canon, aliases]) => [
    canon,
    aliases?.length ? aliases : [canon],
  ]);
}

function expand(pattern, slots) {
  const slot = pattern.match(/\{(\w+)\}/);
  if (!slot) return [{ text: pattern, slots: {} }];
  const [token, name] = slot;
  const out = [];
  for (const [canon, aliases] of slotEntries(slots[name] || [])) {
    for (const alias of aliases) {
      for (const r of expand(pattern.replace(token, alias), slots)) {
        out.push({ text: r.text, slots: { ...r.slots, [name]: canon } });
      }
    }
  }
  return out;
}

// Returns a list of problems, empty when the grammar is usable.
//
// The confirmations check is the important one and it is not a shape check.
// A gated intent with nothing to confirm it is worse than a malformed file: the
// approval turn simply never matches, so every destructive action fails silently
// and the user is left believing they were ignored. Fail loudly at load instead.
export function validateGrammar(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["grammar is not an object"];

  const problems = [];
  if (!Array.isArray(raw.intents)) problems.push("intents must be an array");
  if (!raw.slots || typeof raw.slots !== "object" || Array.isArray(raw.slots))
    problems.push("slots must be an object");
  if (typeof raw.min_score !== "number") problems.push("min_score must be a number");

  const conf = raw.confirmations;
  if (conf !== undefined && (typeof conf !== "object" || conf === null || Array.isArray(conf)))
    problems.push("confirmations must be an object of kind -> phrases");

  const gated = Array.isArray(raw.intents) ? raw.intents.filter((i) => i?.gated) : [];
  if (gated.length) {
    for (const kind of ["confirm", "cancel"]) {
      if (!Array.isArray(conf?.[kind]) || !conf[kind].length) {
        problems.push(
          `confirmations.${kind} is missing or empty, but ${gated.length} intent(s) are gated ` +
          `(${gated.map((i) => i.id).join(", ")}) — they could never be approved`
        );
      }
    }
  }
  return problems;
}

export function buildGrammar(path = "./grammar.json") {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  const problems = validateGrammar(raw);
  if (problems.length)
    throw new Error(`invalid grammar at ${path}:\n  - ${problems.join("\n  - ")}`);

  const candidates = [];
  for (const intent of raw.intents) {
    for (const p of intent.patterns) {
      for (const e of expand(p, raw.slots)) {
        candidates.push({
          intent: intent.id,
          gated: intent.gated,
          handler: intent.handler,
          slots: e.slots,
          text: norm(e.text),
        });
      }
    }
  }
  const confirmations = [];
  for (const [kind, phrases] of Object.entries(raw.confirmations ?? {})) {
    for (const p of phrases) confirmations.push({ kind, text: norm(p) });
  }
  return { minScore: raw.min_score, candidates, confirmations };
}

const STOP = new Set([
  "the","a","an","is","are","it","s","to","of","we","i","me","my","and",
  "whats","what","how","do","did","does","be","on","for","that","this","up",
  "now","please","um","uh","er","ah","ok","okay","just","can","you","some",
  "like","well","hey","right","there","was","got",
]);

const content = (s) => new Set(norm(s).split(" ").filter((w) => w && !STOP.has(w)));

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const w of a) {
    for (const v of b) {
      if (w === v || sim(w, v) >= 0.85) { hit++; break; }
    }
  }
  return hit / Math.max(a.size, b.size);
}

function best(input, list) {
  const q = norm(input);
  const qc = content(q);
  let top = null;
  for (const c of list) {
    const ov = overlap(qc, content(c.text));
    if (ov === 0) continue;
    let score = 0.4 * sim(q, c.text) + 0.6 * ov;
    if (!top || score > top.score) top = { ...c, score };
  }
  return top;
}

export function match(transcript, grammar) {
  const top = best(transcript, grammar.candidates);
  if (!top || top.score < grammar.minScore) {
    return {
      ok: false,
      reason: "no_match",
      score: top?.score ?? 0,
      near: top ? { intent: top.intent, text: top.text, slots: top.slots } : null,
    };
  }
  return {
    ok: true,
    intent: top.intent,
    handler: top.handler,
    gated: top.gated,
    slots: top.slots,
    score: Number(top.score.toFixed(3)),
  };
}

export function matchConfirmation(transcript, grammar) {
  const top = best(transcript, grammar.confirmations);
  if (!top || top.score < grammar.minScore) return { ok: false };
  return { ok: true, kind: top.kind, score: Number(top.score.toFixed(3)) };
}

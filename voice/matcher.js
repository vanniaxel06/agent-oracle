import fs from "fs";

// Floor of the failed-command band, used when a grammar does not set one.
// A first cut, not a measurement — see classifyTurn.
const DEFAULT_NEAR_SCORE = 0.45;

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

  // near_score is the FLOOR of the failed-command band. Below it, a non-match is
  // conversation; between it and min_score, a misheard command.
  if (raw.near_score !== undefined) {
    if (typeof raw.near_score !== "number") {
      problems.push("near_score must be a number");
    } else if (typeof raw.min_score === "number" && raw.near_score >= raw.min_score) {
      // At or above min_score the band is empty, so every non-match falls to
      // conversation and misheard commands silently become chat — the exact
      // failure this split exists to prevent. Fail at load, not in the room.
      problems.push(
        `near_score (${raw.near_score}) must be BELOW min_score (${raw.min_score}); ` +
        `otherwise the failed-command band is empty and every misheard command ` +
        `is treated as conversation`
      );
    }
  }

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
  return {
    minScore: raw.min_score,
    // First cut, and deliberately a guess: the spec says this needs the miss
    // queue's real data to tune, and that tuning is the queue's whole purpose.
    // 0.45 against a 0.75 min_score is wide enough that a genuinely mangled
    // command lands in the band, and high enough that a question sharing one
    // incidental word with an intent does not.
    nearScore: typeof raw.near_score === "number" ? raw.near_score : DEFAULT_NEAR_SCORE,
    candidates,
    confirmations,
  };
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

/**
 * Which of the three turn types is this?
 *
 * THE PROBLEM: a mangled "close stellar" and a genuine question both arrive as
 * a non-match, and they need opposite handling. Treat a failed command as
 * conversation and it silently becomes a chat message — the user believes
 * nothing happened, when in fact it failed for a reason they cannot see. Treat
 * questions as failed commands and the triage queue fills with questions.
 *
 * Before this existed there was no split at all: server.js recorded EVERY
 * non-match as a miss and rejected it, so every genuine question was already
 * being handled as a failed command.
 *
 * THE HEURISTIC, per the spec's first cut — a band, not a boolean:
 *   score >= minScore                    command
 *   nearScore <= score < minScore        failed_command  -> miss queue
 *   score <  nearScore                   conversation    -> forward to Hermes
 *   no candidate shared a content word   conversation
 *
 * A band rather than "any near match at all" because `best()` only skips
 * candidates with ZERO content-word overlap. One incidental shared word — an
 * asset or agent name inside an ordinary question — is enough to produce a
 * near match, and without a floor every such question would be filed as a
 * misheard command.
 *
 * This is a heuristic and it is expected to be wrong at the edges. It is
 * tunable from one number, and the miss queue is what supplies the data to
 * tune it. Do not treat the default as measured.
 */
export function classifyTurn(transcript, grammar) {
  const m = match(transcript, grammar);
  if (m.ok) return { type: "command", ...m };

  // Nothing command-shaped was said: no candidate shared even one content word.
  if (!m.near) {
    return { type: "conversation", reason: "no_near_match", score: m.score, near: null };
  }
  if (m.score >= grammar.nearScore) {
    return { type: "failed_command", reason: "near_miss", score: m.score, near: m.near };
  }
  return { type: "conversation", reason: "below_floor", score: m.score, near: m.near };
}

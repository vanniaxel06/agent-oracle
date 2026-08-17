// Split the score distribution by clip length. If long-vs-long same-speaker
// scores are healthy (~0.7+) then the features are fine and short clips are the
// problem. If long-vs-long is also mediocre, suspect the filterbank or the
// synthetic audio, not the duration.
import * as ort from "onnxruntime-node";
import { readWav, fbank } from "./fbank.js";
import path from "path";

const SPEAKERS = ["david", "zira", "mark"];
const KINDS = ["enroll1", "enroll2", "short1", "short2"];
const isLong = (k) => k.startsWith("enroll");

const session = await ort.InferenceSession.create("./model.onnx");

const clips = [];
for (const s of SPEAKERS) for (const k of KINDS) {
  const feats = fbank(readWav(path.join("./wav", `${s}_${k}.wav`)));
  const flat = new Float32Array(feats.length * 80);
  for (let t = 0; t < feats.length; t++) for (let m = 0; m < 80; m++) flat[t * 80 + m] = feats[t][m];
  const out = await session.run({ feats: new ort.Tensor("float32", flat, [1, feats.length, 80]) });
  const v = Array.from(out.embs.data);
  const n = Math.hypot(...v);
  clips.push({ spk: s, kind: k, vec: v.map((x) => x / n), frames: feats.length });
}

const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const buckets = {
  "long vs long   same": [], "long vs long   diff": [],
  "long vs short  same": [], "long vs short  diff": [],
  "short vs short same": [], "short vs short diff": [],
};

for (let i = 0; i < clips.length; i++)
  for (let j = i + 1; j < clips.length; j++) {
    const a = clips[i], b = clips[j];
    const len = isLong(a.kind) && isLong(b.kind) ? "long vs long  "
              : !isLong(a.kind) && !isLong(b.kind) ? "short vs short"
              : "long vs short ";
    buckets[`${len} ${a.spk === b.spk ? "same" : "diff"}`].push(cos(a.vec, b.vec));
  }

const stat = (a) => a.length
  ? `n=${String(a.length).padEnd(2)} min ${Math.min(...a).toFixed(3)}  mean ${(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3)}  max ${Math.max(...a).toFixed(3)}`
  : "none";

console.log("\npairwise cosine by clip length\n");
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}  ${stat(v)}`);

for (const pair of ["long vs long  ", "long vs short ", "short vs short"]) {
  const s = buckets[`${pair} same`], d = buckets[`${pair} diff`];
  const m = Math.min(...s) - Math.max(...d);
  console.log(`\n  ${pair}: margin ${m >= 0 ? "+" : ""}${m.toFixed(3)}  ${m > 0 ? "separable" : "OVERLAPS"}`);
}

// Sanity: a clip against itself must be 1.0. If not, inference is non-deterministic.
console.log(`\n  self-similarity check: ${cos(clips[0].vec, clips[0].vec).toFixed(6)} (must be 1.000000)`);
console.log(`  frame counts: ${clips.map((c) => c.frames).join(", ")}`);

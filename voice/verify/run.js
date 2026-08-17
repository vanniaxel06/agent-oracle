import * as ort from "onnxruntime-node";
import { readWav, fbank } from "./fbank.js";
import path from "path";

const WAV = "./wav";
const SPEAKERS = ["david", "zira", "mark"];

const session = await ort.InferenceSession.create("./model.onnx");

async function embed(file) {
  const feats = fbank(readWav(path.join(WAV, file)));
  const T = feats.length;
  const flat = new Float32Array(T * 80);
  for (let t = 0; t < T; t++) for (let m = 0; m < 80; m++) flat[t * 80 + m] = feats[t][m];

  const t0 = process.hrtime.bigint();
  const out = await session.run({ feats: new ort.Tensor("float32", flat, [1, T, 80]) });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const v = Array.from(out.embs.data);
  const norm = Math.hypot(...v);
  return { vec: v.map((x) => x / norm), frames: T, ms };
}

const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

function centroid(vs) {
  const c = vs[0].map((_, i) => vs.reduce((s, v) => s + v[i], 0) / vs.length);
  const n = Math.hypot(...c);
  return c.map((x) => x / n);
}

// Enrol on the two long clips, verify against the short nonce-style ones,
// which is the shape the challenge design actually uses.
const enrolled = {}, probes = {};
let totalMs = 0, runs = 0;

for (const s of SPEAKERS) {
  const e1 = await embed(`${s}_enroll1.wav`);
  const e2 = await embed(`${s}_enroll2.wav`);
  enrolled[s] = centroid([e1.vec, e2.vec]);
  for (const r of [e1, e2]) { totalMs += r.ms; runs++; }

  probes[s] = {};
  for (const k of ["short1", "short2"]) {
    const p = await embed(`${s}_${k}.wav`);
    probes[s][k] = p;
    totalMs += p.ms; runs++;
  }
}

console.log(`\nembedding dim 256 · ${runs} inferences · mean ${(totalMs / runs).toFixed(1)}ms each\n`);

const w = 22;
console.log("cosine: enrolled voice (rows) vs short probe clip (cols)\n");
process.stdout.write("".padEnd(w));
for (const s of SPEAKERS) for (const k of ["short1", "short2"])
  process.stdout.write(`${s}/${k.slice(-1)}`.padStart(13));
console.log();

const same = [], diff = [];
for (const r of SPEAKERS) {
  process.stdout.write(`enrolled ${r}`.padEnd(w));
  for (const c of SPEAKERS) for (const k of ["short1", "short2"]) {
    const v = cos(enrolled[r], probes[c][k].vec);
    (r === c ? same : diff).push(v);
    const mark = r === c ? "*" : " ";
    process.stdout.write(`${mark}${v.toFixed(3)}`.padStart(13));
  }
  console.log();
}

const min = (a) => Math.min(...a), max = (a) => Math.max(...a);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

console.log(`\n  same speaker  n=${same.length}  min ${min(same).toFixed(3)}  mean ${mean(same).toFixed(3)}  max ${max(same).toFixed(3)}`);
console.log(`  diff speaker  n=${diff.length}  min ${min(diff).toFixed(3)}  mean ${mean(diff).toFixed(3)}  max ${max(diff).toFixed(3)}`);

const margin = min(same) - max(diff);
console.log(`\n  separation: worst same (${min(same).toFixed(3)}) - best diff (${max(diff).toFixed(3)}) = ${margin.toFixed(3)}`);
console.log(margin > 0
  ? `  SEPARABLE. Any threshold in (${max(diff).toFixed(3)}, ${min(same).toFixed(3)}) splits this set with no errors.`
  : `  NOT SEPARABLE on this set. No single threshold works.`);

const probeFrames = SPEAKERS.flatMap((s) => ["short1", "short2"].map((k) => probes[s][k].frames));
console.log(`\n  short probes ran ${min(probeFrames)}-${max(probeFrames)} frames (${(min(probeFrames) / 100).toFixed(1)}-${(max(probeFrames) / 100).toFixed(1)}s)`);

// Kaldi-compatible 80-bin log-mel filterbank, matching
// torchaudio.compliance.kaldi.fbank defaults, which is what WeSpeaker trained on.
// Params from the model's own config.yaml: 25ms window, 10ms shift, 80 mel bins.
import fs from "fs";

const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 400;   // 25ms
const FRAME_SHIFT = 160;    // 10ms
const FFT_SIZE = 512;       // next power of two above 400
const NUM_MEL = 80;
const LOW_FREQ = 20;
const HIGH_FREQ = 8000;     // nyquist
const PREEMPH = 0.97;
const EPS = 1.1920928955078125e-7; // torch.finfo(torch.float).eps

// --- WAV -------------------------------------------------------------------
// Kaldi expects samples in int16 range, not normalised to [-1,1].
export function readWav(path) {
  const b = fs.readFileSync(path);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE")
    throw new Error(`${path}: not a RIFF/WAVE file`);

  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString("ascii", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      fmt = {
        format: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        rate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = b.subarray(body, body + size);
    }
    pos = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt or data chunk`);
  if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels !== 1 || fmt.rate !== SAMPLE_RATE)
    throw new Error(`${path}: need 16kHz mono 16-bit PCM, got ${fmt.rate}Hz ${fmt.channels}ch ${fmt.bits}bit fmt=${fmt.format}`);

  const n = Math.floor(data.length / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2);
  return out;
}

// --- FFT -------------------------------------------------------------------
// Iterative radix-2. Size is fixed at 512 so this stays simple.
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// --- mel filterbank --------------------------------------------------------
const mel = (f) => 1127.0 * Math.log(1.0 + f / 700.0);

// Kaldi builds the banks over FFT_SIZE/2 bins (256), not the 257 rfft returns.
// The final bin is always zero. Getting this off by one is a silent accuracy bug.
function melBanks() {
  const numFftBins = FFT_SIZE / 2;
  const binWidth = SAMPLE_RATE / FFT_SIZE;
  const melLow = mel(LOW_FREQ), melHigh = mel(HIGH_FREQ);
  const delta = (melHigh - melLow) / (NUM_MEL + 1);

  const banks = [];
  for (let m = 0; m < NUM_MEL; m++) {
    const left = melLow + m * delta;
    const center = melLow + (m + 1) * delta;
    const right = melLow + (m + 2) * delta;
    const row = new Float64Array(numFftBins + 1); // +1 zero pad
    for (let k = 0; k < numFftBins; k++) {
      const mk = mel(binWidth * k);
      const up = (mk - left) / (center - left);
      const down = (right - mk) / (right - center);
      const w = Math.min(up, down);
      row[k] = w > 0 ? w : 0;
    }
    banks.push(row);
  }
  return banks;
}

// Povey window: hann(periodic=false) ^ 0.85
function poveyWindow() {
  const w = new Float64Array(FRAME_LENGTH);
  for (let i = 0; i < FRAME_LENGTH; i++)
    w[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_LENGTH - 1)), 0.85);
  return w;
}

const BANKS = melBanks();
const WINDOW = poveyWindow();

export function fbank(samples) {
  if (samples.length < FRAME_LENGTH) throw new Error("clip shorter than one frame");
  const numFrames = 1 + Math.floor((samples.length - FRAME_LENGTH) / FRAME_SHIFT); // snip_edges
  const feats = [];

  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const frame = new Float64Array(FRAME_LENGTH);

  for (let f = 0; f < numFrames; f++) {
    const off = f * FRAME_SHIFT;
    for (let i = 0; i < FRAME_LENGTH; i++) frame[i] = samples[off + i];

    // 1. remove DC offset
    let mean = 0;
    for (let i = 0; i < FRAME_LENGTH; i++) mean += frame[i];
    mean /= FRAME_LENGTH;
    for (let i = 0; i < FRAME_LENGTH; i++) frame[i] -= mean;

    // 2. pre-emphasis, replicate-padded so x[0] uses itself as predecessor
    for (let i = FRAME_LENGTH - 1; i >= 1; i--) frame[i] -= PREEMPH * frame[i - 1];
    frame[0] -= PREEMPH * frame[0];

    // 3. window, then zero-pad to the FFT size
    re.fill(0); im.fill(0);
    for (let i = 0; i < FRAME_LENGTH; i++) re[i] = frame[i] * WINDOW[i];

    fftInPlace(re, im);

    // 4. power spectrum over the 257 rfft bins
    const power = new Float64Array(FFT_SIZE / 2 + 1);
    for (let k = 0; k <= FFT_SIZE / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];

    // 5. apply banks, log-floor at float epsilon
    const row = new Float64Array(NUM_MEL);
    for (let m = 0; m < NUM_MEL; m++) {
      let acc = 0;
      const bank = BANKS[m];
      for (let k = 0; k < bank.length; k++) if (bank[k] !== 0) acc += bank[k] * power[k];
      row[m] = Math.log(Math.max(acc, EPS));
    }
    feats.push(row);
  }

  // 6. cepstral mean normalisation over time, as WeSpeaker's own inference does
  for (let m = 0; m < NUM_MEL; m++) {
    let s = 0;
    for (const r of feats) s += r[m];
    const mu = s / feats.length;
    for (const r of feats) r[m] -= mu;
  }

  return feats;
}

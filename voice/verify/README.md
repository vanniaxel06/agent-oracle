# Speaker verification harness

Answers one question: can speaker verification run in Node, without adding
Python and torch to a server already running Hermes, the agents and nginx.

**It can.** Findings and caveats are in
[`../../docs/superpowers/specs/2026-08-17-voice-terminal-design.md`](../../docs/superpowers/specs/2026-08-17-voice-terminal-design.md)
under "Speaker verification, measured". Read the caveats before quoting any
number from here: the test used synthetic voices, and synthetic same-speaker
audio is far more self-consistent than a real person on two different days, so
the margins are optimistic rather than conservative.

## Running it

```bash
npm install onnxruntime-node
```

```bash
curl -L -o model.onnx https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/main/voxceleb_resnet34_LM.onnx
```

Neither the 26MB model nor `node_modules` (261MB) is committed. The model is
ungated, so no token is needed.

Put 16kHz mono 16-bit WAVs in `wav/` named `<speaker>_<kind>.wav`, with kinds
`enroll1`, `enroll2`, `short1`, `short2`. To regenerate the synthetic set on
Windows, use `System.Speech.Synthesis.SpeechSynthesizer` with an explicit
`SpeechAudioFormatInfo(16000, Sixteen, Mono)`; the default output rate is not
16kHz and the loader will reject it rather than resample.

```bash
node run.js     # enrol on long clips, verify against short ones
node diag.js    # split the score distribution by clip length
```

## Files

| | |
|---|---|
| `fbank.js` | Kaldi-compatible 80-bin log-mel features in plain JS, plus a WAV reader |
| `run.js` | enrol, probe, cosine matrix, separation margin |
| `diag.js` | the same scores bucketed by clip duration |

## Why `fbank.js` is fussy

The model takes precomputed features, not audio, and it was trained on
`torchaudio.compliance.kaldi.fbank`. Every convention has to match: Povey window
rather than plain Hann, replicate-padded pre-emphasis, a 512-point FFT for a
400-sample frame, mel banks built over 256 bins rather than the 257 an rfft
returns, a log floor at float epsilon, and cepstral mean normalisation at the
end.

Getting any of these wrong does not throw. It quietly degrades the embeddings,
which reads as "speaker verification isn't accurate enough for this" and sends
you off redesigning around a problem you don't have. The check that the features
are right is same-speaker long clips scoring around 0.91; anything much below
that means suspect the filterbank before suspecting the model.

`run.js` also asserts self-similarity is exactly 1.000000, which catches
non-deterministic inference.

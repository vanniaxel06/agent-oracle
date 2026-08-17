# Agent Oracle — Voice Link v0.1

> **Partially integrated.** These files were written in a separate session and
> landed unmodified so the fixes read as their own diffs. `PROTOCOL.md` and
> `sim.js` are referenced below but were never part of the handoff, so anything
> depending on them does not work yet.
>
> The current design, including which parts of this README are superseded, is
> [`../docs/superpowers/specs/2026-08-17-voice-terminal-design.md`](../docs/superpowers/specs/2026-08-17-voice-terminal-design.md).
> Read that first. In particular the display is no longer "a status light only",
> the keyboard that briefly appeared in the design is gone, and free-form speech
> now has a defined path rather than only being rejected.
>
> Start with `cp grammar.example.json grammar.json`. The live file is gitignored
> because the studio rewrites it at runtime; the example is the tracked
> reference. `npm run check` validates a grammar without starting anything.

Voice-only control surface for the Round Table. ESP32-S3 puck streams audio to
the VPS; display is a status light only.

## Files
- `PROTOCOL.md` — WebSocket frames, display states, turn lifecycle
- `grammar.json` — whitelisted intents + slots. Free-form is never executed.
- `matcher.js` — fuzzy match transcript → intent. Content-token gated.
- `server.js` — WS server, whisper.cpp ASR, approval state machine
- `misses.js` — captures every `no_match` turn, dedupes by transcript
- `api.js` — triage HTTP API (`/misses`, `/grammar`) for the studio UI
- `sim.js` — fake device, exercises the loop without hardware
- `grammar-studio.jsx` — triage queue UI. Same loop as the Playwright profile
  work: collect real failures, map them, replay from the mapping.

## Setup

```bash
npm install
git clone https://github.com/ggerganov/whisper.cpp /opt/whisper.cpp
cd /opt/whisper.cpp && cmake -B build && cmake --build build -j --config Release
sh ./models/download-ggml-model.sh small.en
```

```bash
DEVICE_TOKEN=$(openssl rand -hex 16) npm start   # ws :8787, api :8788
DEVICE_TOKEN=<same> npm run sim
```

Point the studio's setup tab at `http://<vps>:8788`. Editing grammar there
PUTs back and the server hot-reloads — no restart.

## Wire up before it's real
1. `dispatch()` → Hermes RPC. Return `{ ok, speak }`.
2. `synth()` → TTS. Piper local, or ElevenLabs. Return audio Buffer.
3. `logEvent()` → `rt_events` insert with hash-chain.

## Order of work
1. Server + sim loop green (no hardware needed)
2. Feed real WAVs through `transcribe()` — measure latency, tune model size
3. Flash Xiaozhi on the S3, point its WS backend here
4. Replace Xiaozhi's UI layer with the 5-colour state renderer
5. Enclosure

## Accent loop

Every miss lands in `misses.jsonl` with its near-match and the slot it nearly
filled. Studio ranks by frequency, so the words you mangle most surface first.
Map, export, repeat — the alias table absorbs your accent and model size stops
mattering much.

Also pass your proper nouns to whisper so it stops inventing:

```
"--prompt", "Hermes, Vega, Motoko, Togusawa, Batou, Prometheus, HyperLiquid, XLM"
```

## Known gaps in v0.1
- No barge-in. Device won't listen while speaking.
- Triage API has no rate limit and writes grammar to disk. Bind to localhost
  and tunnel, or put it behind your reverse proxy.
- Whisper runs per-utterance, cold each time. Persist the process if latency hurts.
- No speaker verification — anyone within earshot can issue ungated intents.
  Gated intents need confirmation but that's still voice, not identity.
- Audio is unencrypted over WS. Use wss:// before this leaves the LAN.

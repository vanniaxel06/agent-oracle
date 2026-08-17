# Agent Oracle Terminal — design

> **WITHDRAWN, same day.** Superseded by
> [`2026-08-17-voice-terminal-design.md`](2026-08-17-voice-terminal-design.md),
> which drops the keyboard. Kept because the keyboard will occur to someone
> again and the reason it fails is not obvious until stated: a small handheld is
> strictly dominated as a text terminal by hardware the user already owns. The
> hardware research here stands and is reusable if that ever changes.

2026-08-17. Re-scope of Voice Link v0.1 from a voice-only puck to a
keyboard-and-voice handheld terminal.

Supersedes the input model in the Voice Link v0.1 README. It does not supersede
anything in [`../../decisions.md`](../../decisions.md); where the two touch, this
document says so explicitly.

---

## What changed

Voice Link v0.1 was voice-only. An ESP32-S3 puck streamed audio to the VPS,
whisper transcribed it, a whitelist grammar matched it, and the display was five
colours of status light. Every design choice followed from voice being the only
input.

The terminal adds a physical keyboard as a first-class input. That is not a
feature bolt-on. It changes what the device is for, and it invalidates three
assumptions v0.1 was built on:

- **ASR stops being on the critical path.** Typed input needs no whisper.
- **Fuzzy matching stops being load-bearing.** Typed input is unambiguous, so
  the accent loop and the miss queue solve a problem the keys do not have.
- **The display stops being a status light.** A terminal needs a character
  renderer on a real panel, not an RGB state machine.

## Decisions locked

| # | Decision | Consequence |
|---|---|---|
| 1 | Voice Link and the ESP32 device are one project, not two | The grammar work belongs in this repo |
| 2 | Two equal input paths into one intent layer | Both inputs reach the same `match()` and the same gating |
| 3 | Typed free-form is unrestricted in what it can *say*; voice is the identity factor | The keyboard can express anything, including free-form Hermes chat. It cannot approve a destructive action on its own |
| 4 | Destructive intents re-authenticate per action, by nonce challenge | Replay of a recording cannot approve a trade |
| 5 | Hardware is a LILYGO T-Deck class device | Not a custom puck, not the CYD |
| 6 | No Xiaozhi | See "Firmware" below |

### On decision 3

Voice moves from being the command channel, where it was weakest, to being the
identity channel, where nothing else on the device can substitute for it. This
is the reason the microphone survives a re-scope that otherwise makes typing the
primary input.

### On decision 4

A fixed passphrase is replayable, and standardising it makes replay easier
rather than harder. The device therefore issues the phrase: it displays
`say: four, seven, blue`, the user repeats it, and two checks run against the
same clip. Whisper confirms the words match the nonce. The speaker embedding
confirms the voice is the enrolled one. Both must pass.

A recording cannot answer a challenge it has never heard. This uses the two
models already in the design and adds no new dependency. It costs a few seconds
on actions taken rarely.

## Relationship to the existing firmware

This repo today is the CYD wall renderer: it polls `GET /status/{key}` and draws
what comes back. The terminal is a **second device class in the same project**,
not a replacement. The wall units keep their poll loop, their offline rule and
their board definitions untouched.

What carries over unchanged, because it is the spine of the project rather than
a property of the CYD:

- **The device is dumb.** All intelligence is server-side. The terminal renders
  frames and forwards input. It holds no grammar, no thresholds and no
  agent-specific knowledge.
- **Staleness is the product.** A terminal showing a stale answer is the same
  failure as a screen showing a stale green tick.
- **Identity lives in NVS, never in the image.** One binary, many units.

What differs:

| | Wall unit | Terminal |
|---|---|---|
| Transport | `GET /status/{key}` every 30s | persistent WebSocket |
| Direction | pull | bidirectional push |
| Input | one touch target | keyboard, microphone, trackball |
| Display | 5 label/value lines | scrolling text |
| Failure mode | `OFFLINE` after 2 min | same rule, same reason |

The offline rule ports verbatim. The server still cannot report that it is
unreachable, so the device still must not trust silence.

## What this resolves in decisions.md

`decisions.md` "Known limitations" states that the device key is a bearer token,
that it proves possession rather than identity, and that it is explicitly **not
a basis for approvals**. The T-Deck has no secure element either, so that
limitation is unchanged at the device layer.

The voice challenge is what makes approvals defensible on top of it, and only
because the verification happens on the VPS where the enrolled embedding lives.
The device never decides who is speaking. It captures audio and forwards it,
exactly as it forwards keystrokes.

Restated as the rule to hold:

> The device token authenticates the *device*. The voice challenge authenticates
> the *person*. No destructive action may be approved on the strength of the
> device token alone.

A stolen terminal is a stolen bearer token. It can read status and issue ungated
intents. It cannot close a position.

## Architecture

```
T-Deck                             VPS
------                             ---
mic ──PCM──────────┐
keyboard ──text────┼──WS :8787──▶  server.js
                   │               ├─ transcribe()      whisper.cpp
screen ◀──frames───┤               ├─ verify()          ECAPA embedding
speaker ◀──audio───┘               ├─ match()           matcher.js, typed + spoken
                                   ├─ challenge()       nonce issue and check
                                   ├─ dispatch()        Hermes RPC
                                   └─ logEvent()        rt_events, hash-chained

                                   api.js :8788  ──▶ grammar studio (triage)
```

### Turn types

| Input | Path |
|---|---|
| Spoken, matches an intent | transcribe, match, gate if destructive, dispatch |
| Spoken, no match | record miss, reject, speak the rejection |
| Typed, matches an intent | match, gate if destructive, dispatch |
| Typed, no match | forward to Hermes as conversation, return the reply |
| Any destructive intent | issue nonce, capture response, verify words and voice, dispatch |

Typed misses do not enter the triage queue. There is no accent to absorb and
nothing to map, so a typed non-match is a conversation rather than a failure.
The queue stays a voice-only instrument.

### Session state

Unlock is not a session-wide grant. There is no "unlocked" mode to walk away
from, because decision 4 puts the challenge on the action rather than on the
session.

Ordinary use therefore needs no *voice* authentication; only the gated set does.
The device token is still required for every turn, spoken or typed, because it
is what authorises the WebSocket at all.

## Security model

**Protects against:** someone picking up the device and firing a destructive
intent; a housemate or visitor issuing commands in earshot; an ungated intent
being escalated by rewording it.

**Does not protect against:** an attacker with the device *and* a recording of
the enrolled voice responding to a live challenge, which requires real-time
synthesis rather than replay; an attacker with root on the VPS, where the
embedding and the dispatch path both live; a stolen device reading status.

**Explicitly out of scope:** anti-spoofing models. That is a second model and a
materially harder problem, and the realistic adversary for a device on a desk is
casual rather than targeted. Revisit if the device leaves the house.

## Firmware

Xiaozhi is rejected on two independent grounds.

It has no T-Deck board target. `main/boards/lilygo` contains `t-cameraplus-s3`,
`t-circle-s3`, `t-display-p4` and `t-display-s3-pro-mvsrlora`. Adopting it would
mean a board port, not a flash.

More decisively, Xiaozhi places wake word, protocol handling and assistant logic
on the device. That is the precise thing the first entry in `decisions.md`
forbids, and the property that entry describes as "the entire argument for the
architecture". The server already owns ASR, matching, gating and dispatch, so
Xiaozhi's main value is already built in Node.

The firmware to write instead is small:

1. WiFi provisioning and NVS identity, ported from the existing wall firmware
2. WebSocket client with the device token
3. I²C keyboard read from the secondary ESP32-C3, forwarded as text frames
4. Microphone capture to PCM, streamed on wake
5. Text renderer on the 320x240 ST7789
6. Audio playback for TTS frames
7. The offline rule, ported verbatim

## Hardware

LILYGO T-Deck. ESP32-S3FN16R8, 16MB flash, 8MB PSRAM, 2.8" 320x240 ST7789 IPS,
BlackBerry-style QWERTY over I²C driven by a secondary ESP32-C3, two MEMS
microphones and a speaker amp behind an ES7210 codec, trackball, TF card, LoRa
SX1262.

Every objection raised against a keyboard early in scoping was wrong. The
keyboard costs two pins and no USB port, needs no BLE stack, no pairing and no
second battery.

The enclosure plan changes. This is a handheld with its own shell, not a desk
puck, so the walnut case notes in [`../../../enclosure/`](../../../enclosure/)
apply to the wall units only.

## Unverified

Carried deliberately rather than assumed. Each one can change the plan.

- **ECAPA under `onnxruntime-node`.** An ONNX export would keep the stack
  Node-only. Failing that, speaker verification means Python and torch on a VPS
  already running Hermes, the agents and nginx. Verify before committing.
- **T-Deck audio output path.** The microphone side is ES7210. The speaker side
  was reported inconsistently in sourcing and has not been confirmed against a
  schematic.
- **Base T-Deck price and AU availability.** Verified: T-Deck Plus at USD
  107-119, T-Deck Pro 4G at USD 129.97. The base model was not confirmed.
- **Enrollment flow.** How many utterances, captured on what, stored where.
- **Verification accuracy in a real room.** Published EER figures are clean-data
  and near-field. A cheap MEMS mic at arm's length is a different problem.

## Order of work

1. Land the six Voice Link files into the repo and fix the `confirmations`
   landmine below
2. Verify ECAPA under `onnxruntime-node` with a two-speaker test, before
   anything else depends on it
3. Extend `matcher.js` for typed input and the Hermes conversation fallback
4. Build the nonce challenge end to end against `sim.js`, no hardware
5. Enrollment and verification, still on `sim.js`
6. Order the board once step 2 has passed
7. Firmware, display first then keyboard then audio, per the bring-up order that
   `decisions.md` already recommends
8. Enclosure

Steps 1 to 5 need no hardware. The board is not on the critical path until 6.

## Known landmines

**`matcher.js:70` will brick the server.** `buildGrammar` does
`Object.entries(raw.confirmations)` with no guard, and `api.js:57` validates only
`intents` and `slots` before writing to disk. The studio's `SEED` has no
`confirmations` key, so "reset grammar to seed", or any alias saved while the
studio is offline, PUTs a grammar that makes `buildGrammar` throw.

The running server survives, because the assignment fails and the old grammar
stays in memory, but `grammar.json` on disk is now poisoned and the next restart
dies at `server.js:21`. Recovery is `mv grammar.json.bak grammar.json`, since
`api.js:58` writes the backup first.

Fix both ends: default `raw.confirmations` to `{}` in the matcher, and require
it in the API's validation.

**The triage API writes grammar to disk with no rate limit.** Already noted in
the Voice Link README. Bind to localhost and tunnel, or put it behind the
existing nginx.

**The studio talks to the VPS over plain HTTP.** Serving the studio over HTTPS
will get the requests blocked as mixed content.

# Agent Oracle Voice — design

2026-08-17. Extends Voice Link v0.1 from a command surface into a voice
interface with identity, and sets the product it is for.

Supersedes [`2026-08-17-terminal-rescope-design.md`](2026-08-17-terminal-rescope-design.md),
which added a physical keyboard. That design is withdrawn; see "Rejected: the
keyboard" for why, so it does not get proposed again.

Nothing in [`../../decisions.md`](../../decisions.md) is superseded. Where the
two touch, this document says so.

---

## What this is

A desk device you speak to and listen to, instead of typing at and reading. One
person, one device, at arm's length, in a room where they are alone or nearly
alone.

Who it is for:

- The agentic coder, hands on the keyboard, who wants to ask a running agent
  something without breaking flow to find the right window
- The accountant at his desk, mid-admin, who wants an answer rather than a
  dashboard
- The small business owner doing the books, who will never open a terminal
- Tayla, settled at her desk, who wants to speak to the thing and hear back

The common thread is not novelty. It is that for these people, typing and
reading is the *expensive* path, and the alternative today is a chat window that
demands both.

## The thesis, stated plainly so it can be defended

**Speaking and listening is the interface. Everything else is a compromise.**

This device exists to develop new ways to identify, command, prompt and gate by
voice. Any feature that does not advance one of those four is out of scope, no
matter how good it would be in isolation.

It also needs no hardware beyond the ESP32-S3 already ordered, which is the
second half of the argument. A design that requires new parts to be interesting
has lost the plot.

## Rejected: the keyboard

A BlackBerry-style physical keyboard was designed in full and then withdrawn the
same evening. Recorded here because it was attractive, it will occur to someone
again, and the reason it fails is not obvious until you say it out loud.

**Why it fails.** As a text terminal, a small handheld is strictly dominated by
hardware the user already owns. Worse keyboard than their laptop, worse screen
than their phone, and Telegram already delivers agent chat to both from
anywhere. There is no task where thumb keys at 320x240 beat the machine they are
sitting at.

**What it was standing in for.** The want was never keys. It was conversation
rather than a command whitelist: being able to *ask* rather than only *issue*.
Voice serves that want directly, and the mechanism is in this document under
"Turn types". The keys were an implementation of a want that has a better
implementation.

**The one real argument for it**, kept honest: voice fails in a shared room, at
night, and when the answer is long. A keyboard genuinely fixes that. It is not
decisive because every user in the persona list has a laptop and a phone for
exactly those moments, and because this is a desk device for one-on-one use by
design rather than by accident.

The hardware question, if it ever returns, is already answered. The LILYGO
T-Deck is this device with a keyboard attached, at roughly USD 110, and it needs
a firmware port because Xiaozhi has no board target for it. Parked, not lost.

## Decisions locked

| # | Decision | Consequence |
|---|---|---|
| 1 | Voice Link and the ESP32 device are one project | The grammar work belongs in this repo |
| 2 | Voice only. No keyboard, now or in this scope | The interface is speech in, speech out, with the screen as state |
| 3 | Voice is the identity factor, not just the command channel | The microphone does something no laptop or Telegram message can |
| 4 | Free-form speech is answered, never executed | Ask anything; only whitelisted intents dispatch |
| 5 | Destructive intents re-authenticate per action, by nonce challenge | Replay of a recording cannot approve an action |
| 6 | No Xiaozhi | See "Firmware" |
| 7 | Hardware is the ESP32-S3 already ordered | No new parts are required for the design to be interesting |

### On decision 3

This is the whole reason the project is not redundant with Telegram. A Telegram
message proves someone is holding the phone. It does not prove who. `decisions.md`
already records the same gap in this project's own bearer token, and calls it
disqualifying for approvals.

A voice embedding is a claim about *who*, evaluated server-side against an
enrolled reference. That is the novel capability, and everything else in this
design is arranged to protect it.

### On decision 4

v0.1's rule was "free-form is never executed". That survives verbatim and turns
out to be the resolution rather than the restriction: free-form speech is
*answered* rather than executed. Ask anything you like and Hermes replies aloud.
Nothing dispatches a handler unless it matches an intent in the grammar.

This is what makes the device conversational without reopening the hole the
grammar was built to close.

### On decision 5

A fixed confirmation phrase is replayable, and standardising it makes replay
easier rather than harder. So the device issues the phrase.

It displays and speaks a short random challenge, the user repeats it, and two
checks run against the same clip. Whisper confirms the words match the nonce.
The speaker embedding confirms the voice is the enrolled one. Both must pass, or
nothing dispatches.

A recording cannot answer a challenge it has never heard. This reuses the two
models already in the design and adds no new dependency. It costs a few seconds
on actions taken rarely.

## Relationship to the existing firmware

This repo today is the CYD wall renderer: it polls `GET /status/{key}` and draws
what comes back. The voice device is a **second device class in the same
project**, not a replacement. The wall units keep their poll loop, their offline
rule and their board definitions untouched.

What carries across, because it is the spine of the project rather than a
property of the CYD:

- **The device is dumb.** All intelligence is server-side. It captures audio,
  plays audio, and renders state. It holds no grammar, no thresholds and no
  agent-specific knowledge.
- **Staleness is the product.** A spoken answer from a stale observation is the
  same failure as a green tick on a dead system, and is worse for being
  conversational, because speech sounds authoritative.
- **Identity lives in NVS, never in the image.** One binary, many units.
- **Diagnose the display with colour, never text.** Applies unchanged during
  bring-up.

What differs:

| | Wall unit | Voice device |
|---|---|---|
| Transport | `GET /status/{key}` every 30s | persistent WebSocket |
| Direction | pull | bidirectional push |
| Input | one touch target | microphone |
| Output | 5 label/value lines | speech, plus state on screen |
| Failure mode | `OFFLINE` after 2 min | same rule, same reason |

The offline rule ports verbatim. The server still cannot report that it is
unreachable, so the device still must not trust silence. On this device the
consequence is stronger: it must refuse to answer at all rather than answer from
anything cached.

## What this resolves in decisions.md

`decisions.md` "Known limitations" states that the device key is a bearer token,
that it proves possession rather than identity, and that it is explicitly **not
a basis for approvals**. The S3 has no secure element, so that limitation is
unchanged at the device layer.

The voice challenge is what makes approvals defensible on top of it, and only
because verification happens on the server where the enrolled embedding lives.
The device never decides who is speaking. It captures audio and forwards it.

The rule to hold:

> The device token authenticates the *device*. The voice challenge authenticates
> the *person*. No destructive action may be approved on the strength of the
> device token alone.

A stolen device is a stolen bearer token. It can hear status and issue ungated
intents. It cannot approve anything.

## Architecture

```
ESP32-S3                           Server
--------                           ------
mic ──PCM──WS :8787──────────────▶ server.js
                                   ├─ transcribe()   whisper.cpp
                                   ├─ verify()       speaker embedding
                                   ├─ match()        matcher.js
                                   ├─ challenge()    nonce issue and check
                                   ├─ converse()     Hermes, free-form
                                   ├─ dispatch()     Hermes RPC, whitelisted
                                   └─ logEvent()     rt_events, hash-chained
screen ◀──state───────────────────┤
speaker ◀──audio──────────────────┘

                                   api.js :8788 ──▶ grammar studio (triage)
```

### Turn types

| Utterance | Path |
|---|---|
| Matches an ungated intent | transcribe, match, dispatch, speak the result |
| Matches a gated intent | transcribe, match, issue nonce, verify words and voice, dispatch |
| No match, looks conversational | forward to Hermes, speak the reply, log as conversation |
| No match, looks like a failed command | record miss, say so, do nothing |

The last two need separating, and the separator is the honest hard part. A
mangled `"poz vega"` and a genuine question are both non-matches. Getting this
wrong in the conversational direction means a misheard command silently becomes
a chat message and the user thinks nothing happened. Getting it wrong the other
way fills the triage queue with questions.

First cut: near-match score above a floor and below `min_score` means a failed
command, so it goes to the queue. No near match at all means conversation. This
is a heuristic and it is expected to need the miss data to tune, which is what
the queue is for.

### The screen

The display stays a state renderer, not a transcript. Five states, colour-led,
per the existing house rule that a wall unit is diagnosed by colour:

`idle` · `listening` · `thinking` · `awaiting approval` · `spoke`

Rationale: a transcript invites reading, and reading is the thing this device
exists to avoid. The screen answers "is it doing something and did it hear me",
which speech alone cannot convey during the pause.

## Audio input and range

**Bluetooth headsets are not possible on this hardware.** The ESP32-S3 has BLE
only, with no Classic BR/EDR, and both A2DP and HFP require Classic. This is
confirmed by Espressif's Classic Bluetooth documentation existing only under the
`esp32` target, and by the maintainer of the standard ESP32-A2DP library
answering the direct question with no. LE Audio would sidestep it but needs
Bluetooth 5.2 with LC3, which the S3 does not have.

The want behind the request is not Bluetooth, it is not being tethered to where
the puck's microphone happens to sit. Three ways to get that, all better fits
for a dumb-device architecture than a Bluetooth stack would be:

1. **A second S3 as a satellite.** Same firmware, same token scheme, different
   room or different end of the desk. The server already accepts multiple
   devices. Cheapest and most consistent with everything else here.
2. **A phone as a microphone.** A small web page using `getUserMedia`, streaming
   to the same WebSocket endpoint. Zero hardware, works anywhere, and doubles as
   the enrollment capture surface.
3. **A USB headset.** The S3 has native USB OTG and can act as host, so a USB
   Audio Class device is possible. Real, but the fiddliest of the three and it
   tethers you to the puck anyway, which was the original complaint.

Recommendation is 1 and 2. Neither needs a decision now, and neither blocks
anything, so this section exists to stop Bluetooth being attempted.

## Security model

**Protects against:** someone else in the room issuing a destructive intent;
someone picking up the device and doing the same; an ungated intent being
escalated by rewording it; a recording of the user being replayed to approve
something.

**Does not protect against:** an attacker with the device *and* the ability to
synthesise the enrolled voice answering a live challenge in real time; an
attacker with root on the server, where the embedding and the dispatch path both
live; a stolen device listening to status.

**Explicitly out of scope:** anti-spoofing models. That is a second model and a
materially harder problem, and the realistic adversary for a device on a desk is
casual rather than targeted. Revisit if the device is ever sold into an
environment where it is not.

**The failure that matters most** is not an attacker. It is the device acting on
a misheard command with confidence. Speech has no equivalent of seeing the
command you typed before pressing enter, so gating is not only a security
control here, it is the undo button.

## Firmware

Xiaozhi is rejected on two independent grounds.

It places wake word, protocol handling and assistant logic *on the device*. That
is precisely what the first entry in `decisions.md` forbids, and the property it
calls "the entire argument for the architecture". The server already owns ASR,
matching, gating and dispatch, so Xiaozhi's main value is already built in Node.

Separately, its `main/boards/lilygo` family contains only `t-cameraplus-s3`,
`t-circle-s3`, `t-display-p4` and `t-display-s3-pro-mvsrlora`, so any LILYGO
board outside that list is a port rather than a flash.

The firmware to write instead is small:

1. WiFi provisioning and NVS identity, ported from the wall firmware
2. WebSocket client authenticated with the device token
3. Microphone capture to PCM, streamed between wake and end-of-speech
4. Audio playback for returned TTS
5. Five-state renderer on the panel
6. The offline rule, ported verbatim

## Unverified

Carried deliberately. Each can change the plan.

- **The speaker embedding runtime.** An ONNX export of ECAPA-TDNN under
  `onnxruntime-node` would keep the stack Node-only. Failing that, verification
  means Python and torch on a server already running Hermes, the agents and
  nginx. Verify before anything depends on it.
- **Verification accuracy in a real room.** Published equal-error rates are
  clean-data and near-field. A MEMS microphone at arm's length in an office is a
  different problem, and the number that matters is the false-accept rate at the
  operating point, not the headline EER.
- **The exact S3 board's microphone and audio-out path.** Confirm against the
  schematic for the board actually ordered before writing the capture code.
- **Wake mechanism.** Wake word, button, or always-listening with a local VAD.
  Each has a different privacy story, which matters more for the accountant than
  for the coder.
- **Whether whisper's latency is tolerable conversationally.** v0.1 already
  flags that it runs cold per utterance. A pause that is fine for a command may
  not be fine for a conversation.

## What this design does not yet answer

Stated because the persona list makes these real, and pretending otherwise would
build the wrong thing.

**Every persona needs a server, and they do not have one.** This design assumes
the VPS. An accountant has no VPS and never will. That leaves a hosted service,
an on-premise box, or local processing, and the choice changes the security
model, the cost model and the privacy story. It connects directly to the
existing private on-premise offering, where the confidential-document persona is
already the target, and where this device would be the voice front end rather
than a separate product.

**The grammar is per-deployment.** An accountant's intents are not `close
bitcoin`. The Grammar Studio stops being a debug tool and becomes the surface
where a deployment is configured, which is a much higher bar for it.

**Enrollment has to be trivial.** These users will not SSH anywhere to record
reference utterances. The phone-as-microphone page is the obvious candidate.

**Multi-user is unaddressed.** One enrolled voice per device is assumed
throughout. An office with two people at one desk breaks that assumption
silently, which is the worst way for it to break.

None of these block the build. All of them block calling it a product.

## Order of work

1. Land the six Voice Link files into the repo and fix the `confirmations`
   landmine below
2. Verify the speaker embedding under `onnxruntime-node`, two-speaker test,
   before anything else depends on it
3. Free-form fallthrough to Hermes, and the conversation-versus-failed-command
   split, against `sim.js`
4. Nonce challenge end to end, still against `sim.js`
5. Enrollment capture, whichever surface wins
6. Firmware on the S3 when it arrives, display first then audio, per the
   bring-up order `decisions.md` already recommends
7. Enclosure

Steps 1 to 5 need no hardware.

## Known landmines

**`matcher.js:70` will brick the server.** `buildGrammar` does
`Object.entries(raw.confirmations)` with no guard, and `api.js:57` validates only
`intents` and `slots` before writing to disk. The studio's `SEED` has no
`confirmations` key, so "reset grammar to seed", or any alias saved while the
studio is offline, PUTs a grammar that makes `buildGrammar` throw.

The running server survives, because the assignment fails and the old grammar
stays in memory, but `grammar.json` on disk is poisoned and the next restart dies
at `server.js:21`. Recovery is `mv grammar.json.bak grammar.json`, since
`api.js:58` writes the backup first.

Fix both ends: default `raw.confirmations` to `{}` in the matcher, and require it
in the API's validation.

**The triage API writes grammar to disk with no rate limit.** Already noted in
the Voice Link README. Bind to localhost and tunnel, or put it behind the
existing nginx.

**The studio talks to the server over plain HTTP.** Serving the studio over
HTTPS will get the requests blocked as mixed content.

# Server contract

Everything a server must do for an Agent Oracle screen. A working reference
implementation is in [`../server/`](../server/) — about 200 lines of dependency-free
Node. Read this if you're replacing it with something that already knows the state
of your systems, which is the expected end state.

## The idea

**The device is a dumb renderer.** It polls one URL every 30 seconds and draws
exactly what comes back: a title, a state word, a colour, and up to five
label/value lines. It contains no thresholds, no formatting rules and no
knowledge of what it is displaying.

That is the whole design. Changing what a screen says is a server-side edit that
every unit picks up on its next poll — no rebuild, no OTA, no physical access.
A screen in another building can be re-specified in the time it takes to edit a
config file.

## `GET /status/{key}`

The only endpoint a screen needs.

`{key}` is 16–64 hex characters and is the device's only credential, so generate
it randomly and treat it as a secret:

```bash
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

Respond `404` for an unknown key. Respond `200` with:

```json
{
  "title": "BUILDS",
  "state": "OK",
  "color": "green",
  "stale": false,
  "age": "12s",
  "age_s": 12,
  "lines": [
    { "l": "Branch",   "v": "main" },
    { "l": "Last run", "v": "14:02 ok" },
    { "l": "Failures", "v": "0" }
  ],
  "poll_s": 30,
  "ts": 1786492946
}
```

| Field | |
|---|---|
| `title` | ≤12 chars, shown large |
| `state` | ≤12 chars, shown in the state colour |
| `color` | `green`, `amber` or `red` — drives the text and the RGB LED |
| `lines` | up to 5 `{l, v}` pairs; `l` ≤10 chars, `v` ≤16 chars |
| `age` | human string for the footer |
| `poll_s` | advisory poll interval |

Short keys (`l`/`v`) are not stylistic. The target board has no PSRAM and parses
this into a fixed-size document; a live payload is around 300 bytes. If yours
stops fitting, the server is trying to say too much.

Serve it `Cache-Control: no-store`.

## The rule you must not break

**A screen showing green while the thing it monitors is dead is worse than no
screen.** Everything else here is negotiable; this is not.

Concretely, a correct server has **no code path that returns `green` from an old
observation**. Track when each source last reported, and past a per-source window
return red regardless of what the last reading said:

| Condition | Response |
|---|---|
| Observation newer than the window | the real state and colour |
| Observation older than the window | `NO HEARTBEAT`, **red**, last known values kept below so it stays diagnosable |
| Never observed | `NO DATA`, **red** |
| Unrecognised state word | **amber** — never invent confidence the source didn't report |

**Make the staleness window per source.** Cadences differ, and a single global
value is wrong for everything. An always-on process might be 120 seconds; a
four-hourly cron job needs its interval plus grace, or its screen reads red
permanently and people learn to ignore red.

The device enforces the other half on its own: if it cannot complete a poll for
two minutes it stops showing the last payload and displays `OFFLINE`. Your server
cannot report that it is unreachable, so the device must not trust silence.

## Choosing what goes on the lines

**Every line must be actionable.** Five rows is the entire budget, so a line that
is merely interesting is occupying space a line that changes behaviour could use.

Cut anything that makes you feel something but do nothing. Uptime percentage and
running totals are the usual offenders — they read as rigour and change nothing.

**Prefer a name over a count.** `Errors 2` says something is wrong; `Failing
nightly-sync` says where to look. If a count is available, the name behind it
usually is too.

A third element marks a line optional — `["Failing", "failing_job", true]` — so
it is omitted entirely when absent rather than rendering `--`. Required lines
still show `--` when missing: for a value you always expect, a visible gap is
information; for a conditional one it is noise.

## `POST /beat` (optional)

Only needed if sources push to you rather than being polled by the server.

```
POST /beat
X-Beat-Key: <shared secret>
{ "agent": "ci", "state": "ok", "fields": { "branch": "main" } }
```

If you implement it, **fail closed**: with no secret configured, return 503
rather than accepting anonymous writes. It drives what appears on a wall.

**Timestamp each observation with when the source last did something, never with
`Date.now()` at ingest.** Your collector running is not evidence the thing it
watches ran. Get this wrong and every screen is permanently green.

## TLS

The device pins ISRG Root X1 (Let's Encrypt) in `include/root_ca.h` and verifies
against it. If your server uses a certificate from another CA, replace that
header with your root.

Do not swap it for `setInsecure()`. The risk isn't eavesdropping — it's a spoofed
feed showing a green tick for a dead system, which is the failure this whole
design exists to prevent.

## OTA (optional)

The device fetches `/firmware/manifest-<BOARD_NAME>.json` on boot and hourly:

```json
{ "version": "0.4.0", "url": "https://your-host/firmware/agent-oracle-0.4.0.bin" }
```

It installs only strictly newer semantic versions. A deliberate rollback needs
`"allow_downgrade": true`.

**One manifest per board revision.** The revisions ship different display
controllers, and a shared manifest can flash the wrong driver onto a unit,
leaving a screen only a physical reflash can recover.

Serve manifests `no-store` and binaries immutable — a cached manifest means a
unit keeps running firmware you believe you replaced.

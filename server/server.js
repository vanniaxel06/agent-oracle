#!/usr/bin/env node
//
// Agent Oracle — reference server.
//
// Zero dependencies, Node 18+. Run it, flash a device, see your own text on a
// screen. It exists so this repo does something out of the box; it is not a
// product. Replace it with whatever already knows the state of your systems.
//
// THE ONE RULE YOU MUST KEEP IF YOU REPLACE THIS
//
// A screen showing green while the thing it monitors is dead is worse than no
// screen. There is deliberately no path here that returns green from an old
// beat: past a per-agent window it is red, always. If you write your own server
// and lose that property, you have built a decoration.
//
//   node server.js                 # listens on 8080
//   PORT=9000 node server.js
//   BEAT_SECRET=$(openssl rand -hex 16) node server.js
//
// Endpoints
//   POST /beat              agents push {agent, state, fields{}} (X-Beat-Key header)
//   GET  /status/{key}      what a device polls, every 30s
//   GET  /status/{key}/screen   the same payload as a 320x240 page, for a browser

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const BEAT_SECRET = process.env.BEAT_SECRET || '';
const POLL_SECONDS = 30;
const MAX_FIELDS = 5;
const MAX_VALUE_LEN = 16;

const CONFIG_FILE = path.join(__dirname, 'devices.json');
const BEATS_FILE = path.join(__dirname, 'beats.json');

// ── Config ────────────────────────────────────────────────────────────────────
// devices.json holds the device keys and what each screen should look like.
// Editing it changes what a screen says with no firmware involvement at all —
// that is the entire point of the architecture, so it is worth trying once.
function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error(`Cannot read ${CONFIG_FILE}: ${err.message}`);
    console.error('Copy devices.example.json to devices.json to get started.');
    process.exit(1);
  }
}

function loadBeats() {
  try { return JSON.parse(fs.readFileSync(BEATS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveBeats(beats) {
  // Write then rename: a device polling mid-write must never read half a file.
  const tmp = BEATS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(beats, null, 2));
  fs.renameSync(tmp, BEATS_FILE);
}

let config = loadConfig();
let beats = loadBeats();

// ── Presentation ──────────────────────────────────────────────────────────────
const GREEN = new Set(['ok', 'live', 'running', 'healthy', 'idle', 'up']);
const RED = new Set(['error', 'err', 'down', 'fail', 'failed', 'stopped', 'crashed']);

// Anything unrecognised is amber, never green. Do not "helpfully" default an
// unknown state to green: that invents confidence the agent never reported.
function colourFor(state) {
  const s = String(state || '').toLowerCase();
  if (RED.has(s)) return 'red';
  if (GREEN.has(s)) return 'green';
  return 'amber';
}

function ageLabel(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

// A layout line is [label, field] or [label, field, optional]. An optional line
// is omitted when the field is absent, instead of rendering "--". A required
// line still shows "--", because for a value you always expect, a visible gap is
// information; for a conditional one it is just noise.
function renderLines(device, fields) {
  const layout = Array.isArray(device.lines) ? device.lines : [];
  if (!layout.length) {
    return Object.keys(fields).slice(0, 4).map(k => ({ l: clip(k, 10), v: clip(fields[k], MAX_VALUE_LEN) }));
  }
  return layout
    .filter(([, key, optional]) => !optional || (fields[key] != null && fields[key] !== ''))
    .map(([label, key]) => ({
      l: clip(label, 10),
      v: fields[key] == null || fields[key] === '' ? '--' : clip(fields[key], MAX_VALUE_LEN),
    }));
}

// Everything a device is told to draw. Short keys keep the JSON near 300 bytes,
// which matters: the target board has no PSRAM and parses this into a fixed
// ArduinoJson document.
function buildPayload(device) {
  const now = Math.floor(Date.now() / 1000);
  const title = clip(device.title || device.agent, 12).toUpperCase();
  const beat = beats[device.agent];

  if (!beat) {
    return {
      title, state: 'NO DATA', color: 'red', stale: true, age: '--', age_s: -1,
      lines: [{ l: 'Agent', v: clip(device.agent, MAX_VALUE_LEN) }, { l: 'Beats', v: 'none yet' }],
      poll_s: POLL_SECONDS, ts: now,
    };
  }

  const age = Math.max(0, now - beat.ts);
  const staleAfter = device.stale_after_s || 120;
  const lines = renderLines(device, beat.fields || {});

  // THE INVARIANT. Past the window it is red, no exceptions, and the last known
  // values stay underneath so the screen is still diagnosable.
  if (age > staleAfter) {
    return {
      title, state: 'NO HEARTBEAT', color: 'red', stale: true,
      age: ageLabel(age), age_s: age,
      lines: [{ l: 'Last beat', v: `${ageLabel(age)} ago` }, ...lines.slice(0, 3)],
      poll_s: POLL_SECONDS, ts: now,
    };
  }

  return {
    title, state: clip(beat.state, 12).toUpperCase(), color: colourFor(beat.state),
    stale: false, age: ageLabel(age), age_s: age, lines,
    poll_s: POLL_SECONDS, ts: now,
  };
}

const escapeHtml = s => String(s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function screenHtml(p) {
  const dot = { green: '#22c55e', amber: '#f59e0b', red: '#ef4444' }[p.color] || '#f59e0b';
  const rows = p.lines.map(l =>
    `<div class="row"><span class="l">${escapeHtml(l.l)}</span><span class="v">${escapeHtml(l.v)}</span></div>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>${escapeHtml(p.title)} status</title><style>
body{background:#111;color:#eee;font-family:ui-monospace,Menlo,Consolas,monospace;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0}
.screen{width:320px;height:240px;background:#000;border:8px solid #2a2a2a;border-radius:6px;
padding:14px 16px;box-sizing:border-box;display:flex;flex-direction:column}
.head{display:flex;align-items:center;gap:8px;font-size:26px;margin-bottom:14px}
.dot{width:14px;height:14px;border-radius:50%;background:${dot};box-shadow:0 0 10px ${dot}}
.state{margin-left:auto;font-size:15px;color:${dot}}
.row{display:flex;font-size:17px;line-height:1.9}.l{color:#8a8a8a}.v{margin-left:auto}
.foot{margin-top:auto;font-size:11px;color:#555}</style>
<div class="screen"><div class="head"><span class="dot"></span><span>${escapeHtml(p.title)}</span>
<span class="state">${escapeHtml(p.state)}</span></div>${rows}
<div class="foot">beat ${escapeHtml(p.age)} ago · polls every ${p.poll_s}s</div></div>`;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/beat') {
    // Fail closed. An open write endpoint that drives what appears on a wall is
    // not something to leave "until later".
    if (!BEAT_SECRET) return send(res, 503, { error: 'BEAT_SECRET is not set' });
    if (req.headers['x-beat-key'] !== BEAT_SECRET) return send(res, 401, { error: 'Unauthorized' });

    let body = '';
    req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { return send(res, 400, { error: 'bad json' }); }
      const agent = String(payload.agent || '').toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(agent)) return send(res, 400, { error: 'bad agent' });
      if (!payload.state) return send(res, 400, { error: 'state required' });

      const fields = {};
      for (const k of Object.keys(payload.fields || {}).slice(0, MAX_FIELDS)) {
        fields[clip(k, 24)] = clip(payload.fields[k], MAX_VALUE_LEN);
      }
      beats[agent] = { state: String(payload.state), fields, ts: Math.floor(Date.now() / 1000) };
      saveBeats(beats);
      send(res, 200, { ok: true, agent, next_beat_s: POLL_SECONDS });
    });
    return;
  }

  const m = url.pathname.match(/^\/status\/([a-f0-9]{16,64})(\/screen)?$/i);
  if (req.method === 'GET' && m) {
    config = loadConfig();   // re-read so edits apply without a restart
    const device = (config.devices || []).find(d => d.key === m[1].toLowerCase());
    if (!device) return send(res, 404, { error: 'Not found' });
    const payload = buildPayload(device);
    return m[2] ? send(res, 200, screenHtml(payload), 'text/html; charset=utf-8')
                : send(res, 200, payload);
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Agent Oracle reference server on http://localhost:${PORT}`);
  if (!BEAT_SECRET) console.log('BEAT_SECRET unset — POST /beat will return 503.');
  for (const d of config.devices || []) {
    console.log(`  ${d.agent.padEnd(10)} http://localhost:${PORT}/status/${d.key}/screen`);
  }
});

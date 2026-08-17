import { WebSocketServer } from "ws";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { buildGrammar, match, matchConfirmation } from "./matcher.js";
import { recordMiss } from "./misses.js";
import { startApi } from "./api.js";

const run = promisify(execFile);

const PORT = process.env.PORT || 8787;
const TOKEN = process.env.DEVICE_TOKEN;
const WHISPER = process.env.WHISPER_BIN || "/opt/whisper.cpp/build/bin/whisper-cli";
const MODEL = process.env.WHISPER_MODEL || "/opt/whisper.cpp/models/ggml-small.en.bin";
const APPROVAL_TTL = 60_000;

const GRAMMAR_PATH = new URL("./grammar.json", import.meta.url).pathname;
let grammar = buildGrammar(GRAMMAR_PATH);

const reload = () => {
  grammar = buildGrammar(GRAMMAR_PATH);
  console.log(`grammar reloaded — ${grammar.candidates.length} phrases`);
};

startApi({
  port: process.env.API_PORT || 8788,
  token: process.env.API_TOKEN || TOKEN,
  onGrammarChange: reload,
});

const wss = new WebSocketServer({ port: PORT });
console.log(`voice link on :${PORT} — ${grammar.candidates.length} phrases`);

function wavHeader(len, rate = 16000) {
  const b = Buffer.alloc(44);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + len, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(len, 40);
  return b;
}

async function transcribe(pcm) {
  const f = path.join(os.tmpdir(), `${crypto.randomUUID()}.wav`);
  fs.writeFileSync(f, Buffer.concat([wavHeader(pcm.length), pcm]));
  try {
    const { stdout } = await run(WHISPER, [
      "-m", MODEL, "-f", f, "-nt", "-np", "-t", "4", "-l", "en", "--no-gpu",
    ]);
    return stdout.replace(/\[.*?\]/g, "").trim();
  } finally {
    fs.rmSync(f, { force: true });
  }
}

// Replace with real Hermes RPC. Must return { ok, speak }.
async function dispatch(handler, slots) {
  console.log("dispatch", handler, slots);
  return { ok: true, speak: `Done. ${handler.split(".")[1]} complete.` };
}

// Replace with your TTS. Return Buffer of playable audio, or null for text-only.
async function synth(_text) {
  return null;
}

function logEvent(row) {
  console.log("rt_event", JSON.stringify(row));
  // TODO: insert into rt_events with hash-chain
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  if (TOKEN && url.searchParams.get("token") !== TOKEN) {
    ws.close(4001, "bad token");
    return;
  }
  const device = url.searchParams.get("device") || "unknown";

  let chunks = [];
  let capturing = false;
  let pending = null;

  const send = (t, p = {}) => ws.readyState === 1 && ws.send(JSON.stringify({ t, ...p }));
  const state = (color, label) => send("state", { id: crypto.randomUUID(), color, label });

  const speak = async (text) => {
    send("say", { id: crypto.randomUUID(), text });
    const audio = await synth(text);
    if (audio && ws.readyState === 1) ws.send(audio);
  };

  const hb = setInterval(() => send("ping"), 15000);

  ws.on("message", async (data, isBinary) => {
    if (isBinary) {
      if (capturing && chunks.length < 1500) chunks.push(data);
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.t === "hello") { state("green"); return; }
    if (msg.t === "pong" || msg.t === "ack") return;

    if (msg.t === "wake") {
      chunks = [];
      capturing = true;
      return;
    }

    if (msg.t === "cancel") {
      capturing = false;
      chunks = [];
      pending = null;
      state("green");
      return;
    }

    if (msg.t !== "eos") return;

    capturing = false;
    const pcm = Buffer.concat(chunks);
    chunks = [];
    if (pcm.length < 8000) { state("green"); return; }

    state("orange", "listening");

    let transcript = "";
    try {
      transcript = await transcribe(pcm);
    } catch (e) {
      console.error("asr", e.message);
      state("red", "asr failed");
      return;
    }

    if (pending && Date.now() > pending.expires) pending = null;

    // Approval turn: nothing but confirm/cancel is accepted.
    if (pending) {
      const c = matchConfirmation(transcript, grammar);
      logEvent({ device, transcript, phase: "confirm", result: c });
      if (!c.ok) {
        recordMiss({ device, transcript, phase: "confirm", score: c.score, near: null });
        send("reject", { reason: "expected_confirmation" });
        state("blue", "awaiting approval");
        return;
      }
      if (c.kind === "cancel") {
        pending = null;
        await speak("Cancelled.");
        state("green");
        return;
      }
      const job = pending;
      pending = null;
      state("orange", job.intent);
      const r = await dispatch(job.handler, job.slots);
      await speak(r.speak);
      state(r.ok ? "green" : "red", job.intent);
      return;
    }

    const m = match(transcript, grammar);
    logEvent({ device, transcript, phase: "intent", result: m });

    if (!m.ok) {
      recordMiss({ device, transcript, phase: "intent", score: m.score, near: m.near });
      send("reject", { reason: "no_match" });
      await speak("I didn't catch a known command.");
      state("green");
      return;
    }

    if (m.gated) {
      pending = { ...m, expires: Date.now() + APPROVAL_TTL };
      const what = Object.values(m.slots).join(" ") || m.intent;
      state("blue", m.intent);
      await speak(`Confirm ${m.intent.replace("_", " ")} ${what}?`);
      send("listen", { on: true });
      return;
    }

    state("orange", m.intent);
    const r = await dispatch(m.handler, m.slots);
    await speak(r.speak);
    state(r.ok ? "green" : "red", m.intent);
  });

  ws.on("close", () => clearInterval(hb));
});

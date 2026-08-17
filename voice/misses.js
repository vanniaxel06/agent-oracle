import fs from "fs";
import path from "path";
import crypto from "crypto";

const FILE = process.env.MISS_LOG || "./misses.jsonl";

function readAll() {
  if (!fs.existsSync(FILE)) return [];
  return fs
    .readFileSync(FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function writeAll(rows) {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.renameSync(tmp, path.resolve(FILE));
}

export function recordMiss({ device, transcript, near, score, phase }) {
  if (!transcript?.trim()) return null;
  const rows = readAll();
  const norm = transcript.toLowerCase().trim();
  const dupe = rows.find((r) => r.norm === norm && r.status === "open");
  if (dupe) {
    dupe.count += 1;
    dupe.last_seen = Date.now();
    writeAll(rows);
    return dupe;
  }
  const row = {
    id: crypto.randomUUID(),
    device,
    transcript: transcript.trim(),
    norm,
    phase,
    score: Number((score || 0).toFixed(3)),
    near_intent: near?.intent || null,
    near_text: near?.text || null,
    near_slots: near?.slots || {},
    count: 1,
    first_seen: Date.now(),
    last_seen: Date.now(),
    status: "open",
  };
  rows.push(row);
  writeAll(rows);
  return row;
}

export function listMisses(status = "open") {
  return readAll()
    .filter((r) => status === "all" || r.status === status)
    .sort((a, b) => b.count - a.count || b.last_seen - a.last_seen);
}

export function resolveMiss(id, status, note) {
  const rows = readAll();
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  row.status = status;
  row.resolved_at = Date.now();
  if (note) row.note = note;
  writeAll(rows);
  return row;
}

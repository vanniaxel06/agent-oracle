import { useState, useEffect, useMemo, useCallback } from "react";
import { Plus, X, Check, Download, Shield, ShieldOff, RotateCcw, Wifi, WifiOff, Trash2, Inbox, Settings } from "lucide-react";

const SEED = {
  version: "0.1",
  min_score: 0.75,
  slots: {
    agent: {
      hermes: ["hermes", "her mess", "air mess"],
      vega: ["vega", "vegas", "veiga"],
      motoko: ["motoko", "moto ko", "mokoto"],
      prometheus: ["prometheus", "prometeus"],
    },
    asset: {
      bitcoin: ["bitcoin", "bit coin", "btc"],
      ethereum: ["ethereum", "etherium", "eth"],
      stellar: ["stellar", "stella", "xlm"],
      sui: ["sui", "swee", "sooey"],
    },
  },
  intents: [
    { id: "status", gated: false, handler: "hermes.status", patterns: ["status", "{agent} status", "how is {agent}", "check {agent}"] },
    { id: "pending", gated: false, handler: "hermes.pendingApprovals", patterns: ["what's pending", "anything waiting"] },
    { id: "positions", gated: false, handler: "vega.positions", patterns: ["open positions", "what are we holding"] },
    { id: "close_position", gated: true, handler: "vega.closePosition", patterns: ["close {asset}", "exit {asset}"] },
    { id: "pause_agent", gated: true, handler: "hermes.pauseAgent", patterns: ["pause {agent}", "halt {agent}"] },
  ],
};

const DEMO_MISSES = [
  { id: "d1", transcript: "poz vega", count: 4, score: 0.56, near_intent: "pause_agent", near_text: "pause vega", near_slots: { agent: "vega" }, phase: "intent" },
  { id: "d2", transcript: "close stellaire", count: 3, score: 0.64, near_intent: "close_position", near_text: "close stellar", near_slots: { asset: "stellar" }, phase: "intent" },
  { id: "d3", transcript: "how iz motoko", count: 2, score: 0.66, near_intent: "status", near_text: "how is motoko", near_slots: { agent: "motoko" }, phase: "intent" },
  { id: "d4", transcript: "wat is pendinne", count: 2, score: 0.61, near_intent: "pending", near_text: "what's pending", near_slots: {}, phase: "intent" },
  { id: "d5", transcript: "play some music", count: 1, score: 0, near_intent: null, near_text: null, near_slots: {}, phase: "intent" },
];

const STOP = new Set(["the","a","an","is","are","it","s","to","of","we","i","me","my","and","whats","what","how","do","did","does","be","on","for","that","this","up","now","please","um","uh","er","ah","ok","okay","just","can","you","some","like","well","hey","right","there","was","got"]);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const sim = (a, b) => { const m = Math.max(a.length, b.length); return m === 0 ? 1 : 1 - lev(a, b) / m; };
const content = (s) => new Set(norm(s).split(" ").filter((w) => w && !STOP.has(w)));

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const w of a) for (const v of b) if (w === v || sim(w, v) >= 0.85) { hit++; break; }
  return hit / Math.max(a.size, b.size);
}

function expand(pattern, slots) {
  const m = pattern.match(/\{(\w+)\}/);
  if (!m) return [{ text: pattern, slots: {} }];
  const [token, name] = m;
  const out = [];
  for (const [canon, aliases] of Object.entries(slots[name] || {})) {
    for (const alias of (aliases.length ? aliases : [canon])) {
      for (const r of expand(pattern.replace(token, alias), slots)) out.push({ text: r.text, slots: { ...r.slots, [name]: canon } });
    }
  }
  return out;
}

function build(g) {
  const c = [];
  for (const i of g.intents) for (const p of i.patterns) for (const e of expand(p, g.slots))
    c.push({ intent: i.id, gated: i.gated, slots: e.slots, text: norm(e.text) });
  return c;
}

function match(input, candidates, minScore) {
  const q = norm(input), qc = content(q);
  let top = null;
  for (const c of candidates) {
    const ov = overlap(qc, content(c.text));
    if (ov === 0) continue;
    const score = 0.4 * sim(q, c.text) + 0.6 * ov;
    if (!top || score > top.score) top = { ...c, score };
  }
  if (!top || top.score < minScore) return { ok: false, score: top?.score ?? 0, near: top };
  return { ok: true, ...top };
}

function oddTokens(transcript, candidates) {
  const known = new Set(candidates.flatMap((c) => c.text.split(" ")));
  return norm(transcript).split(" ").filter((w) => w && !STOP.has(w) && !known.has(w));
}

const G_KEY = "oracle:grammar:v2";
const C_KEY = "oracle:conn:v2";

export default function GrammarStudio() {
  const [g, setG] = useState(SEED);
  const [misses, setMisses] = useState(DEMO_MISSES);
  const [conn, setConn] = useState({ base: "", token: "" });
  const [online, setOnline] = useState(false);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("queue");
  const [pick, setPick] = useState({});
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState("");

  useEffect(() => {
    (async () => {
      try { const r = await window.storage.get(G_KEY); if (r?.value) setG(JSON.parse(r.value)); } catch { /* first run */ }
      try { const r = await window.storage.get(C_KEY); if (r?.value) setConn(JSON.parse(r.value)); } catch { /* first run */ }
      setReady(true);
    })();
  }, []);

  const candidates = useMemo(() => build(g), [g]);

  const api = useCallback(async (path, opts = {}) => {
    if (!conn.base) throw new Error("offline");
    const r = await fetch(conn.base.replace(/\/$/, "") + path, {
      ...opts,
      headers: { "content-type": "application/json", ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}) },
    });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }, [conn]);

  const pull = useCallback(async () => {
    if (!conn.base) { setOnline(false); return; }
    setBusy(true);
    try {
      const [m, gr] = await Promise.all([api("/misses"), api("/grammar")]);
      setMisses(m.misses || []);
      if (gr?.intents) setG(gr);
      setOnline(true);
    } catch {
      setOnline(false);
    }
    setBusy(false);
  }, [api, conn.base]);

  useEffect(() => { if (ready && conn.base) pull(); }, [ready, conn.base, pull]);

  const persist = useCallback(async (next) => {
    setG(next);
    try { await window.storage.set(G_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    if (conn.base) {
      try { await api("/grammar", { method: "PUT", body: JSON.stringify(next) }); } catch { /* stays local */ }
    }
  }, [api, conn.base]);

  const resolve = async (id, status) => {
    setMisses((m) => m.filter((x) => x.id !== id));
    if (conn.base) { try { await api(`/misses/${id}`, { method: "POST", body: JSON.stringify({ status }) }); } catch { /* ignore */ } }
  };

  const mapAlias = async (miss, slot, canon, word) => {
    const next = structuredClone(g);
    if (!next.slots[slot]?.[canon]) return;
    if (!next.slots[slot][canon].includes(word)) next.slots[slot][canon].push(word);
    await persist(next);
    await resolve(miss.id, "mapped");
  };

  const addAsPattern = async (miss) => {
    if (!miss.near_intent) return;
    const next = structuredClone(g);
    const intent = next.intents.find((i) => i.id === miss.near_intent);
    if (!intent) return;
    let text = norm(miss.transcript);
    for (const [slot, canon] of Object.entries(miss.near_slots || {})) {
      for (const alias of next.slots[slot]?.[canon] || []) {
        if (text.includes(alias)) { text = text.replace(alias, `{${slot}}`); break; }
      }
    }
    if (!intent.patterns.includes(text)) intent.patterns.push(text);
    await persist(next);
    await resolve(miss.id, "mapped");
  };

  const download = () => {
    const b = new Blob([JSON.stringify(g, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = "grammar.json";
    a.click();
  };

  const saveConn = async (next) => {
    setConn(next);
    try { await window.storage.set(C_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  if (!ready) return <div className="min-h-screen bg-neutral-950 text-neutral-600 flex items-center justify-center text-sm font-mono">loading…</div>;

  const probeResult = probe ? match(probe, candidates, g.min_score) : null;

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200 font-mono text-sm pb-16">
      <div className="border-b border-neutral-800 px-4 py-3 flex items-center justify-between sticky top-0 bg-neutral-950 z-10">
        <div>
          <div className="text-neutral-100">grammar studio</div>
          <div className="text-[10px] text-neutral-600 flex items-center gap-1.5">
            {online ? <Wifi size={10} className="text-emerald-500" /> : <WifiOff size={10} className="text-neutral-700" />}
            {online ? "live" : "local"} · {candidates.length} phrases
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={pull} disabled={busy} className="p-2 border border-neutral-800 rounded hover:border-neutral-600 disabled:opacity-40">
            <RotateCcw size={14} className={busy ? "animate-spin" : ""} />
          </button>
          <button onClick={download} className="p-2 border border-neutral-800 rounded hover:border-neutral-600">
            <Download size={14} />
          </button>
        </div>
      </div>

      <div className="flex border-b border-neutral-800 text-xs">
        {[["queue", Inbox], ["aliases", null], ["intents", null], ["setup", Settings]].map(([t, Icon]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex-1 py-3 flex items-center justify-center gap-1.5 ${tab === t ? "text-neutral-100 border-b-2 border-neutral-100" : "text-neutral-600"}`}>
            {Icon && <Icon size={12} />}{t}
            {t === "queue" && misses.length > 0 && (
              <span className="text-[9px] px-1.5 py-0.5 bg-red-950 text-red-400 rounded-full border border-red-900">{misses.length}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "queue" && (
        <div className="p-4 space-y-3">
          {!online && (
            <div className="text-[10px] text-neutral-600 border border-neutral-800 rounded p-2">
              showing sample misses — connect the VPS in setup to triage real ones
            </div>
          )}
          {misses.length === 0 && (
            <div className="text-center py-16 text-neutral-700 text-xs">queue clear</div>
          )}
          {misses.map((m) => {
            const odd = oddTokens(m.transcript, candidates);
            const slotEntries = Object.entries(m.near_slots || {});
            const key = pick[m.id] || odd[0] || "";
            return (
              <div key={m.id} className="border border-neutral-800 rounded overflow-hidden">
                <div className="p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-neutral-100">{m.transcript}</div>
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 bg-neutral-900 border border-neutral-800 rounded text-neutral-500">
                      {m.count}×
                    </span>
                  </div>
                  <div className="text-[10px] text-neutral-600">
                    {m.near_intent
                      ? <>closest <span className="text-neutral-400">{m.near_text}</span> → {m.near_intent} · {Math.round(m.score * 100)}%</>
                      : <>no near match</>}
                  </div>

                  {odd.length > 1 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {odd.map((w) => (
                        <button key={w} onClick={() => setPick((p) => ({ ...p, [m.id]: w }))}
                          className={`text-[10px] px-2 py-1 rounded border ${key === w ? "border-neutral-500 bg-neutral-800 text-neutral-100" : "border-neutral-800 text-neutral-500"}`}>
                          {w}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-t border-neutral-800 divide-y divide-neutral-800">
                  {slotEntries.map(([slot, canon]) => (
                    <button key={slot} disabled={!key} onClick={() => mapAlias(m, slot, canon, key)}
                      className="w-full px-3 py-2.5 text-left text-xs flex items-center gap-2 hover:bg-neutral-900 disabled:opacity-30">
                      <Plus size={12} className="text-emerald-500 shrink-0" />
                      <span className="text-neutral-400">
                        map <span className="text-neutral-100">{key || "—"}</span> → {slot}:{canon}
                      </span>
                    </button>
                  ))}
                  {m.near_intent && (
                    <button onClick={() => addAsPattern(m)}
                      className="w-full px-3 py-2.5 text-left text-xs flex items-center gap-2 hover:bg-neutral-900">
                      <Check size={12} className="text-blue-400 shrink-0" />
                      <span className="text-neutral-400">add whole phrase to <span className="text-neutral-100">{m.near_intent}</span></span>
                    </button>
                  )}
                  <button onClick={() => resolve(m.id, "discarded")}
                    className="w-full px-3 py-2.5 text-left text-xs flex items-center gap-2 hover:bg-neutral-900 text-neutral-600">
                    <Trash2 size={12} className="shrink-0" /> not a command
                  </button>
                </div>
              </div>
            );
          })}

          <div className="pt-4 space-y-2">
            <div className="text-[10px] text-neutral-600">spot check</div>
            <input value={probe} onChange={(e) => setProbe(e.target.value)}
              placeholder="type a transcript…"
              className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2.5 outline-none focus:border-neutral-600" />
            {probeResult && (
              <div className={`text-xs px-3 py-2 rounded border ${probeResult.ok ? "border-emerald-900 bg-emerald-950/40 text-emerald-400" : "border-red-900 bg-red-950/40 text-red-400"}`}>
                {probeResult.ok
                  ? <>{probeResult.intent}{probeResult.gated ? " · gated" : ""} {Object.entries(probeResult.slots).map(([k, v]) => `${k}=${v}`).join(" ")}</>
                  : <>no match · {Math.round(probeResult.score * 100)}%</>}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "aliases" && (
        <div className="p-4 space-y-5">
          {Object.entries(g.slots).map(([slot, values]) => (
            <div key={slot} className="space-y-2">
              <div className="text-[10px] text-neutral-600 uppercase tracking-widest">{slot}</div>
              {Object.entries(values).map(([canon, aliases]) => (
                <div key={canon} className="border border-neutral-800 rounded p-3 space-y-2">
                  <div className="text-neutral-200">{canon}</div>
                  <div className="flex flex-wrap gap-1">
                    {aliases.map((a) => (
                      <span key={a} className="text-[11px] pl-2 pr-1 py-1 bg-neutral-900 border border-neutral-800 rounded flex items-center gap-1">
                        {a}
                        {a !== canon && (
                          <button onClick={() => {
                            const n = structuredClone(g);
                            n.slots[slot][canon] = n.slots[slot][canon].filter((x) => x !== a);
                            persist(n);
                          }} className="text-neutral-600 hover:text-red-400"><X size={11} /></button>
                        )}
                      </span>
                    ))}
                  </div>
                  <input placeholder="misheard as… ⏎"
                    onKeyDown={(e) => {
                      if (e.key !== "Enter") return;
                      const v = norm(e.target.value);
                      if (!v || aliases.includes(v)) return;
                      const n = structuredClone(g);
                      n.slots[slot][canon].push(v);
                      persist(n);
                      e.target.value = "";
                    }}
                    className="w-full bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-xs outline-none focus:border-neutral-600" />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {tab === "intents" && (
        <div className="p-4 space-y-3">
          {g.intents.map((i) => (
            <div key={i.id} className="border border-neutral-800 rounded p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-neutral-200">{i.id}</div>
                  <div className="text-[10px] text-neutral-600">{i.handler}</div>
                </div>
                <button onClick={() => {
                  const n = structuredClone(g);
                  n.intents.find((x) => x.id === i.id).gated = !i.gated;
                  persist(n);
                }} className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded border ${i.gated ? "border-blue-900 bg-blue-950 text-blue-400" : "border-neutral-800 text-neutral-600"}`}>
                  {i.gated ? <Shield size={11} /> : <ShieldOff size={11} />}{i.gated ? "gated" : "one-shot"}
                </button>
              </div>
              <div className="space-y-1">
                {i.patterns.map((p) => (
                  <div key={p} className="flex items-center justify-between bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5">
                    <span className="text-xs text-neutral-400">{p}</span>
                    <button onClick={() => {
                      const n = structuredClone(g);
                      const t = n.intents.find((x) => x.id === i.id);
                      t.patterns = t.patterns.filter((x) => x !== p);
                      persist(n);
                    }} className="text-neutral-700 hover:text-red-400"><X size={12} /></button>
                  </div>
                ))}
              </div>
              <input placeholder="new pattern, {agent} for slots ⏎"
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !e.target.value.trim()) return;
                  const n = structuredClone(g);
                  const t = n.intents.find((x) => x.id === i.id);
                  if (!t.patterns.includes(e.target.value.trim())) t.patterns.push(e.target.value.trim());
                  persist(n);
                  e.target.value = "";
                }}
                className="w-full bg-neutral-900 border border-neutral-800 rounded px-2 py-1.5 text-xs outline-none focus:border-neutral-600" />
            </div>
          ))}
        </div>
      )}

      {tab === "setup" && (
        <div className="p-4 space-y-5">
          <div className="space-y-2">
            <div className="text-[10px] text-neutral-600 uppercase tracking-widest">triage api</div>
            <input value={conn.base} onChange={(e) => saveConn({ ...conn, base: e.target.value })}
              placeholder="http://your-vps:8788"
              className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2.5 outline-none focus:border-neutral-600" />
            <input value={conn.token} onChange={(e) => saveConn({ ...conn, token: e.target.value })}
              placeholder="API_TOKEN" type="password"
              className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2.5 outline-none focus:border-neutral-600" />
            <button onClick={pull} className="w-full py-2.5 border border-neutral-700 rounded text-xs hover:bg-neutral-900">
              connect
            </button>
            <div className="text-[10px] text-neutral-700 leading-relaxed">
              needs https if this page is served over https. edits save locally first, then push to the server.
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-[10px] text-neutral-600 uppercase tracking-widest">min score {g.min_score}</div>
            <input type="range" min="0.5" max="0.95" step="0.01" value={g.min_score}
              onChange={(e) => persist({ ...g, min_score: Number(e.target.value) })}
              className="w-full accent-neutral-400" />
            <div className="text-[10px] text-neutral-700">lower catches more accented speech, raises false positives</div>
          </div>

          <button onClick={() => persist(SEED)}
            className="w-full py-2.5 border border-neutral-800 rounded text-xs text-neutral-600 hover:border-neutral-700">
            reset grammar to seed
          </button>
        </div>
      )}
    </div>
  );
}

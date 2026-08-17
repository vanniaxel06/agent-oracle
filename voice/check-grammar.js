// Exercises the validation that stops a bad grammar reaching disk.
// Run with `npm run check`. No dependencies, no server, no audio.
import { validateGrammar, buildGrammar } from "./matcher.js";
import fs from "fs";

const base = JSON.parse(fs.readFileSync("./grammar.example.json", "utf8"));
const clone = () => structuredClone(base);

let failed = 0;
const check = (name, got, want) => {
  const ok = want(got);
  if (!ok) failed++;
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        got: ${JSON.stringify(got)}`);
};

console.log("\nvalidateGrammar\n");

check("the example grammar is valid", validateGrammar(base), (p) => p.length === 0);

// The exact shape the studio used to PUT: no confirmations, gated intents present.
const noConf = clone();
delete noConf.confirmations;
check(
  "gated intents with no confirmations is rejected",
  validateGrammar(noConf),
  (p) => p.some((x) => x.includes("confirmations.confirm")) && p.some((x) => x.includes("confirmations.cancel"))
);

const emptyConf = clone();
emptyConf.confirmations = { confirm: [], cancel: ["no"] };
check("an empty confirm list is rejected", validateGrammar(emptyConf), (p) => p.length === 1);

// Not an error: with nothing gated there is nothing to approve.
const ungated = clone();
delete ungated.confirmations;
ungated.intents = ungated.intents.filter((i) => !i.gated);
check("no confirmations is fine when nothing is gated", validateGrammar(ungated), (p) => p.length === 0);

check("a non-object is rejected", validateGrammar(null), (p) => p.length === 1);
check("an array is rejected", validateGrammar([]), (p) => p.length === 1);

const noScore = clone();
delete noScore.min_score;
check("a missing min_score is rejected", validateGrammar(noScore), (p) => p.length === 1);

const badSlots = clone();
badSlots.slots = ["agent"];
check("slots as an array is rejected", validateGrammar(badSlots), (p) => p.length === 1);

console.log("\nbuildGrammar\n");

const g = buildGrammar("./grammar.example.json");
check("expands patterns into candidates", g.candidates.length, (n) => n > 0);
check("loads confirmation phrases", g.confirmations.length, (n) => n === 10);
check("carries min_score through", g.minScore, (v) => v === 0.75);

fs.writeFileSync("./.tmp-bad.json", JSON.stringify(noConf));
let threw = null;
try { buildGrammar("./.tmp-bad.json"); } catch (e) { threw = e.message; }
fs.rmSync("./.tmp-bad.json", { force: true });
check(
  "throws a diagnostic error rather than a TypeError",
  threw,
  (m) => typeof m === "string" && m.includes("invalid grammar") && m.includes("could never be approved")
);

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}\n`);
process.exit(failed === 0 ? 0 : 1);

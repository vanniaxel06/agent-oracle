import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrammar, validateGrammar, classifyTurn } from '../matcher.js';

// Every score asserted here was MEASURED against grammar.example.json
// (min_score 0.75, near_score default 0.45, 84 expanded candidates), not
// predicted. Where a bound is loose it is because the exact value is expected
// to move as the grammar grows; the CLASSIFICATION is the contract.

const g = buildGrammar(new URL('../grammar.example.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

test('grammar exposes both thresholds', () => {
  assert.equal(g.minScore, 0.75);
  assert.equal(g.nearScore, 0.45, 'default floor applies when the grammar omits near_score');
  assert.ok(g.nearScore < g.minScore);
});

test('a clean command is a command', () => {
  for (const t of ['close stellar', 'pause vega', 'what are we holding', 'status']) {
    assert.equal(classifyTurn(t, g).type, 'command', t);
  }
});

test('a slot alias still matches as a command', () => {
  // "stella" is a declared alias of stellar; mishearings the grammar already
  // knows about must not reach the miss queue at all.
  const c = classifyTurn('close stella', g);
  assert.equal(c.type, 'command');
  assert.equal(c.gated, true, 'close is a gated intent');
});

// THE POINT OF THE SPLIT, first half.
test('a misheard command lands in the failed-command band, not conversation', () => {
  const c = classifyTurn('paws veiga', g);
  assert.equal(c.type, 'failed_command');
  assert.equal(c.reason, 'near_miss');
  assert.ok(c.score >= g.nearScore && c.score < g.minScore,
    `expected the band, got ${c.score}`);
  assert.ok(c.near, 'a failed command must carry what it nearly matched, for triage');
});

// THE POINT OF THE SPLIT, second half. Without a floor these would have been
// filed as misheard commands purely for sharing one asset name, and the triage
// queue would fill with questions.
test('a question sharing one incidental word with an intent is conversation', () => {
  for (const t of [
    'what do you think about bitcoin as a long term hold',
    'can you tell me about stellar as an investment',
  ]) {
    const c = classifyTurn(t, g);
    assert.equal(c.type, 'conversation', t);
    assert.equal(c.reason, 'below_floor');
    assert.ok(c.score > 0 && c.score < g.nearScore,
      `${t} scored ${c.score}, which is not below the floor`);
  }
});

test('a question sharing nothing with any intent is conversation', () => {
  for (const t of ['is it going to rain tomorrow', 'remind me to call the accountant', 'how was your day']) {
    const c = classifyTurn(t, g);
    assert.equal(c.type, 'conversation', t);
    assert.equal(c.reason, 'no_near_match');
    assert.equal(c.near, null);
  }
});

// KNOWN HOLE, asserted so it is visible rather than assumed fixed.
//
// A badly mangled command shares no content word with any candidate, so it is
// indistinguishable from conversation by this heuristic and is forwarded to
// Hermes. This is the failure the spec calls the honest hard part, and a score
// floor cannot fix it — the signal is gone before the floor is consulted.
// Closing it needs phonetic matching or the real miss data, not a tuned number.
test('KNOWN LIMITATION: a badly mangled command still reads as conversation', () => {
  const c = classifyTurn('clothes teller', g);
  assert.equal(c.type, 'conversation');
  assert.equal(c.score, 0, 'no content-word overlap survives the mangling');
});

test('near_score at or above min_score is rejected at load', () => {
  const problems = validateGrammar({
    intents: [], slots: {}, min_score: 0.75, near_score: 0.75,
  });
  assert.ok(problems.some(p => /must be BELOW min_score/.test(p)),
    'an empty band would silently turn every misheard command into chat');
});

test('a non-numeric near_score is rejected', () => {
  const problems = validateGrammar({ intents: [], slots: {}, min_score: 0.75, near_score: 'low' });
  assert.ok(problems.some(p => /near_score must be a number/.test(p)));
});

test('omitting near_score is allowed', () => {
  const problems = validateGrammar({ intents: [], slots: {}, min_score: 0.75 });
  assert.ok(!problems.some(p => /near_score/.test(p)));
});

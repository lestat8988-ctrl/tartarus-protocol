'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const parity = require('./fixtures/phase2-parity.json');
const fallback = require('./fixtures/dialogue-fallback.json');
const coreEngine = require(path.join(ROOT, 'core', 'engine', 'ep1Engine.js'));
const timers = require(path.join(ROOT, 'core', 'engine', 'timers.js'));
const kills = require(path.join(ROOT, 'core', 'engine', 'kills.js'));
const { TartarusEngine } = require(path.join(ROOT, 'src', 'engine', 'TartarusEngine.js'));
const legacyEp1Handler = require(path.join(ROOT, 'api', 'ep1', '[op].js'));
const harness = require('./helpers/bot-harness.js');

const STARTED_AT = '2026-01-01T00:00:00.000Z';
const DEADLINE_AT = '2026-01-01T00:07:00.000Z';
const START = new Date(STARTED_AT);

function gameState(overrides = {}) {
  return {
    clues: [],
    pistol_holder: null,
    dead_roles: [],
    accuse_history: [],
    game_over: false,
    outcome: null,
    triggered_kill_marks: [],
    ...overrides
  };
}

function match(overrides = {}) {
  return {
    match_id: 'phase2-core-match',
    turn: 1,
    started_at: STARTED_AT,
    deadline_at: DEADLINE_AT,
    game_state: gameState(),
    hidden_host_role: 'engineer',
    events: [],
    ...overrides
  };
}

function command(action, target) {
  return { actor: 'captain', role: 'captain', action, target };
}

function nowAtRemaining(seconds) {
  return new Date(new Date(DEADLINE_AT).getTime() - seconds * 1000);
}

async function invokeLegacy(body) {
  let statusCode = null;
  let payload = null;
  const req = { method: 'POST', url: '/api/ep1/action', headers: {}, body };
  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return value;
    },
    end() {}
  };
  await legacyEp1Handler(req, res);
  return { statusCode, payload };
}

test.beforeEach((t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  harness.resetState();
});

test('Phase 2 parity fixture points at the approved Phase 1 checkpoint', () => {
  assert.equal(parity.checkpoint, 'd7d7f998b44b83ab1d1a61cf5d2814ad7c9f78ed');
  assert.deepEqual(Object.keys(parity.items).sort(), [
    'autoKill240',
    'autoKill60',
    'commandMutation',
    'directMathRandom',
    'directSuspect',
    'fallbackZeroWidth',
    'missingThreatTarget',
    'timerFloor'
  ]);
});

test('core preserves the current direct SUSPECT to OBSERVE conversion and input mutation', async () => {
  const input = command('SUSPECT', 'navigator');
  const result = await coreEngine.applyAction(match(), input, { now: START });
  assert.equal(input.action, 'OBSERVE');
  assert.equal(result.events[0].type, 'OBSERVE');
  assert.equal(parity.items.directSuspect.intended, 'UNKNOWN');
});

test('Telegram V1 and core agree on the direct SUSPECT to OBSERVE result', async () => {
  harness.seedMatch({ playerId: 'phase2-suspect' });
  const core = await coreEngine.applyAction(match(), command('SUSPECT', 'navigator'), { now: START });
  await harness.bot.processActionApi('phase2-suspect', 'SUSPECT', 'navigator', {
    locale: 'ko',
    now: START
  });
  const stored = await harness.matchStore.getMatch('phase1-match-phase2-suspect');
  const telegramRaw = stored.events.find((event) => event.type === 'OBSERVE');
  assert.equal(telegramRaw.type, core.events[0].type);
  assert.equal(telegramRaw.target, core.events[0].target);
});

test('auto-kill keeps the strict 240/239 boundary', () => {
  assert.equal(kills.checkAutoKill([], 'engineer', 240, []).shouldKill, false);
  assert.deepEqual(kills.checkAutoKill([], 'engineer', 239, []), {
    shouldKill: true,
    victimRole: 'doctor',
    mark: 240
  });
});

test('auto-kill keeps the strict 60/59 boundary after the earlier mark', () => {
  assert.equal(kills.checkAutoKill(['doctor'], 'engineer', 60, [240]).shouldKill, false);
  assert.deepEqual(kills.checkAutoKill(['doctor'], 'engineer', 59, [240]), {
    shouldKill: true,
    victimRole: 'navigator',
    mark: 60
  });
});

test('Telegram V1 and core agree on selected auto-kill state at 239 seconds', async () => {
  const at239 = nowAtRemaining(239);
  const core = await coreEngine.applyAction(match(), command('QUESTION', 'pilot'), { now: at239 });
  harness.seedMatch({ playerId: 'phase2-kill' });
  const telegram = await harness.bot.processActionApi('phase2-kill', 'question', 'pilot', {
    locale: 'ko',
    now: at239
  });
  assert.deepEqual(telegram.match_state.dead_roles, core.next_state.game_state.dead_roles);
  assert.deepEqual(
    telegram.match_state.triggered_kill_marks,
    core.next_state.game_state.triggered_kill_marks
  );
  assert.equal(telegram.game_over, core.game_over);
});

test('core and Telegram V1 expose the current missing-threat-target disagreement', async () => {
  const core = await coreEngine.applyAction(match(), command('THREATEN'), { now: START });
  const telegram = await harness.bot.processActionApi('phase2-threat', 'threaten', null, {
    locale: 'ko',
    now: START
  });
  assert.equal(core.ok, true);
  assert.equal(telegram.ok, false);
  assert.match(telegram.error, /target required/);
});

test('timer continues to floor to 419 one millisecond after start', () => {
  assert.equal(timers.computeDeadline(420, STARTED_AT, new Date(START.getTime() + 1)).remaining_sec, 419);
});

test('Telegram fallback summary remains the zero-width U+200B character', () => {
  assert.equal(fallback.ko.summary, '\u200b');
  assert.equal([...fallback.ko.summary].length, 1);
  assert.equal(fallback.ko.summary.codePointAt(0), 0x200b);
});

test('FIND_CLUE continues to consume the process-global Math.random', async () => {
  await coreEngine.applyAction(match(), command('FIND_CLUE'), { now: START });
  assert.equal(harness.calls.rngCalls, 1);
});

test('Telegram application owns turn advancement that core does not perform', async () => {
  const core = await coreEngine.applyAction(match(), command('TAKE_PISTOL'), { now: START });
  harness.seedMatch({ playerId: 'phase2-turn' });
  await harness.bot.processActionApi('phase2-turn', 'take_pistol', null, {
    locale: 'ko',
    now: START
  });
  const stored = await harness.matchStore.getMatch('phase1-match-phase2-turn');
  assert.equal(core.next_state.turn, 1);
  assert.equal(stored.turn, 2);
});

test('src engine replays identical seed and history reproducibly', () => {
  const history = [{ type: 'message', text: 'STATUS' }, { type: 'wait' }];
  const first = new TartarusEngine({ seed: 'phase2-seed' }).calculateNextState({ history });
  const second = new TartarusEngine({ seed: 'phase2-seed' }).calculateNextState({ history });
  assert.deepEqual(second, first);
});

test('src engine action shorthand equals replaying the expanded full history', () => {
  const engine = new TartarusEngine({ seed: 'phase2-action-seed' });
  const history = [{ type: 'message', text: 'ENGINE' }];
  const action = { type: 'wait' };
  assert.deepEqual(
    engine.calculateNextState({ history, action }),
    engine.calculateNextState({ history: [...history, action] })
  );
});

test('src engine is deterministic for a supplied serialized rngState', () => {
  const engine = new TartarusEngine({ seed: 'ignored-when-state-is-supplied' });
  const input = { history: [{ type: 'message', text: 'CCTV' }], rngState: 123456789 };
  assert.deepEqual(engine.calculateNextState(input), engine.calculateNextState(input));
});

test('src engine does not mutate caller history or action', () => {
  const history = [{ type: 'message', text: 'STATUS' }];
  const action = { type: 'wait' };
  const beforeHistory = structuredClone(history);
  const beforeAction = structuredClone(action);
  new TartarusEngine({ seed: 'phase2-purity' }).calculateNextState({ history, action });
  assert.deepEqual(history, beforeHistory);
  assert.deepEqual(action, beforeAction);
});

test('src engine exposes actualImposter before game over instead of projecting public state', () => {
  const result = new TartarusEngine({ seed: 'phase2-hidden' }).calculateNextState({
    history: [{ type: 'message', text: 'STATUS' }]
  });
  assert.equal(result.isGameOver, false);
  assert.equal(typeof result.actualImposter, 'string');
  assert.ok(result.actualImposter.length > 0);
});

test('legacy api action remains a non-terminal placeholder even for ACCUSE', async () => {
  const result = await invokeLegacy({
    match_id: 'phase2-legacy-accuse',
    turn: 1,
    actor: 'captain',
    role: 'captain',
    action: 'ACCUSE',
    target: 'engineer'
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.server_result.placeholder, true);
  assert.equal(result.payload.game_over, false);
  assert.equal(result.payload.outcome, null);
});

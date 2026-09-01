'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const baseline = require('./fixtures/baseline.json');
const engineFixture = require('./fixtures/engine-contract.json');
const nluCases = require('./fixtures/nlu-cases.json');
const telegramFixture = require('./fixtures/telegram-contract.json');
const fallbackFixture = require('./fixtures/dialogue-fallback.json');

const engine = require(path.join(ROOT, 'core', 'engine', 'ep1Engine.js'));
const timers = require(path.join(ROOT, 'core', 'engine', 'timers.js'));
const kills = require(path.join(ROOT, 'core', 'engine', 'kills.js'));
const winlose = require(path.join(ROOT, 'core', 'engine', 'winlose.js'));
const intentParser = require(path.join(ROOT, 'core', 'nlu', 'intentParser.js'));
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
    match_id: 'phase1-engine-match',
    turn: 1,
    started_at: STARTED_AT,
    deadline_at: DEADLINE_AT,
    game_state: gameState(),
    hidden_host_role: 'engineer',
    events: [],
    ...overrides
  };
}

function nowAtRemaining(remainingSec) {
  return new Date(new Date(DEADLINE_AT).getTime() - remainingSec * 1000);
}

function action(name, target) {
  return { actor: 'captain', role: 'captain', action: name, target };
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

async function withServer(run) {
  const server = harness.bot.createLocalApiServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    return await run(server);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(server, { method = 'GET', url = '/', body, headers = {} }) {
  const address = server.address();
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        method,
        path: url,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = raw;
          try { parsed = raw ? JSON.parse(raw) : null; } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test.beforeEach((t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  harness.resetState();
});

test('safety baseline records the approved telegram-v1 branch point', () => {
  assert.deepEqual(baseline, {
    branchPoint: 'telegram-v1',
    baselineCommit: '0f06d4f875373eaf26ab8c2c56d9836e0492f549',
    v2Branch: 'codex/tartarus-v2',
    productionAccessAllowed: false,
    externalAiAllowed: false,
    telegramPollingAllowed: false,
    protectedUntrackedFiles: [
      'erssejooDocuments바탕 화면Tartarus-Project',
      'telegram/miniapp/assets/yuna.mp4'
    ]
  });
});

// Priority A: core/engine actions and win/loss rules.
test('engine QUESTION returns only captain and target-role events', async () => {
  const input = action('question', 'doctor');
  const result = await engine.applyAction(match(), input, { now: START });
  assert.equal(result.summary, engineFixture.question.summary);
  assert.deepEqual(result.events.map((event) => event.type), engineFixture.question.eventTypes);
  assert.deepEqual(result.events.map((event) => event.role), engineFixture.question.eventRoles);
  assert.equal(result.next_state.game_state.game_over, false);
});

test('engine accuse_hint maps to the non-terminal SUSPECT sequence', async () => {
  const result = await engine.applyAction(match(), action('accuse_hint', 'navigator'), { now: START });
  assert.equal(result.summary, engineFixture.suspectViaAccuseHint.summary);
  assert.equal(result.events.length, engineFixture.suspectViaAccuseHint.eventCount);
  assert.deepEqual(result.events[0], engineFixture.suspectViaAccuseHint.firstEvent);
  assert.equal(result.game_over, undefined);
});

test('engine direct SUSPECT token currently normalizes to OBSERVE', async () => {
  const input = action('SUSPECT', 'navigator');
  const result = await engine.applyAction(match(), input, { now: START });
  assert.equal(input.action, 'OBSERVE');
  assert.equal(result.summary, engineFixture.directSuspectNormalization.summary);
  assert.deepEqual(result.events[0], engineFixture.directSuspectNormalization.event);
});

test('engine correct accusation ends in crew_win', async () => {
  const result = await engine.applyAction(match(), action('accuse', 'engineer'), { now: START });
  assert.equal(result.summary, engineFixture.accuseWin.summary);
  assert.equal(result.outcome, engineFixture.accuseWin.outcome);
  assert.equal(result.game_over, engineFixture.accuseWin.gameOver);
  assert.equal(result.next_state.game_state.game_over, true);
  assert.deepEqual(result.next_state.game_state.accuse_history, [
    { target: 'engineer', outcome: 'crew_win' }
  ]);
});

test('engine wrong accusation ends in accuse_failed', async () => {
  const result = await engine.applyAction(match(), action('accuse', 'doctor'), { now: START });
  assert.equal(result.summary, engineFixture.accuseFailure.summary);
  assert.equal(result.outcome, engineFixture.accuseFailure.outcome);
  assert.equal(result.game_over, engineFixture.accuseFailure.gameOver);
});

test('engine TAKE_PISTOL records captain as holder', async () => {
  const result = await engine.applyAction(match(), action('take_pistol'), { now: START });
  assert.equal(result.summary, engineFixture.takePistol.summary);
  assert.equal(result.next_state.game_state.pistol_holder, engineFixture.takePistol.holder);
  assert.deepEqual(result.events, [{ type: 'TAKE_PISTOL', role: 'captain' }]);
});

test('engine duplicate TAKE_PISTOL is a successful no-op with dialogue', async () => {
  const current = match({ game_state: gameState({ pistol_holder: 'captain' }) });
  const result = await engine.applyAction(current, action('take_pistol'), { now: START });
  assert.equal(result.next_state, current);
  assert.equal(result.summary, 'Captain already holds the pistol.');
  assert.equal(result.events[0].dialogue, '함장은 이미 권총을 소지하고 있다.');
});

test('engine FIND_CLUE uses injected RNG and stores the selected catalogue entry', async () => {
  const result = await engine.applyAction(match(), action('find_clue'), { now: START });
  assert.equal(result.summary, engineFixture.firstClue.summary);
  assert.deepEqual(result.next_state.game_state.clues, [{
    id: engineFixture.firstClue.id,
    text: engineFixture.firstClue.text,
    turn: 1,
    role: 'captain'
  }]);
  assert.equal(result.events[0].clue_id, engineFixture.firstClue.id);
  assert.equal(harness.calls.rngCalls, 1);
});

test('engine THREATEN without target returns its current successful validation response', async () => {
  const result = await engine.applyAction(match(), action('threaten'), { now: START });
  assert.equal(result.ok, true);
  assert.equal(result.summary, engineFixture.invalidThreat.summary);
  assert.equal(result.events[0].dialogue, engineFixture.invalidThreat.dialogue);
});

test('engine THREATEN against a dead target is a successful unavailable response', async () => {
  const current = match({ game_state: gameState({ dead_roles: ['doctor'] }) });
  const result = await engine.applyAction(current, action('threaten', 'doctor'), { now: START });
  assert.equal(result.ok, true);
  assert.equal(result.summary, 'Threat target unavailable.');
  assert.equal(result.next_state, current);
});

test('engine CHECK_LOG variation is determined by turn', async () => {
  const result = await engine.applyAction(match({ turn: 2 }), action('check_log', 'engineer'), { now: START });
  assert.equal(result.summary, 'Captain checked logs (engineer).');
  assert.equal(result.events[1].role, 'engineer');
  assert.match(result.events[1].dialogue, /교량 CCTV 버퍼/);
});

test('engine unknown action mutates the command to OBSERVE', async () => {
  const input = action('not-a-real-action', 'pilot');
  const result = await engine.applyAction(match(), input, { now: START });
  assert.equal(input.action, 'OBSERVE');
  assert.deepEqual(result.events, [{ type: 'OBSERVE', role: 'captain', target: 'pilot' }]);
  assert.equal(result.summary, 'Captain observed the bridge.');
});

test('winlose resolves timeout before a correct accusation', () => {
  assert.deepEqual(winlose.resolveOutcome({
    remainingSec: 0,
    accusedRole: 'engineer',
    impostorRole: 'engineer'
  }), { outcome: 'impostor_win', winner: 'impostor', loser_reason: 'timeout' });
});

test('winlose declares impostor win only when that role is the sole survivor', () => {
  assert.equal(winlose.isImpostorWin('engineer', ['doctor', 'navigator', 'pilot']), true);
  assert.equal(winlose.isImpostorWin('engineer', ['doctor', 'navigator']), false);
});

// Priority B: timer and auto-kill boundaries.
test('timer starts at the full 420 seconds', () => {
  const status = timers.computeDeadline(420, STARTED_AT, START);
  assert.equal(status.deadline_at.toISOString(), DEADLINE_AT);
  assert.equal(status.remaining_sec, 420);
});

test('timer floors fractional seconds immediately', () => {
  const status = timers.computeDeadline(420, STARTED_AT, new Date(START.getTime() + 1));
  assert.equal(status.remaining_sec, 419);
});

test('timer is expired at the exact deadline', () => {
  assert.equal(timers.computeDeadline(420, STARTED_AT, DEADLINE_AT).remaining_sec, 0);
  assert.equal(timers.isExpired(420, STARTED_AT, DEADLINE_AT), true);
});

test('auto-kill does not fire at exactly 240 remaining', () => {
  assert.deepEqual(kills.checkAutoKill([], 'engineer', 240, []), {
    shouldKill: false,
    victimRole: null,
    mark: null
  });
});

test('auto-kill fires just below 240 and chooses first eligible role', () => {
  assert.deepEqual(kills.checkAutoKill([], 'engineer', 239, []), {
    shouldKill: true,
    victimRole: 'doctor',
    mark: 240
  });
});

test('auto-kill does not fire at exactly 60 when 240 was handled', () => {
  assert.deepEqual(kills.checkAutoKill([], 'engineer', 60, [240]), {
    shouldKill: false,
    victimRole: null,
    mark: null
  });
});

test('auto-kill fires just below 60 when 240 was handled', () => {
  assert.deepEqual(kills.checkAutoKill(['doctor'], 'engineer', 59, [240]), {
    shouldKill: true,
    victimRole: 'navigator',
    mark: 60
  });
});

test('auto-kill catches the older 240 mark first when both boundaries were skipped', () => {
  assert.deepEqual(kills.checkAutoKill([], 'engineer', 59, []), {
    shouldKill: true,
    victimRole: 'doctor',
    mark: 240
  });
});

test('engine auto-kill preempts the requested action', async () => {
  const input = action('question', 'pilot');
  const result = await engine.applyAction(match(), input, { now: nowAtRemaining(239) });
  assert.equal(input.action, 'question');
  assert.equal(result.summary, '[AUTO KILL] doctor bio signal lost in Medical Bay.');
  assert.deepEqual(result.events, [{ type: 'DEATH', role: 'doctor', zone: 'Medical Bay', reason: 'auto_kill' }]);
  assert.deepEqual(result.next_state.game_state.triggered_kill_marks, [240]);
});

test('engine timeout preempts auto-kill and the requested action', async () => {
  const result = await engine.applyAction(match(), action('question', 'pilot'), { now: new Date(DEADLINE_AT) });
  assert.equal(result.summary, "Time's up. impostor_win.");
  assert.deepEqual(result.events, [{ type: 'TIMEOUT' }]);
  assert.equal(result.game_over, true);
  assert.equal(result.remaining_sec, 0);
});

test('already-ended match preempts even the timeout check', async () => {
  const ended = match({ game_state: gameState({ game_over: true, outcome: 'crew_win' }) });
  const result = await engine.applyAction(ended, action('question', 'pilot'), { now: new Date(DEADLINE_AT) });
  assert.equal(result.next_state, ended);
  assert.equal(result.summary, 'Game over. Outcome: crew_win');
  assert.equal(result.outcome, 'crew_win');
});

// Priority C: NLU intent parsing. Each fixture remains a separately reported test.
for (const fixture of nluCases) {
  test('NLU: ' + fixture.name, () => {
    assert.deepEqual(intentParser.parse(fixture.input), fixture.expected);
  });
}

// Priority D: Telegram application and HTTP API contracts.
test('Telegram start application response keeps the current key contract', async () => {
  harness.seedMatch({ playerId: 'start-contract' });
  const result = await harness.bot.getStartStateApi('start-contract', { locale: 'ko', now: harness.NOW });
  assert.deepEqual(sortedKeys(result), telegramFixture.startResponseKeys);
  assert.equal(result.ok, true);
  assert.equal(result.remaining_sec, 420);
  assert.equal('actual_imposter' in result, false);
});

test('Telegram action application response keeps the current key contract', async () => {
  harness.seedMatch({ playerId: 'action-contract' });
  const result = await harness.bot.processActionApi(
    'action-contract',
    'take_pistol',
    null,
    { locale: 'ko', now: harness.NOW }
  );
  assert.deepEqual(sortedKeys(result), telegramFixture.actionResponseKeys);
  assert.equal(result.match_state.pistol_holder, 'captain');
});

test('Telegram HTTP health contract', async () => {
  await withServer(async (server) => {
    const result = await request(server, { url: '/health' });
    assert.deepEqual(result, {
      status: telegramFixture.http.health.status,
      headers: result.headers,
      body: telegramFixture.http.health.body
    });
    assert.equal(result.headers['access-control-allow-origin'], '*');
  });
});

test('Telegram HTTP state requires playerId', async () => {
  await withServer(async (server) => {
    const result = await request(server, { url: '/api/state' });
    assert.equal(result.status, telegramFixture.http.missingStatePlayer.status);
    assert.deepEqual(result.body, telegramFixture.http.missingStatePlayer.body);
  });
});

test('Telegram HTTP message requires playerId', async () => {
  await withServer(async (server) => {
    const result = await request(server, { method: 'POST', url: '/api/message', body: { text: 'hello' } });
    assert.equal(result.status, telegramFixture.http.missingMessagePlayer.status);
    assert.deepEqual(result.body, telegramFixture.http.missingMessagePlayer.body);
  });
});

test('Telegram HTTP accuse requires target', async () => {
  await withServer(async (server) => {
    const result = await request(server, { method: 'POST', url: '/api/accuse', body: { playerId: 'p' } });
    assert.equal(result.status, telegramFixture.http.missingAccuseTarget.status);
    assert.deepEqual(result.body, telegramFixture.http.missingAccuseTarget.body);
  });
});

test('Telegram HTTP action requires action name', async () => {
  await withServer(async (server) => {
    const result = await request(server, { method: 'POST', url: '/api/action', body: { playerId: 'p' } });
    assert.equal(result.status, telegramFixture.http.missingAction.status);
    assert.deepEqual(result.body, telegramFixture.http.missingAction.body);
  });
});

test('Telegram HTTP OPTIONS reflects requested CORS headers', async () => {
  await withServer(async (server) => {
    const result = await request(server, {
      method: 'OPTIONS',
      url: '/api/action',
      headers: { Origin: 'https://phase1.invalid', 'Access-Control-Request-Headers': 'X-Phase1' }
    });
    assert.equal(result.status, 204);
    assert.equal(result.headers['access-control-allow-origin'], '*');
    assert.equal(result.headers['access-control-allow-headers'], 'X-Phase1');
  });
});

// Priority E: deterministic fallback with fake AI.
test('Telegram Korean dialogue falls back after three fake AI failures', async () => {
  harness.seedMatch({ playerId: 'fallback-ko' });
  const result = await harness.bot.processActionApi(
    'fallback-ko',
    'question',
    'doctor',
    { locale: 'ko', now: harness.NOW }
  );
  assert.equal(result.summary, fallbackFixture.ko.summary);
  assert.deepEqual(result.events.map((event) => event.type), fallbackFixture.ko.eventTypes);
  assert.equal(harness.calls.aiRequests, fallbackFixture.fakeAiAttempts);
  assert.equal(harness.calls.telegramConstructed, 0);
});

test('Telegram fallback is deterministic for identical seeded state', async () => {
  harness.seedMatch({ playerId: 'fallback-a' });
  const first = await harness.bot.processActionApi(
    'fallback-a', 'question', 'doctor', { locale: 'ko', now: harness.NOW }
  );
  harness.seedMatch({ playerId: 'fallback-b' });
  const second = await harness.bot.processActionApi(
    'fallback-b', 'question', 'doctor', { locale: 'ko', now: harness.NOW }
  );
  assert.deepEqual(second.events, first.events);
  assert.equal(second.summary, first.summary);
});

// Priority F: locale.
test('Telegram English question fallback preserves English contract', async () => {
  harness.seedMatch({ playerId: 'fallback-en', locale: 'en' });
  const result = await harness.bot.processActionApi(
    'fallback-en',
    'question',
    'doctor',
    { locale: 'en', now: harness.NOW }
  );
  assert.equal(result.summary, fallbackFixture.en.summary);
  assert.deepEqual(result.events.map((event) => event.type), fallbackFixture.en.eventTypes);
  assert.equal(result.match_state.locale, 'en');
});

test('Telegram action inherits English locale from existing match', async () => {
  harness.seedMatch({ playerId: 'session-locale-en', locale: 'en' });
  const result = await harness.bot.processActionApi(
    'session-locale-en',
    'question',
    'doctor',
    { now: harness.NOW }
  );
  assert.deepEqual(result.events.map((event) => event.type), fallbackFixture.en.eventTypes);
  assert.equal(result.match_state.locale, 'en');
});

test('Telegram start persists requested locale in game_state', async () => {
  harness.seedMatch({ playerId: 'start-locale', locale: 'ko' });
  const result = await harness.bot.getStartStateApi('start-locale', { locale: 'en', now: harness.NOW });
  assert.equal(result.game_state.locale, 'en');
  assert.deepEqual(
    result.events.map((event) => event.type),
    fallbackFixture.englishStartEventTypes
  );
});

// Priority G: entitlement.
test('entitlement user key preference is player, then session, then anonymous', () => {
  assert.equal(harness.bot.resolveUserKey('player-1', 'match-1'), 'player-1');
  assert.equal(harness.bot.resolveUserKey('', 'match-1'), 'session:match-1');
  assert.equal(harness.bot.resolveUserKey('', ''), 'anonymous');
});

test('Korean daily ticket exhaustion blocks new match before RNG or Telegram', async () => {
  const playerId = 'ticket-block-ko';
  await harness.bot.upsertUserEntitlement(playerId, {
    daily_ticket_limit: 0,
    daily_ticket_used: 0,
    daily_ticket_reset_at: new Date().toISOString()
  });
  const result = await harness.bot.getStartStateApi(playerId, { locale: 'ko', now: harness.NOW });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.block_reason, 'daily_ticket_limit_reached');
  assert.match(result.notice, /오늘의 입장권/);
  assert.equal(harness.playerStore._store.has(playerId), false);
  assert.equal(harness.calls.telegramConstructed, 0);
  assert.equal(harness.calls.rngCalls, 0);
});

test('English daily ticket exhaustion uses the English notice', async () => {
  const playerId = 'ticket-block-en';
  await harness.bot.upsertUserEntitlement(playerId, {
    daily_ticket_limit: 0,
    daily_ticket_used: 0,
    daily_ticket_reset_at: new Date().toISOString()
  });
  const result = await harness.bot.getStartStateApi(playerId, { locale: 'en', now: harness.NOW });
  assert.equal(result.block_reason, 'daily_ticket_limit_reached');
  assert.match(result.notice, /daily entry tickets/);
});

test('free-text prompt exhaustion blocks before AI generation', async () => {
  const playerId = 'prompt-block-ko';
  harness.seedMatch({ playerId });
  await harness.bot.upsertUserEntitlement(playerId, {
    daily_free_prompt_limit: 0,
    daily_free_prompt_used: 0,
    daily_free_prompt_reset_at: new Date().toISOString()
  });
  const result = await harness.bot.processMessageApi(
    playerId,
    '닥터, 그때 어디 있었어?',
    { locale: 'ko', now: harness.NOW }
  );
  assert.equal(result.ok, false);
  assert.equal(result.block_reason, 'daily_free_prompt_limit_reached');
  assert.match(result.notice, /자유입력 횟수/);
  assert.equal(harness.calls.aiRequests, 0);
});

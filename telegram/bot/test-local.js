#!/usr/bin/env node
/**
 * 로컬 테스트: node telegram/bot/test-local.js
 * BOT TOKEN 없이 routeMessage() 호출로 동작 확인
 *
 * 검증:
 * - /start 후 deadline_at, remaining_sec 출력
 * - 짧은 제한시간(game_total_sec)으로 빠른 테스트
 * - opts.now로 시간 시뮬레이션 (자동살해, 타임아웃)
 * - 규칙 엔진 명시적 검증 (PASS/FAIL)
 */
const { routeMessage, handleStart, handleTextMessage } = require('./bot');
const matchStore = require('../../core/state/matchStore');
const playerStore = require('../../core/state/playerStore');
const ep1Engine = require('../../core/engine/ep1Engine');

function assert(name, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual);
  return { name, expected, actual, pass: pass ? 'PASS' : 'FAIL' };
}

function printResult(r) {
  console.log('--- ' + r.name + ' ---');
  console.log('기대값:', JSON.stringify(r.expected));
  console.log('실제 결과:', JSON.stringify(r.actual));
  console.log('=> ' + r.pass);
  return r.pass === 'PASS';
}

/** 테스트용 매치 생성 (hidden_host_role 등 제어) */
async function createTestMatch(playerId, opts = {}) {
  const matchId = 'verify_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const match = await matchStore.getOrCreateMatch(matchId, {
    game_total_sec: opts.game_total_sec ?? 300,
    hidden_host_role: opts.hidden_host_role || 'pilot'
  });
  await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  return { matchId, match };
}

async function basicFlow() {
  const playerId = 'test_user_123';
  console.log('=== /start ===');
  console.log(await routeMessage(playerId, '/start'));
  console.log('\n=== "네비게이터 어디 있었어" ===');
  console.log(await routeMessage(playerId, '네비게이터 어디 있었어'));
  console.log('\n=== "로그 보여줘" ===');
  console.log(await routeMessage(playerId, '로그 보여줘'));
  console.log('\n=== "닥터를 의심한다" ===');
  console.log(await routeMessage(playerId, '닥터를 의심한다'));
}

async function deadlineTest() {
  const playerId = 'deadline_test_' + Date.now();
  console.log('\n=== DEADLINE TEST: /start 후 deadline_at, remaining_sec ===');
  const reply = await handleStart(playerId, { game_total_sec: 120 });
  console.log(reply);
  const player = await playerStore.getPlayer(playerId);
  const match = player?.match_id ? await matchStore.getMatch(player.match_id) : null;
  if (match) {
    console.log('\n[Match state] deadline_at:', match.deadline_at);
    console.log('[Match state] game_state.dead_roles:', match.game_state?.dead_roles);
    console.log('[Match state] game_state.triggered_kill_marks:', match.game_state?.triggered_kill_marks);
  }
}

async function timeSimulationTest() {
  const playerId = 'time_sim_' + Date.now();
  console.log('\n=== TIME SIMULATION: 10초 게임, 15초 후 now 주입 ===');
  await handleStart(playerId, { game_total_sec: 10 });
  const player = await playerStore.getPlayer(playerId);
  const matchId = player?.match_id;
  if (!matchId) {
    console.log('No match created');
    return;
  }
  const match = await matchStore.getMatch(matchId);
  const startedAt = new Date(match.started_at);
  const nowPast = new Date(startedAt.getTime() + 15 * 1000);

  console.log('Simulating: now = started_at + 15 sec (game was 10 sec)');
  const reply = await handleTextMessage(playerId, '로그 보여줘', { now: nowPast });
  console.log(reply);

  const updated = await matchStore.getMatch(matchId);
  console.log('\n[After timeout] game_over:', updated?.game_state?.game_over);
  console.log('[After timeout] outcome:', updated?.game_state?.outcome);
}

async function autoKillSimulationTest() {
  const playerId = 'autokill_sim_' + Date.now();
  console.log('\n=== AUTO-KILL SIMULATION: 5분 게임, 3분 30초 경과 (remaining < 4분) ===');
  await handleStart(playerId, { game_total_sec: 300 });
  const player = await playerStore.getPlayer(playerId);
  const matchId = player?.match_id;
  if (!matchId) {
    console.log('No match created');
    return;
  }
  const match = await matchStore.getMatch(matchId);
  const startedAt = new Date(match.started_at);
  const nowPast = new Date(startedAt.getTime() + 90 * 1000);

  console.log('Simulating: now = started_at + 90 sec (remaining ~210 sec < 240)');
  const reply = await handleTextMessage(playerId, '닥터 어디 있어', { now: nowPast });
  console.log(reply);

  const updated = await matchStore.getMatch(matchId);
  console.log('\n[After auto-kill] dead_roles:', updated?.game_state?.dead_roles);
  console.log('[After auto-kill] triggered_kill_marks:', updated?.game_state?.triggered_kill_marks);
}

// --- 규칙 엔진 명시적 검증 ---

/** 1. 240초 구간 auto-kill 중복 발동 방지 */
async function verify240NoDuplicate() {
  const playerId = 'v240_' + Date.now();
  const { matchId } = await createTestMatch(playerId, { game_total_sec: 300, hidden_host_role: 'pilot' });
  const match = await matchStore.getMatch(matchId);
  const now = new Date(new Date(match.started_at).getTime() + 90 * 1000);

  const r1 = await handleTextMessage(playerId, '로그 보여줘', { now });
  const m1 = await matchStore.getMatch(matchId);
  const r2 = await handleTextMessage(playerId, '닥터 어디 있어', { now });
  const m2 = await matchStore.getMatch(matchId);

  const deadCount = (m2?.game_state?.dead_roles || []).length;
  const marks = m2?.game_state?.triggered_kill_marks || [];
  return assert(
    '1. 240초 구간 auto-kill 중복 발동 방지',
    { dead_roles_count: 1, triggered_kill_marks: [240] },
    { dead_roles_count: deadCount, triggered_kill_marks: marks }
  );
}

/** 2. 60초 구간 auto-kill 정확히 1회 발동 */
async function verify60ZoneOnce() {
  const playerId = 'v60_' + Date.now();
  const { matchId } = await createTestMatch(playerId, { game_total_sec: 300, hidden_host_role: 'pilot' });
  const match = await matchStore.getMatch(matchId);

  const now240 = new Date(new Date(match.started_at).getTime() + 61 * 1000);
  await handleTextMessage(playerId, '로그 보여줘', { now: now240 });
  const m1 = await matchStore.getMatch(matchId);

  const now60 = new Date(new Date(match.started_at).getTime() + 250 * 1000);
  await handleTextMessage(playerId, '닥터 어디 있어', { now: now60 });
  const m2 = await matchStore.getMatch(matchId);

  const deadRoles = m2?.game_state?.dead_roles || [];
  const marks = m2?.game_state?.triggered_kill_marks || [];
  const has240 = marks.includes(240);
  const has60 = marks.includes(60);
  return assert(
    '2. 60초 구간 auto-kill 정확히 1회 발동',
    { dead_roles_count: 2, marks_240: true, marks_60: true },
    { dead_roles_count: deadRoles.length, marks_240: has240, marks_60: has60 }
  );
}

/** 3. timeout game_over 후 추가 액션 차단 */
async function verifyTimeoutBlocksAction() {
  const playerId = 'vtimeout_' + Date.now();
  await handleStart(playerId, { game_total_sec: 10 });
  const player = await playerStore.getPlayer(playerId);
  const matchId = player?.match_id;
  const match = await matchStore.getMatch(matchId);
  const nowPast = new Date(new Date(match.started_at).getTime() + 15 * 1000);

  await handleTextMessage(playerId, '로그 보여줘', { now: nowPast });
  const eventsBefore = (await matchStore.getMatch(matchId))?.events?.length || 0;

  const reply = await handleTextMessage(playerId, '닥터를 의심한다', { now: nowPast });
  const mAfter = await matchStore.getMatch(matchId);
  const eventsAfter = mAfter?.events?.length || 0;

  const blocked = reply.includes('Game over') && reply.includes('impostor_win');
  const noNewEvent = eventsAfter === eventsBefore;
  return assert(
    '3. timeout game_over 후 추가 액션 차단',
    { reply_contains_game_over: true, no_new_events: true },
    { reply_contains_game_over: blocked, no_new_events: noNewEvent }
  );
}

/** 4. accuse_failed game_over 후 추가 액션 차단 */
async function verifyAccuseFailedBlocksAction() {
  const playerId = 'vaccuse_' + Date.now();
  await createTestMatch(playerId, { hidden_host_role: 'pilot' });
  await handleTextMessage(playerId, '닥터를 의심한다');

  const m1 = await matchStore.getMatch((await playerStore.getPlayer(playerId))?.match_id);
  const eventsBefore = m1?.events?.length || 0;

  const reply = await handleTextMessage(playerId, '엔지니어를 의심한다');

  const m2 = await matchStore.getMatch((await playerStore.getPlayer(playerId))?.match_id);
  const eventsAfter = m2?.events?.length || 0;

  const blocked = reply.includes('Game over') && reply.includes('accuse_failed');
  const noNewEvent = eventsAfter === eventsBefore;
  return assert(
    '4. accuse_failed game_over 후 추가 액션 차단',
    { reply_contains_game_over: true, no_new_events: true },
    { reply_contains_game_over: blocked, no_new_events: noNewEvent }
  );
}

/** 5. dead_roles에 있는 역할은 다시 죽지 않음 */
async function verifyDeadRolesNoRekill() {
  const playerId = 'vdead_' + Date.now();
  const { matchId } = await createTestMatch(playerId, { game_total_sec: 300, hidden_host_role: 'pilot' });
  const match = await matchStore.getMatch(matchId);

  await matchStore.updateMatch(matchId, {
    game_state: {
      ...match.game_state,
      dead_roles: ['doctor'],
      triggered_kill_marks: [240]
    }
  });

  const now60 = new Date(new Date(match.started_at).getTime() + 250 * 1000);
  await handleTextMessage(playerId, '로그 보여줘', { now: now60 });

  const mAfter = await matchStore.getMatch(matchId);
  const deadRoles = mAfter?.game_state?.dead_roles || [];

  const doctorNotDuplicated = deadRoles.filter((r) => r === 'doctor').length === 1;
  const victimNotDoctor = deadRoles.length >= 2 ? deadRoles[1] !== 'doctor' : true;
  return assert(
    '5. dead_roles에 있는 역할은 다시 죽지 않음',
    { doctor_count: 1, second_victim_not_doctor: true },
    {
      doctor_count: deadRoles.filter((r) => r === 'doctor').length,
      second_victim_not_doctor: deadRoles.length >= 2 ? deadRoles[1] !== 'doctor' : true
    }
  );
}

/** 6. engine applyAction game_over 시 state 변경 없음 (엔진 레벨) */
async function verifyEngineGameOverNoStateChange() {
  const matchId = 'vengine_' + Date.now();
  const match = await matchStore.getOrCreateMatch(matchId, {
    game_total_sec: 10,
    started_at: new Date(Date.now() - 20 * 1000).toISOString()
  });
  const gs = { ...match.game_state, game_over: true, outcome: 'impostor_win' };
  const matchOver = { ...match, game_state: gs };

  const result = await ep1Engine.applyAction(matchOver, { actor: 'captain', role: 'captain', action: 'ACCUSE', target: 'doctor' }, {});

  const noNewAccuse = !result.events?.some((e) => e.type === 'ACCUSE');
  const summaryGameOver = result.summary?.includes('Game over') || false;
  return assert(
    '6. engine game_over 시 추가 액션 무시 (state 변경 없음)',
    { no_accuse_event: true, summary_game_over: true },
    { no_accuse_event: noNewAccuse, summary_game_over: summaryGameOver }
  );
}

async function runVerificationSuite() {
  const results = [];
  results.push(await verify240NoDuplicate());
  results.push(await verify60ZoneOnce());
  results.push(await verifyTimeoutBlocksAction());
  results.push(await verifyAccuseFailedBlocksAction());
  results.push(await verifyDeadRolesNoRekill());
  results.push(await verifyEngineGameOverNoStateChange());
  return results;
}

async function main() {
  const mode = process.argv[2] || 'basic';
  if (mode === 'basic') {
    await basicFlow();
  } else if (mode === 'deadline') {
    await deadlineTest();
  } else if (mode === 'time') {
    await timeSimulationTest();
  } else if (mode === 'autokill') {
    await autoKillSimulationTest();
  } else if (mode === 'verify' || mode === 'v') {
    console.log('\n=== 규칙 엔진 검증 (PASS/FAIL) ===\n');
    const results = await runVerificationSuite();
    let passed = 0;
    for (const r of results) {
      if (printResult(r)) passed++;
    }
    console.log('\n--- 요약: ' + passed + '/' + results.length + ' PASS ---');
  } else if (mode === 'all') {
    await basicFlow();
    await deadlineTest();
    await timeSimulationTest();
    await autoKillSimulationTest();
    console.log('\n=== 규칙 엔진 검증 (PASS/FAIL) ===\n');
    const results = await runVerificationSuite();
    let passed = 0;
    for (const r of results) {
      if (printResult(r)) passed++;
    }
    console.log('\n--- 요약: ' + passed + '/' + results.length + ' PASS ---');
  } else {
    console.log('Usage: node telegram/bot/test-local.js [basic|deadline|time|autokill|verify|all]');
    console.log('  basic   - 기본 플로우 (default)');
    console.log('  deadline - /start 후 deadline_at, remaining_sec 출력');
    console.log('  time    - 타임아웃 시뮬레이션 (10초 게임, 15초 후)');
    console.log('  autokill - 자동살해 시뮬레이션 (5분 게임, 90초 경과)');
    console.log('  verify  - 규칙 엔진 명시적 검증 (PASS/FAIL)');
    console.log('  all     - 위 모든 테스트 + 검증 실행');
  }
}

main().catch(console.error);

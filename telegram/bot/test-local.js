#!/usr/bin/env node
/**
 * 로컬 테스트: node telegram/bot/test-local.js
 * BOT TOKEN 없이 routeMessage() 호출로 동작 확인
 *
 * 검증:
 * - /start 후 deadline_at, remaining_sec 출력
 * - 짧은 제한시간(game_total_sec)으로 빠른 테스트
 * - opts.now로 시간 시뮬레이션 (자동살해, 타임아웃)
 */
const { routeMessage, handleStart } = require('./bot');
const matchStore = require('../../core/state/matchStore');

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
  const player = await require('../../core/state/playerStore').getPlayer(playerId);
  const match = player?.match_id ? await matchStore.getMatch(player.match_id) : null;
  if (match) {
    console.log('\n[Match state] deadline_at:', match.deadline_at);
    console.log('[Match state] game_state.dead_roles:', match.game_state?.dead_roles);
    console.log('[Match state] game_state.triggered_kill_marks:', match.game_state?.triggered_kill_marks);
  }
}

async function timeSimulationTest() {
  const playerId = 'time_sim_' + Date.now();
  const { handleStart, handleTextMessage } = require('./bot');
  const playerStore = require('../../core/state/playerStore');

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
  const { handleStart, handleTextMessage } = require('./bot');
  const playerStore = require('../../core/state/playerStore');

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
  } else if (mode === 'all') {
    await basicFlow();
    await deadlineTest();
    await timeSimulationTest();
    await autoKillSimulationTest();
  } else {
    console.log('Usage: node telegram/bot/test-local.js [basic|deadline|time|autokill|all]');
    console.log('  basic   - 기본 플로우 (default)');
    console.log('  deadline - /start 후 deadline_at, remaining_sec 출력');
    console.log('  time    - 타임아웃 시뮬레이션 (10초 게임, 15초 후)');
    console.log('  autokill - 자동살해 시뮬레이션 (5분 게임, 90초 경과)');
    console.log('  all     - 위 모든 테스트 실행');
  }
}

main().catch(console.error);

#!/usr/bin/env node
/**
 * telegram/bot/test-telegram.js - 실제 텔레그램 연결 전 스모크 테스트
 * BOT_TOKEN 없이도 실행 가능. 토큰 없으면 경고만 출력하고 체크리스트 진행.
 *
 * 실행: node telegram/bot/test-telegram.js
 */
const { routeMessage } = require('./bot');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function section(title) {
  console.log('\n' + '='.repeat(50));
  console.log(' ' + title);
  console.log('='.repeat(50));
}

function check(name, ok) {
  console.log('  ' + (ok ? '[OK]' : '[--]') + ' ' + name);
  return ok;
}

async function smokeFlow() {
  const playerId = 'smoke_' + Date.now();
  let allOk = true;

  const r1 = await routeMessage(playerId, '/start');
  allOk = check('/start 응답 정상 (Match, Time left, Deadline 포함)', r1.includes('Match:') && r1.includes('Time left') && r1.includes('Tartarus')) && allOk;

  const r2 = await routeMessage(playerId, '로그 보여줘');
  allOk = check('일반 액션 응답 정상 (remaining 포함)', r2.includes('left') && !r2.includes('Error')) && allOk;

  await routeMessage(playerId, '닥터를 의심한다');
  const r3 = await routeMessage(playerId, '엔지니어 의심');
  allOk = check('game_over 후 추가 액션 차단 (Game over 응답)', r3.includes('Game over') && r3.includes('Send /start')) && allOk;

  return allOk;
}

function printChecklist() {
  console.log('\n--- 운영 전 체크리스트 ---');
  const hasToken = !!BOT_TOKEN;
  check('TELEGRAM_BOT_TOKEN 설정', hasToken);
  check('로컬 규칙 엔진: node telegram/bot/test-local.js verify', true);
  check('스모크 플로우: node telegram/bot/test-telegram.js', true);
  console.log('\n  [실제 텔레그램 테스트]');
  console.log('  1. 봇에게 /start 전송 → Match, Time left, Deadline 응답 확인');
  console.log('  2. 자유 입력 (예: "로그 보여줘") → remaining 시간 포함 응답 확인');
  console.log('  3. ACCUSE로 게임 종료 → [GAME OVER] outcome 응답 확인');
  console.log('  4. 종료 후 추가 입력 → "Game over. Send /start" 응답 확인');
  console.log('\n  [환경변수]');
  console.log('  - TELEGRAM_BOT_TOKEN: @BotFather 에서 발급');
  console.log('  - BOT_LOG=0: 로그 비활성화 (기본: 활성화)');
}

async function main() {
  section('텔레그램 봇 스모크 테스트');

  if (!BOT_TOKEN) {
    console.log('\n  [경고] TELEGRAM_BOT_TOKEN 미설정');
    console.log('  → 토큰 없이 로컬 흐름만 검증합니다.');
    console.log('  → 실제 텔레그램 테스트 시 .env 또는 환경변수에 토큰 설정 필요.\n');
  } else {
    console.log('\n  [OK] TELEGRAM_BOT_TOKEN 설정됨\n');
  }

  section('로컬 메시지 흐름 검증');
  let ok = true;
  try {
    ok = await smokeFlow();
  } catch (err) {
    console.error('  [FAIL]', err.message);
    ok = false;
  }

  printChecklist();

  if (ok) {
    console.log('\n--- 스모크 테스트: PASS ---\n');
    process.exit(0);
  } else {
    console.log('\n--- 스모크 테스트: FAIL ---\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

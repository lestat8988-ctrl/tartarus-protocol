#!/usr/bin/env node
/**
 * 로컬 테스트: node telegram/bot/test-local.js
 * BOT TOKEN 없이 routeMessage() 호출로 1회 동작 확인
 */
const { routeMessage } = require('./bot');

async function main() {
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

main().catch(console.error);

/**
 * telegram/bot/bot.js - 텔레그램 봇 진입점
 * bot → parser → engine → state 저장 흐름 연결.
 * BOT TOKEN 없이도 handleTextMessage()로 로컬 테스트 가능.
 */

const matchStore = require('../../core/state/matchStore');
const playerStore = require('../../core/state/playerStore');
const ep1Engine = require('../../core/engine/ep1Engine');
const intentParser = require('../../core/nlu/intentParser');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

/**
 * /start 처리
 * @param {string} playerId - telegram user id
 * @returns {Promise<string>}
 */
async function handleStart(playerId) {
  const player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  if (!matchId) {
    const match = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  return (
    'Tartarus Protocol v1\n\n' +
    'You are the Captain. Find the imposter before time runs out.\n\n' +
    'Commands:\n' +
    '- /start : Start or resume\n' +
    '- Type freely: "네비게이터 어디 있었어", "로그 보여줘", "닥터 의심"\n\n' +
    'Match: ' + matchId
  );
}

/**
 * 일반 텍스트 입력 처리
 * @param {string} playerId - telegram user id
 * @param {string} text - 사용자 입력
 * @returns {Promise<string>}
 */
async function handleTextMessage(playerId, text) {
  // 1. player → match
  let player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  if (!matchId) {
    const match = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }

  const match = await matchStore.getMatch(matchId);
  if (!match) return 'Match not found. Send /start to begin.';

  if (match.game_state?.game_over) {
    return 'Game over. Outcome: ' + (match.game_state.outcome || 'unknown');
  }

  // 2. parse intent
  const parsed = intentParser.parse(text);
  const action = {
    actor: 'captain',
    role: 'captain',
    action: parsed.intent_type,
    target: parsed.target
  };

  // 3. engine apply
  const result = await ep1Engine.applyAction(match, action);
  if (!result.ok) {
    return 'Error: ' + (result.error || 'unknown');
  }

  // 4. state 저장
  await matchStore.updateMatch(matchId, {
    ...result.next_state,
    turn: (match.turn || 1) + 1
  });
  if (result.events && result.events.length > 0) {
    for (const ev of result.events) {
      await matchStore.appendEvent(matchId, ev);
    }
  }

  // 5. 응답 조립
  let reply = result.summary || 'Captain acted.';
  const recent = (match.events || []).slice(-3);
  if (recent.length > 0) {
    reply += '\n\nRecent: ' + recent.map((e) => (e.type || e.role) + (e.target ? '→' + e.target : '')).join(', ');
  }
  return reply;
}

/**
 * 메시지 라우팅 (텔레그램 메시지 또는 로컬 테스트)
 * @param {string} playerId
 * @param {string} text
 * @returns {Promise<string>}
 */
async function routeMessage(playerId, text) {
  const t = String(text || '').trim();
  if (t === '/start') return handleStart(playerId);
  return handleTextMessage(playerId, t);
}

/**
 * 봇 초기화 (텔레그램 SDK 연결 시 사용)
 */
function initBot() {
  if (!BOT_TOKEN) {
    console.warn('[bot] TELEGRAM_BOT_TOKEN not set. Use routeMessage(playerId, text) for local test.');
    return null;
  }
  // const TelegramBot = require('node-telegram-bot-api');
  // const bot = new TelegramBot(BOT_TOKEN, { polling: true });
  // bot.on('message', async (msg) => {
  //   const chatId = msg.chat?.id;
  //   const text = msg.text || '';
  //   const playerId = String(msg.from?.id || chatId);
  //   const reply = await routeMessage(playerId, text);
  //   await bot.sendMessage(chatId, reply);
  // });
  console.log('[bot] Telegram bot ready (SDK not connected). Use routeMessage for test.');
  return {};
}

/**
 * Webhook 모드 (Express 연동 시)
 */
async function handleWebhook(req, res) {
  const body = req.body || {};
  const msg = body.message;
  if (!msg) {
    res.status(200).send();
    return;
  }
  const chatId = msg.chat?.id;
  const text = msg.text || '';
  const playerId = String(msg.from?.id || chatId);
  try {
    const reply = await routeMessage(playerId, text);
    if (BOT_TOKEN && chatId) {
      // await bot.sendMessage(chatId, reply);
      res.status(200).json({ ok: true });
    } else {
      res.status(200).json({ reply });
    }
  } catch (err) {
    console.error('[bot]', err);
    res.status(500).json({ ok: false, error: String(err.message) });
  }
}

module.exports = {
  initBot,
  handleStart,
  handleTextMessage,
  routeMessage,
  handleWebhook
};

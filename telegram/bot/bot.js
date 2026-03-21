/**
 * telegram/bot/bot.js - 텔레그램 봇 진입점
 * bot → parser → engine → state 저장 흐름 연결.
 * BOT TOKEN 없이도 handleTextMessage()로 로컬 테스트 가능.
 * 로컬 개발용 HTTP API (포트 8788) 지원.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const matchStore = require('../../core/state/matchStore');
const playerStore = require('../../core/state/playerStore');
const ep1Engine = require('../../core/engine/ep1Engine');
const intentParser = require('../../core/nlu/intentParser');

const API_PORT = 8788;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LOG = process.env.BOT_LOG !== '0';

function log(tag, msg, data) {
  if (LOG) console.log('[bot]', tag, msg, data != null ? JSON.stringify(data) : '');
}

/**
 * /start 처리
 * @param {string} playerId - telegram user id
 * @param {object} opts - { game_total_sec?, now? } 테스트용
 * @returns {Promise<string>}
 */
async function handleStart(playerId, opts = {}) {
  const player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  if (!matchId) {
    const match = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {
      game_total_sec: opts.game_total_sec
    });
    matchId = match.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  const match = await matchStore.getMatch(matchId);
  const timer = ep1Engine.getTimerStatus ? ep1Engine.getTimerStatus(match, opts.now) : { remaining_sec: 420 };
  const mins = Math.floor((timer.remaining_sec || 420) / 60);
  const secs = (timer.remaining_sec || 420) % 60;
  log('START', 'ok', { playerId, matchId, remaining_sec: timer.remaining_sec });
  return (
    'Tartarus Protocol v1\n\n' +
    'You are the Captain. Find the imposter before time runs out.\n\n' +
    'Commands:\n' +
    '- /start : Start or resume\n' +
    '- Type freely: "네비게이터 어디 있었어", "로그 보여줘", "닥터 의심"\n\n' +
    'Match: ' + matchId + '\n' +
    'Time left: ' + mins + ':' + String(secs).padStart(2, '0') + '\n' +
    (match?.deadline_at ? 'Deadline: ' + match.deadline_at : '')
  );
}

/**
 * 일반 텍스트 입력 처리
 * @param {string} playerId - telegram user id
 * @param {string} text - 사용자 입력
 * @param {object} opts - { now? } 테스트용 시각 주입
 * @returns {Promise<string>}
 */
async function handleTextMessage(playerId, text, opts = {}) {
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
    log('GAME_OVER', 'blocked', { playerId, matchId, outcome: match.game_state.outcome });
    return 'Game over. Outcome: ' + (match.game_state.outcome || 'unknown') + '. Send /start for new game.';
  }

  // 2. parse intent
  const parsed = intentParser.parse(text);
  const action = {
    actor: 'captain',
    role: 'captain',
    action: parsed.intent_type,
    target: parsed.target
  };

  // 3. engine apply (opts.now for test)
  const result = await ep1Engine.applyAction(match, action, opts);
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

  // 5. 응답 조립 (remaining_sec, game_over, outcome 포함)
  const updated = await matchStore.getMatch(matchId);
  let reply = result.summary || 'Captain acted.';
  const rem = result.remaining_sec ?? updated?.game_state?.remaining_sec;
  if (rem != null) {
    const m = Math.floor(rem / 60);
    const s = rem % 60;
    reply += '\n⏱ ' + m + ':' + String(s).padStart(2, '0') + ' left';
  }
  if (result.game_over && result.outcome) {
    log('GAME_OVER', 'ended', { playerId, matchId, outcome: result.outcome });
    reply += '\n\n[GAME OVER] ' + result.outcome;
  } else {
    log('ACTION', 'ok', { playerId, matchId, action: parsed.intent_type, target: parsed.target });
  }
  const recent = (updated?.events || []).slice(-3);
  if (recent.length > 0) {
    reply += '\n\nRecent: ' + recent.map((e) => (e.type || e.role) + (e.target ? '→' + e.target : '')).join(', ');
  }
  return reply;
}

/**
 * 메시지 라우팅 (텔레그램 메시지 또는 로컬 테스트)
 * @param {string} playerId
 * @param {string} text
 * @param {object} opts - { now?, game_total_sec? } 테스트용
 * @returns {Promise<string>}
 */
async function routeMessage(playerId, text, opts = {}) {
  const t = String(text || '').trim();
  log('ROUTE', 'in', { playerId, text: t.slice(0, 50) });
  if (t === '/start') return handleStart(playerId, opts);
  return handleTextMessage(playerId, t, opts);
}

/**
 * API용 /start 상태 반환
 * @param {string} playerId
 * @returns {Promise<object>}
 */
async function getStartStateApi(playerId) {
  let player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  if (!matchId) {
    const match = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  const match = await matchStore.getMatch(matchId);
  const timer = ep1Engine.getTimerStatus ? ep1Engine.getTimerStatus(match) : { remaining_sec: 420 };
  return {
    ok: true,
    match_id: matchId,
    remaining_sec: timer.remaining_sec ?? 420,
    game_state: match?.game_state || {},
    deadline_at: match?.deadline_at,
    events: match?.events || []
  };
}

/**
 * API용 메시지 처리 (구조화된 결과 반환)
 * @param {string} playerId
 * @param {string} text
 * @param {object} opts - { now? }
 * @returns {Promise<object>}
 */
async function processMessageApi(playerId, text, opts = {}) {
  let player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  if (!matchId) {
    const match = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  const match = await matchStore.getMatch(matchId);
  if (!match) return { ok: false, error: 'Match not found' };

  if (match.game_state?.game_over) {
    return {
      ok: true,
      summary: `Game over. Outcome: ${match.game_state.outcome || 'unknown'}`,
      game_over: true,
      outcome: match.game_state.outcome,
      remaining_sec: 0,
      events: [],
      match_state: { ...match.game_state }
    };
  }

  const parsed = intentParser.parse(text);
  const action = { actor: 'captain', role: 'captain', action: parsed.intent_type, target: parsed.target };
  const result = await ep1Engine.applyAction(match, action, opts);
  if (!result.ok) return { ok: false, error: result.error || 'unknown' };

  await matchStore.updateMatch(matchId, { ...result.next_state, turn: (match.turn || 1) + 1 });
  if (result.events?.length > 0) {
    for (const ev of result.events) await matchStore.appendEvent(matchId, ev);
  }

  const updated = await matchStore.getMatch(matchId);
  return {
    ok: true,
    summary: result.summary || 'Captain acted.',
    remaining_sec: result.remaining_sec ?? 0,
    game_over: result.game_over || false,
    outcome: result.outcome || null,
    events: result.events || [],
    recent_events: (updated?.events || []).slice(-5),
    match_state: updated?.game_state || {}
  };
}

/**
 * 봇 초기화 (텔레그램 SDK 연결 시 사용)
 */
function initBot() {
  if (!BOT_TOKEN) {
    console.warn('[bot] TELEGRAM_BOT_TOKEN not set. Use routeMessage(playerId, text) for local test.');
    return null;
  }
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
      res.status(200).json({ ok: true });
    } else {
      res.status(200).json({ reply });
    }
  } catch (err) {
    console.error('[bot]', err);
    res.status(500).json({ ok: false, error: String(err.message) });
  }
}

/**
 * 로컬 개발용 HTTP API 서버 (포트 8788)
 * TELEGRAM_BOT_TOKEN 없어도 실행됨.
 */
function createLocalApiServer() {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Content-Type', 'application/json');

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    await new Promise((resolve) => req.on('end', resolve));

    const url = new URL(req.url || '/', 'http://localhost');
    const route = url.pathname;

    try {
      if ((route === '/' || route === '/miniapp' || route === '/index.html') && req.method === 'GET') {
        const miniappPath = path.join(__dirname, '..', 'miniapp', 'index.html');
        const html = fs.readFileSync(miniappPath, 'utf8');
        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(html);
        return;
      }

      if (route === '/health' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, service: 'telegram-bot-local-api' }));
        return;
      }

      if (route === '/api/start' && req.method === 'POST') {
        const data = body ? JSON.parse(body) : {};
        const playerId = data.playerId || 'miniapp_' + Date.now();
        const state = await getStartStateApi(playerId);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, playerId, ...state }));
        return;
      }

      if (route === '/api/state' && req.method === 'GET') {
        const playerId = url.searchParams.get('playerId');
        if (!playerId) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'playerId required' }));
          return;
        }
        const player = await playerStore.getPlayer(playerId);
        const matchId = player?.match_id;
        if (!matchId) {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, match_id: null, game_state: null }));
          return;
        }
        const match = await matchStore.getMatch(matchId);
        const timer = ep1Engine.getTimerStatus ? ep1Engine.getTimerStatus(match) : { remaining_sec: 420 };
        res.writeHead(200);
        res.end(JSON.stringify({
          ok: true,
          match_id: matchId,
          remaining_sec: timer.remaining_sec ?? 420,
          game_state: match?.game_state || {},
          events: match?.events || []
        }));
        return;
      }

      if (route === '/api/message' && req.method === 'POST') {
        const data = body ? JSON.parse(body) : {};
        const playerId = data.playerId;
        const text = data.text || '';
        if (!playerId) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'playerId required' }));
          return;
        }
        const result = await processMessageApi(playerId, text);
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    } catch (err) {
      console.error('[bot] API error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: String(err.message) }));
    }
  });

  return server;
}

/**
 * 실행 진입점: node telegram/bot/bot.js
 * 로컬 API 서버 항상 시작, Telegram polling은 토큰 있을 때만.
 */
if (require.main === module) {
  require('dotenv').config();
  const token = process.env.TELEGRAM_BOT_TOKEN;

  const apiServer = createLocalApiServer();
  apiServer.listen(API_PORT, () => {
    console.log('[bot] local API server listening on http://localhost:' + API_PORT);
  });

  let bot = null;
  if (token) {
    const TelegramBot = require('node-telegram-bot-api');
    bot = new TelegramBot(token, { polling: true });
    console.log('[bot] bot runtime starting');
    console.log('[bot] token detected');
    console.log('[bot] polling started');

    bot.on('message', async (msg) => {
      const chatId = msg.chat?.id;
      const text = msg.text;
      if (!text || !chatId) return;
      const playerId = String(msg.from?.id ?? chatId);
      try {
        const reply = await routeMessage(playerId, text);
        await bot.sendMessage(chatId, reply);
      } catch (err) {
        console.error('[bot] message error:', err.message || err);
        try {
          await bot.sendMessage(chatId, 'Error: ' + (err.message || 'unknown'));
        } catch (_) {}
      }
    });
  } else {
    console.log('[bot] TELEGRAM_BOT_TOKEN not set - polling disabled, API only');
  }

  const shutdown = () => {
    console.log('[bot] shutting down...');
    apiServer.close();
    if (bot) bot.stopPolling?.();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  initBot,
  handleStart,
  handleTextMessage,
  routeMessage,
  handleWebhook,
  getStartStateApi,
  processMessageApi
};

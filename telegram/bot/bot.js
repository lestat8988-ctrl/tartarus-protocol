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

const ROLE_NAMES_KO = { doctor: '닥터', engineer: '엔지니어', navigator: '네비게이터', pilot: '파일럿', captain: '함장' };
function roleNameKo(r) {
  return ROLE_NAMES_KO[String(r || '').toLowerCase()] || (r ? String(r) : '');
}

/** 목적어 조사: 닥터→닥터를, 파일럿→파일럿을. 이미 조사 있으면 붙이지 않음. */
function roleWithObjectParticle(roleKey) {
  const name = roleNameKo(roleKey);
  if (!name) return '';
  const r = String(roleKey || '').toLowerCase();
  const hasParticle = /[을를이가과와]\s*$/.test(name);
  if (hasParticle) return name;
  const withParticle = { doctor: '닥터를', engineer: '엔지니어를', navigator: '네비게이터를', pilot: '파일럿을' }[r];
  return withParticle || name + '를';
}

/**
 * Raw action trace를 플레이어용 읽기 전용 로그로 변환.
 * QUESTION -> navigator, CHECK_LOG 등은 노출하지 않고, 사람이 읽을 수 있는 문장만 반환.
 * miniapp applyEvents: label = (ev.type || ev.role) + (ev.target ? ' -> ' + ev.target : '')
 * → type에 전체 문장을 넣고 target=null로 하면 문장만 표시됨.
 * @param {object[]} rawEvents - match.events 등 내부 raw 이벤트
 * @returns {object[]} { type: string, role?, target?: null, _key?: string } - 표시용
 */
function toPlayerDisplayLogs(rawEvents) {
  if (!rawEvents || !Array.isArray(rawEvents)) return [];
  const out = [];

  for (const ev of rawEvents) {
    const t = String(ev?.type || '').toUpperCase();
    const role = ev?.role || 'captain';
    const target = ev?.target ? String(ev.target).toLowerCase() : null;
    const baseKey = [ev?.ts ?? '', t, role, target ?? ''].join('|');

    if (t === 'QUESTION' && target) {
      out.push({ type: '[함장]', role: 'system', target: null, _key: baseKey + '|hdr' });
      out.push({ type: `${roleNameKo(target)}, 그때 어디 있었지?`, role: 'system', target: null, _key: baseKey + '|body' });
      continue;
    }
    if (t === 'SUSPECT' && target) {
      out.push({ type: '[함장]', role: 'system', target: null, _key: baseKey + '|hdr' });
      out.push({ type: `${roleWithObjectParticle(target)} 의심한다`, role: 'system', target: null, _key: baseKey + '|body' });
      continue;
    }

    let text = null;
    if (t === 'CHECK_LOG') {
      text = target ? `함장이 ${roleNameKo(target)} 구역 로그를 확인했다.` : '함장이 시스템 로그를 확인했다.';
    } else if (t === 'OBSERVE') {
      text = '함장이 교량을 관찰했다.';
    } else if (t === 'ACCUSE' && target) {
      text = `함장이 ${roleWithObjectParticle(target)} 처형했다.`;
    } else if (t === 'DEATH') {
      const victim = roleNameKo(ev.role || target);
      text = victim ? `[시스템] ${victim} 생체 신호 소실.` : '[시스템] 생체 신호 소실.';
    } else if (t === 'TIMEOUT') {
      text = '[시스템] 시간 종료.';
    } else if (t === 'TAKE_PISTOL') {
      text = '함장이 권총을 획득했다.';
    } else if (t === 'FIND_CLUE') {
      text = '함장이 단서를 수집했다.';
    } else if (t === 'REPAIR' || t === 'WAIT') {
      text = '함장이 행동했다.';
    } else if (ev.dialogue && typeof ev.dialogue === 'string') {
      const d = ev.dialogue.trim();
      const m = d.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (m && m[2]) {
        out.push({ type: '[' + m[1] + ']', role: 'system', target: null, _key: baseKey + '|hdr' });
        out.push({ type: m[2].trim(), role: 'system', target: null, _key: baseKey + '|body' });
      } else {
        text = d;
      }
    }

    if (text) {
      out.push({ type: text, role: 'system', target: null, _key: baseKey });
    }
  }
  return out;
}

/**
 * 같은 이벤트가 여러 번 내려가지 않도록 _key(ts+type+role+target) 기준 dedupe.
 * @param {object[]} displayLogs - toPlayerDisplayLogs 출력
 */
function dedupeDisplayLogs(displayLogs) {
  if (!displayLogs || !displayLogs.length) return [];
  const seen = new Set();
  const out = [];
  for (const item of displayLogs) {
    const key = item._key ?? item.type ?? '';
    if (!seen.has(key)) {
      seen.add(key);
      const { _key, ...rest } = item;
      out.push(rest);
    }
  }
  return out;
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

  let needNewMatch = !matchId;
  if (matchId) {
    const existingMatch = await matchStore.getMatch(matchId);
    if (existingMatch?.game_state?.game_over) needNewMatch = true;
  }
  if (needNewMatch) {
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
  const recentDisplay = dedupeDisplayLogs(toPlayerDisplayLogs((updated?.events || []).slice(-3)));
  if (recentDisplay.length > 0) {
    reply += '\n\nRecent: ' + recentDisplay.map((e) => e.type).join(', ');
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
 * actual_imposter: game_over=true일 때만 match.impostor_role을 포함. game_over=false면 미포함.
 * @param {string} playerId
 * @param {object} opts - { restart?: boolean } restart=true면 새 매치 생성
 * @returns {Promise<object>}
 */
async function getStartStateApi(playerId, opts = {}) {
  if (opts.restart) {
    const player = await playerStore.getPlayer(playerId);
    if (player?.match_id) {
      await playerStore.setPlayer(playerId, {
        match_id: null,
        role: player.role || 'captain',
        joined_at: player.joined_at || new Date().toISOString()
      });
    }
  }
  let player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;

  let needNewMatch = !matchId;
  if (matchId) {
    const existingMatch = await matchStore.getMatch(matchId);
    if (existingMatch?.game_state?.game_over) needNewMatch = true;
  }
  if (needNewMatch) {
    const match = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  const match = await matchStore.getMatch(matchId);
  const timer = ep1Engine.getTimerStatus ? ep1Engine.getTimerStatus(match) : { remaining_sec: 420 };
  const gs = match?.game_state || {};
  const displayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(match?.events || []));
  const out = {
    ok: true,
    match_id: matchId,
    remaining_sec: timer.remaining_sec ?? 420,
    game_state: gs,
    deadline_at: match?.deadline_at,
    events: displayLogs
  };
  if (gs.game_over) {
    const imp = match?.impostor_role ?? match?.hidden_host_role;
    if (imp) out.actual_imposter = imp;
    const evs = match?.events || [];
    if (evs.some((e) => e && e.type === 'TIMEOUT')) out.is_timeout = true;
  }
  return out;
}

/**
 * API용 메시지 처리 (구조화된 결과 반환)
 * actual_imposter: game_over=true일 때만 match.impostor_role을 포함. game_over=false면 미포함.
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
    const ret = {
      ok: true,
      summary: `Game over. Outcome: ${match.game_state.outcome || 'unknown'}`,
      game_over: true,
      outcome: match.game_state.outcome,
      remaining_sec: 0,
      events: [],
      match_state: { ...match.game_state }
    };
    if (match.impostor_role != null) ret.actual_imposter = match.impostor_role;
    const evs = match?.events || [];
    if (evs.some((e) => e && e.type === 'TIMEOUT')) ret.is_timeout = true;
    return ret;
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
  const gameOver = result.game_over || updated?.game_state?.game_over;
  const newDisplayLogs = toPlayerDisplayLogs(result.events || []);
  const summaryText = newDisplayLogs.length ? newDisplayLogs[0].type : '함장이 행동했다.';
  const ret = {
    ok: true,
    summary: summaryText,
    remaining_sec: result.remaining_sec ?? 0,
    game_over: gameOver || false,
    outcome: result.outcome || null,
    events: newDisplayLogs,
    recent_events: [],
    match_state: updated?.game_state || {}
  };
  if (gameOver) {
    if (updated?.impostor_role != null) ret.actual_imposter = updated.impostor_role;
    const evs = result.events || updated?.events || [];
    if (evs.some((e) => e && e.type === 'TIMEOUT')) ret.is_timeout = true;
  }
  return ret;
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
        const restart = !!data.restart;
        const state = await getStartStateApi(playerId, { restart });
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
        const gs = match?.game_state || {};
        const displayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(match?.events || []));
        const statePayload = {
          ok: true,
          match_id: matchId,
          remaining_sec: timer.remaining_sec ?? 420,
          game_state: gs,
          events: displayLogs
        };
        if (gs.game_over) {
          if (match.impostor_role != null) statePayload.actual_imposter = match.impostor_role;
          const evs = match?.events || [];
          if (evs.some((e) => e && e.type === 'TIMEOUT')) statePayload.is_timeout = true;
        }
        res.writeHead(200);
        res.end(JSON.stringify(statePayload));
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

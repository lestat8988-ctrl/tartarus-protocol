/**
 * api/ep1/result.js - 1편 전용 결과 조회 API (Supabase)
 * POST body: { match_id }
 * returns: { match_id, game_over, outcome, turn, phase, location, public_events, recent_events, events_count }
 * 정답 필드(culprit, hidden_host, impostor, actual_imposter, true_impostor)는 클라이언트 응답에서 제외.
 *
 * tartarus_ep1_loop.js getResult()가 호출.
 *
 * 비밀 유지: hidden_host_role, role_private_notes는 기본 응답에 넣지 않음.
 * TODO: clue resolution, accuse resolution, pistol/fire resolution, death/win-loss resolution, hidden truth
 * TODO(debug): 필요 시 ?debug=1 등으로 hidden_host_role 확인용 엔드포인트 별도 구현
 */
const SECRET = process.env.TARTARUS_SECRET;
const { getOrCreateMatch, getRecentEventsForCurrentTurn, getEventsCount, getPublicEvents, formatEventForResponse } = require('./store');

function parseBody(req) {
  const raw = req.body;
  if (raw == null) return {};
  if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString('utf8'));
  if (typeof raw === 'string') return JSON.parse(raw);
  return typeof raw === 'object' ? raw : {};
}

function checkAuth(req) {
  if (!SECRET) return true;
  const h = req.headers['x-tartarus-secret'];
  return h && h === SECRET;
}

function errRes(res, status, message) {
  return res.status(status).json({ ok: false, error: { message } });
}

function toPascalImpostor(role) {
  if (!role || typeof role !== 'string') return null;
  const s = String(role).trim().toLowerCase();
  const map = { doctor: 'Doctor', engineer: 'Engineer', navigator: 'Navigator', pilot: 'Pilot' };
  return map[s] || null;
}

function resolveImpostorFromMatch(match) {
  if (!match) return null;
  const raw = match.hidden_host_role ?? match.private_state?.hidden_host_role ?? null;
  return toPascalImpostor(raw);
}

/** 정답 필드 제거. game_over=false 응답에 절대 노출되지 않도록 최종 응답에서 제거. */
const ANSWER_KEYS = ['culprit', 'hidden_host', 'impostor', 'actual_imposter', 'true_impostor'];

function removeAnswerFields(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(removeAnswerFields);
  const out = {};
  for (const k of Object.keys(obj)) {
    if (ANSWER_KEYS.includes(k)) continue;
    out[k] = removeAnswerFields(obj[k]);
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-tartarus-secret');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { message: 'Method Not Allowed' } });
  }

  if (!checkAuth(req)) {
    return res.status(401).json({ ok: false, error: { message: 'Unauthorized' } });
  }

  let body = {};
  try {
    body = parseBody(req);
  } catch {
    return errRes(res, 400, 'Invalid JSON body');
  }

  const matchId = body.match_id ?? null;
  if (!matchId || typeof matchId !== 'string') {
    return errRes(res, 400, 'match_id required');
  }

  const match = await getOrCreateMatch(matchId);
  if (!match) {
    return errRes(res, 500, 'Failed to get or create match');
  }

  const pub = await getPublicEvents(matchId);
  const recentRaw = await getRecentEventsForCurrentTurn(matchId);
  const recent_events = recentRaw.map((e) => {
    const full = formatEventForResponse(e);
    if (!full) return null;
    if (!full.summary) full.summary = (e.role && e.action) ? `${e.role} ${e.action}` : '';
    return full;
  }).filter(Boolean);
  const events_count = await getEventsCount(matchId);

  const safeResult = {
    debug_version: 'ep1-result-full-events-v2',
    match_id: match.match_id,
    game_over: !!match.game_over,
    outcome: match.outcome ?? null,
    turn: match.turn ?? 1,
    phase: match.phase ?? 'playing',
    location: match.location ?? 'bridge',
    public_events: Array.isArray(pub) ? pub : [],
    recent_events,
    events_count
  };

  const sanitized = removeAnswerFields(safeResult);
  return res.status(200).json(sanitized);
};

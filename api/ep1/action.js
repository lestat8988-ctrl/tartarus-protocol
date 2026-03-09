/**
 * api/ep1/action.js - 1편 전용 행동 제출 API (Supabase)
 * POST body: { match_id, turn, actor, role, action, target?, reason?, dialogue? }
 * returns: { ok, server_result, next_state, game_over, outcome }
 *
 * tartarus_ep1_loop.js submitAction()가 호출.
 * game_over / outcome 반환 시 루프 즉시 중단.
 *
 * TODO: clue resolution, accuse resolution, pistol/fire resolution, death/win-loss resolution, hidden truth
 */
const SECRET = process.env.TARTARUS_SECRET;
const {
  getOrCreateMatch,
  appendEvent,
  updateMatch,
  getRecentEvents,
  getEventsCount,
  getPublicEvents,
  makeReadableSummary,
  normalizeRole,
  normalizeAction
} = require('./store');

const RECENT_EVENTS_LIMIT = 5;

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

function getEventType(action) {
  const a = String(action || 'WAIT').toUpperCase();
  const types = { QUESTION: 'question', OBSERVE: 'observe', CHECK_LOG: 'check_log', REPAIR: 'repair', ACCUSE: 'accuse', WAIT: 'wait' };
  return types[a] || 'act';
}

function errRes(res, status, message) {
  return res.status(status).json({ ok: false, error: { message } });
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

  const matchId = body.match_id;
  if (!matchId || typeof matchId !== 'string') {
    return errRes(res, 400, 'match_id required');
  }

  const role = normalizeRole(body.role) ?? body.role ?? 'captain';
  const action = normalizeAction(body.action);

  const payload = {
    actor: body.actor ?? null,
    role,
    action,
    target: body.target ?? null,
    reason: body.reason ?? null,
    dialogue: body.dialogue ?? null
  };

  const match = await getOrCreateMatch(matchId);
  if (!match) {
    return errRes(res, 500, 'Failed to get or create match');
  }

  if (body.turn != null && role === 'captain') {
    const newTurn = Math.max(match.turn || 1, parseInt(body.turn, 10) || match.turn);
    await updateMatch(matchId, { turn: newTurn });
  }

  const readableSummary = makeReadableSummary(role, action, payload.target, payload.dialogue);
  const serverResult = { summary: readableSummary, event_type: getEventType(action) };

  const ok = await appendEvent(matchId, payload, readableSummary, serverResult);
  if (!ok) {
    return errRes(res, 500, 'Failed to append event');
  }

  const updatedMatch = await getOrCreateMatch(matchId);
  const pub = await getPublicEvents(matchId);
  const recentRaw = await getRecentEvents(matchId, RECENT_EVENTS_LIMIT);
  const recent_events = recentRaw.map((e) => ({
    turn: e.turn,
    actor: e.actor,
    role: e.role,
    action: e.action,
    summary: e.server_result?.summary || `${e.role} ${e.action}`
  }));
  const events_count = await getEventsCount(matchId);

  return res.status(200).json({
    ok: true,
    server_result: {
      accepted: true,
      summary: readableSummary,
      event_type: getEventType(action),
      placeholder: true
    },
    next_state: {
      match_id: matchId,
      turn: updatedMatch.turn ?? 1,
      phase: updatedMatch.phase ?? 'playing',
      location: updatedMatch.location ?? 'bridge',
      public_events: Array.isArray(pub) ? pub : [],
      recent_events,
      events_count
    },
    game_over: updatedMatch.game_over || false,
    outcome: updatedMatch.outcome ?? null
  });
};

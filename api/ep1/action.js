/**
 * api/ep1/action.js - 1편 전용 행동 제출 API
 * POST body: { match_id, turn, actor, role, action, target?, reason?, dialogue? }
 * returns: { ok, server_result, next_state, game_over, outcome }
 *
 * tartarus_ep1_loop.js submitAction()가 호출.
 * game_over / outcome 반환 시 루프 즉시 중단.
 *
 * TODO: hidden truth, clue resolution, accuse resolution, pistol/fire resolution, death/win-loss resolution
 * TODO: 실운영용 durable store 필요
 */
const SECRET = process.env.TARTARUS_SECRET;
const { getOrCreateMatch, appendEvent, normalizeRole, normalizeAction } = require('./store');

const RECENT_EVENTS_LIMIT = 5;

const ROLE_LABELS = { captain: 'Captain', doctor: 'Doctor', engineer: 'Engineer', navigator: 'Navigator', pilot: 'Pilot' };
const TARGET_LABELS = { player: 'the captain', captain: 'the captain', doctor: 'the doctor', engineer: 'the engineer', navigator: 'the navigator', pilot: 'the pilot' };

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

function makeReadableSummary(role, action, target, dialogue) {
  const r = ROLE_LABELS[role] || role || 'Unknown';
  const a = String(action || 'WAIT').toUpperCase();
  const t = target ? (TARGET_LABELS[target.toLowerCase()] || target) : null;

  switch (a) {
    case 'QUESTION':
      return t ? `${r} questioned ${t}.` : `${r} asked for clarification.`;
    case 'OBSERVE':
      return role === 'captain' ? `${r} observed the bridge.` : `${r} observed the situation.`;
    case 'CHECK_LOG':
      return `${r} checked ship logs.`;
    case 'REPAIR':
      return `${r} performed repairs.`;
    case 'ACCUSE':
      return t ? `${r} accused ${t}.` : `${r} made an accusation.`;
    case 'WAIT':
      return `${r} held position.`;
    default:
      break;
  }
  if (t) return `${r} ${a.toLowerCase()} (target: ${t}).`;
  const d = (dialogue || '').slice(0, 50);
  return d ? `${r}: ${d}${d.length >= 50 ? '...' : ''}` : `${r} acted.`;
}

function getEventType(action) {
  const a = String(action || 'WAIT').toUpperCase();
  const types = { QUESTION: 'question', OBSERVE: 'observe', CHECK_LOG: 'check_log', REPAIR: 'repair', ACCUSE: 'accuse', WAIT: 'wait' };
  return types[a] || 'act';
}

function recentEvents(events, n = RECENT_EVENTS_LIMIT) {
  const arr = Array.isArray(events) ? events : [];
  return arr.slice(-n);
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
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });
  }

  if (!checkAuth(req)) {
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
  }

  let body = {};
  try {
    body = parseBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } });
  }

  const matchId = body.match_id;
  if (!matchId || typeof matchId !== 'string') {
    return res.status(400).json({ ok: false, error: { code: 'MISSING_MATCH_ID', message: 'match_id is required' } });
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

  const match = getOrCreateMatch(matchId);
  appendEvent(match, payload);

  if (body.turn != null && role === 'captain') {
    match.turn = Math.max(match.turn, parseInt(body.turn, 10) || match.turn);
  }

  const readableSummary = makeReadableSummary(role, action, payload.target, payload.dialogue);
  if (match.public_events.length > 0) {
    match.public_events[match.public_events.length - 1].summary = readableSummary;
  }

  const pub = match.public_events || [];
  const evts = match.events || [];

  return res.status(200).json({
    ok: true,
    server_result: {
      accepted: true,
      summary: readableSummary,
      event_type: getEventType(action),
      placeholder: true
    },
    next_state: {
      match_id: match.match_id,
      turn: match.turn,
      phase: match.phase,
      public_events: pub,
      recent_events: recentEvents(pub, RECENT_EVENTS_LIMIT),
      events_count: evts.length
    },
    game_over: match.game_over || false,
    outcome: match.outcome ?? null
  });
};

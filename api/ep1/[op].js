/**
 * api/ep1/[op].js - 1편 전용 통합 API (state / action / result)
 *
 * 한 파일에서 op=state|action|result 분기.
 * /api/ep1/state, /api/ep1/action, /api/ep1/result
 *
 * TODO: 실운영용 durable store 필요 (Supabase, Redis, DB 등)
 * TODO: hidden truth, clue resolution, accuse resolution, pistol/fire resolution, death/win-loss resolution
 */
const SECRET = process.env.TARTARUS_SECRET;

// ─── module-scope in-memory store ─────────────────────────────────────────
// TODO: 실운영 durable store 필요
const STORE = new Map();

const ROLE_LABELS = {
  captain: 'Captain',
  doctor: 'Doctor',
  engineer: 'Engineer',
  navigator: 'Navigator',
  pilot: 'Pilot'
};

const TARGET_LABELS = {
  player: 'the captain',
  captain: 'the captain',
  doctor: 'the doctor',
  engineer: 'the engineer',
  navigator: 'the navigator',
  pilot: 'the pilot'
};

function roleLabel(role) {
  if (!role) return 'Unknown';
  const r = String(role).toLowerCase();
  return ROLE_LABELS[r] || role;
}

function targetLabel(target) {
  if (!target) return null;
  const t = String(target).toLowerCase();
  return TARGET_LABELS[t] || target;
}

/**
 * action별 사람 읽기 쉬운 summary 생성
 */
function makeActionSummary(actor, role, action, target, dialogue) {
  const r = roleLabel(role);
  const a = String(action || 'WAIT').toUpperCase();
  const t = targetLabel(target);

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

function createDefaultMatchState(matchId) {
  const match = {
    match_id: matchId,
    turn: 1,
    phase: 'playing',
    location: 'bridge',
    events: [],
    public_events: [],
    crew_status: {
      doctor: { status: 'alive' },
      engineer: { status: 'alive' },
      navigator: { status: 'alive' },
      pilot: { status: 'alive' }
    },
    game_over: false,
    outcome: null
  };
  match.public_events.push({ turn: 1, summary: 'AXIS emergency briefing initiated.' });
  return match;
}

function getOrCreateMatch(matchId) {
  let m = STORE.get(matchId);
  if (!m) {
    m = createDefaultMatchState(matchId);
    STORE.set(matchId, m);
  }
  return m;
}

function appendEvent(match, payload, clientTurn) {
  if (payload.role === 'captain' && clientTurn != null) {
    match.turn = Math.max(match.turn, clientTurn);
  }

  const rawEvent = {
    turn: match.turn,
    actor: payload.actor,
    role: payload.role,
    action: payload.action,
    target: payload.target ?? null,
    reason: payload.reason ?? null,
    dialogue: payload.dialogue ?? null,
    ts: Date.now()
  };
  match.events.push(rawEvent);

  const summary = makeActionSummary(
    payload.actor,
    payload.role,
    payload.action,
    payload.target,
    payload.dialogue
  );
  match.public_events.push({ turn: match.turn, summary });
}

function recentEvents(events, n = 5) {
  const arr = Array.isArray(events) ? events : [];
  return arr.slice(-n);
}

// ─── req/res helpers ───────────────────────────────────────────────────────

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

function getOp(req) {
  const m = (req.url || '').match(/\/api\/ep1\/([^/?]+)/);
  return m ? m[1] : (req.query && req.query.op);
}

function errRes(res, status, message) {
  return res.status(status).json({ ok: false, error: { message } });
}

// ─── handlers ───────────────────────────────────────────────────────────────

function handleState(body, res) {
  const matchId = body.match_id;
  if (!matchId || typeof matchId !== 'string') {
    return errRes(res, 400, 'match_id required');
  }
  const match = getOrCreateMatch(matchId);
  const pub = match.public_events || [];
  const evts = match.events || [];

  return res.status(200).json({
    state: match.phase,
    match_id: match.match_id,
    turn: match.turn,
    phase: match.phase,
    location: match.location,
    current_scene: match.location,
    current_round: match.turn,
    public_events: pub,
    recent_events: recentEvents(pub, 5),
    events_count: evts.length,
    crew_status: match.crew_status || {},
    game_over: match.game_over || false,
    outcome: match.outcome ?? null
  });
}

/** action: 단일 요청 처리. 클라이언트가 crew 4명을 병렬로 호출하면 동시 처리됨. */
function handleAction(body, res) {
  const matchId = body.match_id;
  if (!matchId || typeof matchId !== 'string') {
    return errRes(res, 400, 'match_id required');
  }
  const match = getOrCreateMatch(matchId);
  const payload = {
    actor: body.actor ?? null,
    role: body.role ?? 'captain',
    action: body.action ?? 'WAIT',
    target: body.target ?? null,
    reason: body.reason ?? null,
    dialogue: body.dialogue ?? null
  };

  appendEvent(match, payload, body.turn);

  const lastPub = match.public_events[match.public_events.length - 1];
  const summary = lastPub ? lastPub.summary : makeActionSummary(
    payload.actor,
    payload.role,
    payload.action,
    payload.target,
    payload.dialogue
  );
  const eventType = getEventType(payload.action);

  return res.status(200).json({
    ok: true,
    server_result: {
      accepted: true,
      summary,
      event_type: eventType,
      placeholder: true
    },
    next_state: {
      match_id: match.match_id,
      turn: match.turn,
      phase: match.phase,
      public_events: match.public_events || [],
      events_count: (match.events || []).length,
      game_over: match.game_over || false,
      outcome: match.outcome ?? null
    },
    game_over: match.game_over || false,
    outcome: match.outcome ?? null
  });
}

function handleResult(body, res) {
  const matchId = body.match_id;
  if (!matchId || typeof matchId !== 'string') {
    return errRes(res, 400, 'match_id required');
  }
  const match = getOrCreateMatch(matchId);
  const pub = match.public_events || [];

  return res.status(200).json({
    match_id: match.match_id,
    game_over: match.game_over || false,
    outcome: match.outcome ?? null,
    turn: match.turn,
    phase: match.phase,
    events_count: (match.events || []).length,
    recent_events: recentEvents(pub, 5),
    public_events: pub
  });
}

// ─── main handler ──────────────────────────────────────────────────────────

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

  const op = getOp(req);
  if (!['state', 'action', 'result'].includes(op)) {
    return errRes(res, 400, 'op must be state, action, or result');
  }

  let body = {};
  try {
    body = parseBody(req);
  } catch {
    return errRes(res, 400, 'Invalid JSON body');
  }

  if (op === 'state') return handleState(body, res);
  if (op === 'action') return handleAction(body, res);
  return handleResult(body, res);
};

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

function createDefaultMatchState(matchId) {
  return {
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
}

function getOrCreateMatch(matchId) {
  let m = STORE.get(matchId);
  if (!m) {
    m = createDefaultMatchState(matchId);
    STORE.set(matchId, m);
  }
  return m;
}

function actionSummary(actor, role, action, target, dialogue) {
  const r = role || actor || 'unknown';
  const a = (action || 'acted').toLowerCase();
  if (target) return `${r} ${a} (target: ${target})`;
  const d = (dialogue || '').slice(0, 40);
  return d ? `${r}: ${d}${d.length >= 40 ? '...' : ''}` : `${r} ${a}`;
}

function appendEvent(match, payload) {
  match.events.push({
    turn: match.turn,
    actor: payload.actor,
    role: payload.role,
    action: payload.action,
    target: payload.target ?? null,
    reason: payload.reason ?? null,
    dialogue: payload.dialogue ?? null,
    ts: Date.now()
  });
  const summary = actionSummary(
    payload.actor,
    payload.role,
    payload.action,
    payload.target,
    payload.dialogue
  );
  match.public_events.push({ turn: match.turn, summary });
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
  return res.status(200).json({
    state: match.phase,
    match_id: match.match_id,
    turn: match.turn,
    phase: match.phase,
    location: match.location,
    public_events: match.public_events || [],
    crew_status: match.crew_status || {},
    game_over: match.game_over || false,
    outcome: match.outcome ?? null
  });
}

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
  appendEvent(match, payload);
  const summary = match.public_events.length
    ? match.public_events[match.public_events.length - 1].summary
    : actionSummary(payload.actor, payload.role, payload.action, payload.target, payload.dialogue);

  return res.status(200).json({
    ok: true,
    server_result: {
      accepted: true,
      summary,
      placeholder: true
    },
    next_state: {
      match_id: match.match_id,
      turn: match.turn,
      phase: match.phase,
      public_events: match.public_events || []
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
  return res.status(200).json({
    match_id: match.match_id,
    game_over: match.game_over || false,
    outcome: match.outcome ?? null,
    phase: match.phase,
    turn: match.turn,
    public_events: match.public_events || [],
    events_count: (match.events || []).length
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

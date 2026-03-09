/**
 * api/ep1/state.js - 1편 전용 상태 조회 API (Supabase)
 * POST body: { match_id, turn?, viewer_role? }
 * - viewer_role: doctor|engineer|navigator|pilot 일 때만 private_context 추가 (captain/player용 요청에는 주지 않음)
 * returns: { match_id, turn, phase, ... } + (viewer_role 있을 때) private_context
 *
 * tartarus_ep1_loop.js getState()가 호출.
 */
const SECRET = process.env.TARTARUS_SECRET;
const { getOrCreateMatch, getRecentEvents, getEventsCount, getPublicEvents, getPrivateContextForRole } = require('./store');

const CREW_VIEWER_ROLES = ['doctor', 'engineer', 'navigator', 'pilot'];

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

  const matchId = body.match_id ?? null;
  if (!matchId || typeof matchId !== 'string') {
    return errRes(res, 400, 'match_id required');
  }

  const viewerRole = (body.viewer_role ?? '').trim().toLowerCase();
  const hasViewerRole = CREW_VIEWER_ROLES.includes(viewerRole);

  const match = await getOrCreateMatch(matchId);
  if (!match) {
    return errRes(res, 500, 'Failed to get or create match');
  }

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

  const payload = {
    state: match.phase,
    match_id: match.match_id,
    turn: match.turn ?? 1,
    phase: match.phase ?? 'playing',
    location: match.location ?? 'bridge',
    public_events: Array.isArray(pub) ? pub : [],
    recent_events,
    events_count,
    crew_status: match.crew_status || {},
    game_over: match.game_over || false,
    outcome: match.outcome ?? null
  };

  if (hasViewerRole) {
    const privateContext = getPrivateContextForRole(match, viewerRole);
    if (privateContext) {
      payload.private_context = privateContext;
    }
  }

  return res.status(200).json(payload);
};

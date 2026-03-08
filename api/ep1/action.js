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

  const summary = match.public_events.length
    ? match.public_events[match.public_events.length - 1].summary
    : `${role} ${action.toLowerCase()}`;

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
};

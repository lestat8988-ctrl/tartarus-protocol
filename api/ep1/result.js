/**
 * api/ep1/result.js - 1편 전용 결과 조회 API
 * POST body: { match_id }
 * returns: { outcome, game_over, match_id, ... }
 *
 * tartarus_ep1_loop.js getResult()가 호출.
 *
 * TODO: hidden truth, clue resolution, accuse resolution, pistol/fire resolution, death/win-loss resolution
 * TODO: 실운영용 durable store 필요
 */
const SECRET = process.env.TARTARUS_SECRET;
const { getOrCreateMatch } = require('./store');

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

  const matchId = body.match_id ?? null;
  const match = getOrCreateMatch(matchId || `ep1_${Date.now()}_anon`);

  return res.status(200).json({
    outcome: match.outcome ?? null,
    game_over: match.game_over || false,
    match_id: match.match_id,
    turn: match.turn,
    phase: match.phase
  });
};

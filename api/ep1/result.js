/**
 * api/ep1/result.js - 1편 전용 결과 조회 API (Supabase)
 * POST body: { match_id }
 * returns: { match_id, game_over, outcome, turn, phase, location, public_events, recent_events, events_count, outcome_reason?, winner_side?, loser_side? }
 * 정답 필드(culprit, hidden_host, impostor, actual_imposter, true_impostor)는 클라이언트 응답에서 제외.
 *
 * tartarus_ep1_loop.js getResult()가 호출.
 *
 * game_state 연결: action.js의 processGameAction이 쓴 accuse_history, dead_roles 등으로
 * game_over/outcome/winner_side/loser_side 판정. game_state 미존재 시 match 레벨 + 이벤트 기반 보완.
 *
 * 비밀 유지: hidden_host_role, role_private_notes는 기본 응답에 넣지 않음.
 */
const SECRET = process.env.TARTARUS_SECRET;
const { getOrCreateMatch, getRecentEvents, getRecentEventsForCurrentTurn, getEventsCount, getPublicEvents, formatEventForResponse } = require('./store');

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

/** game_state 기본값. action.js DEFAULT_GAME_STATE와 호환. */
const DEFAULT_GAME_STATE = {
  clues: [],
  pistol_holder: null,
  dead_roles: [],
  accuse_history: [],
  game_over: false,
  outcome: null,
  outcome_reason: null,
  winner_side: null,
  loser_side: null,
  winner: null,
  loser_reason: null
};

/** match.game_state를 안전하게 읽어 기본값과 병합. */
function getGameStateFromMatch(match) {
  if (!match || typeof match !== 'object') return { ...DEFAULT_GAME_STATE };
  const gs = match.game_state;
  if (!gs || typeof gs !== 'object') return { ...DEFAULT_GAME_STATE };
  return {
    clues: Array.isArray(gs.clues) ? gs.clues : DEFAULT_GAME_STATE.clues,
    pistol_holder: gs.pistol_holder ?? DEFAULT_GAME_STATE.pistol_holder,
    dead_roles: Array.isArray(gs.dead_roles) ? gs.dead_roles : DEFAULT_GAME_STATE.dead_roles,
    accuse_history: Array.isArray(gs.accuse_history) ? gs.accuse_history : DEFAULT_GAME_STATE.accuse_history,
    game_over: !!gs.game_over,
    outcome: gs.outcome ?? match.outcome ?? null,
    outcome_reason: gs.outcome_reason ?? gs.loser_reason ?? null,
    winner_side: gs.winner_side ?? (gs.winner ? String(gs.winner).toLowerCase() : null),
    loser_side: gs.loser_side ?? null,
    winner: gs.winner ?? null,
    loser_reason: gs.loser_reason ?? null
  };
}

/** 이벤트에서 마지막 ACCUSE와 dead_roles 추출 (game_state 없을 때 보완용). */
function deriveFromEvents(events) {
  const accuseHistory = [];
  const deadRoles = new Set();
  const deathActions = new Set(['SHOOT', 'KILL', 'DEATH']);
  for (const e of events || []) {
    const a = String(e.action || '').toUpperCase();
    const t = e.target ? String(e.target).trim().toLowerCase() : null;
    if (a === 'ACCUSE' && t) {
      accuseHistory.push({ turn: e.turn ?? 1, accuser: e.role, accused: t });
    }
    if (deathActions.has(a) && t) deadRoles.add(t);
  }
  return { accuse_history: accuseHistory, dead_roles: [...deadRoles] };
}

/**
 * 종료 판정 우선순위:
 * A. game_state.game_over === true 또는 match.game_over === true → 그대로 사용
 * B. accuse_history 마지막 항목으로 판정 가능 시 → outcome 계산
 * C. dead_roles 기준 (impostor/captain 사망 등) → outcome 계산
 */
function resolveOutcome(match, gameState, derived) {
  const hiddenHost = resolveImpostorFromMatch(match);
  const h = hiddenHost ? String(hiddenHost).toLowerCase() : null;

  // A. 이미 game_over면 game_state/match 값 우선 (match는 action.js persistPatch로 DB에 저장됨)
  const alreadyOver = gameState.game_over === true || !!match.game_over;
  if (alreadyOver) {
    const outcome = gameState.outcome ?? match.outcome ?? null;
    const winner = gameState.winner ?? gameState.winner_side ?? null;
    const loserReason = gameState.loser_reason ?? gameState.outcome_reason ?? null;
    let winner_side = gameState.winner_side ?? (winner ? String(winner).toLowerCase() : null);
    let loser_side = gameState.loser_side ?? null;
    if (!loser_side && winner_side) {
      loser_side = winner_side === 'crew' ? 'impostor' : 'crew';
    }
    if (!winner_side && outcome) {
      winner_side = outcome === 'crew_win' ? 'crew' : outcome === 'impostor_win' ? 'impostor' : null;
      loser_side = winner_side === 'crew' ? 'impostor' : winner_side === 'impostor' ? 'crew' : null;
    }
    return {
      game_over: true,
      outcome,
      outcome_reason: loserReason ?? (outcome === 'crew_win' ? 'impostor_accused' : outcome === 'impostor_win' ? 'accuse_failed' : null),
      winner_side,
      loser_side
    };
  }

  const acc = (gameState.accuse_history?.length > 0 ? gameState.accuse_history : derived?.accuse_history) ?? [];
  const dead = (gameState.dead_roles?.length > 0 ? gameState.dead_roles : derived?.dead_roles) ?? [];
  const lastAccuse = Array.isArray(acc) && acc.length > 0 ? acc[acc.length - 1] : null;

  // B. accuse_history 마지막 accuse로 판정 (hidden_host 필요)
  if (lastAccuse && lastAccuse.accused && h) {
    const correct = String(lastAccuse.accused).toLowerCase() === h;
    return {
      game_over: true,
      outcome: correct ? 'crew_win' : 'impostor_win',
      outcome_reason: correct ? 'impostor_accused' : 'accuse_failed',
      winner_side: correct ? 'crew' : 'impostor',
      loser_side: correct ? 'impostor' : 'crew'
    };
  }

  // C. dead_roles 기준 종료 (impostor 사망 → crew_win, captain 사망 → impostor_win 등)
  const deadLower = dead.map((r) => String(r).toLowerCase());
  if (h && deadLower.some((r) => r === h)) {
    return {
      game_over: true,
      outcome: 'crew_win',
      outcome_reason: 'impostor_killed',
      winner_side: 'crew',
      loser_side: 'impostor'
    };
  }
  if (deadLower.includes('captain')) {
    return {
      game_over: true,
      outcome: 'impostor_win',
      outcome_reason: 'captain_dead',
      winner_side: 'impostor',
      loser_side: 'crew'
    };
  }
  // 전원 사망 등 확장용 reason 구조 (나중에 추가 가능)
  // if (deadLower.length >= 4) { ... }

  return {
    game_over: false,
    outcome: null,
    outcome_reason: null,
    winner_side: null,
    loser_side: null
  };
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

  // game_state 읽기 및 종료 판정 연결 (game_state 미persist 시 이벤트 기반 보완)
  const gameState = getGameStateFromMatch(match);
  const allEvents = await getRecentEvents(matchId, 200);
  const derived = deriveFromEvents(allEvents);
  const resolved = resolveOutcome(match, gameState, derived);

  const safeResult = {
    debug_version: 'ep1-result-game-state-v3',
    match_id: match.match_id,
    game_over: resolved.game_over || !!match.game_over,
    outcome: resolved.outcome ?? match.outcome ?? null,
    turn: match.turn ?? 1,
    phase: match.phase ?? 'playing',
    location: match.location ?? 'bridge',
    public_events: Array.isArray(pub) ? pub : [],
    recent_events,
    events_count
  };
  if (resolved.outcome_reason != null) safeResult.outcome_reason = resolved.outcome_reason;
  if (resolved.winner_side != null) safeResult.winner_side = resolved.winner_side;
  if (resolved.loser_side != null) safeResult.loser_side = resolved.loser_side;

  const sanitized = removeAnswerFields(safeResult);
  if (safeResult.game_over === true) {
    sanitized.actual_imposter = resolveImpostorFromMatch(match);
  }
  return res.status(200).json(sanitized);
};

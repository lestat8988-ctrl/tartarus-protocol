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
  getRecentEventsForCurrentTurn,
  getEventsCount,
  getPublicEvents,
  normalizeRole,
  normalizeAction
} = require('./store');

const ROLE_KO = { captain: '함장', doctor: '의사', engineer: '엔지니어', navigator: '네비게이터', pilot: '파일럿' };
const TARGET_KO = { player: '함장', captain: '함장', doctor: '의사', engineer: '엔지니어', navigator: '네비게이터', pilot: '파일럿' };
const ROLE_SUBJECT_KO = { captain: '함장이', doctor: '의사가', engineer: '엔지니어가', navigator: '네비게이터가', pilot: '파일럿이' };

function subjectKo(role) {
  return ROLE_SUBJECT_KO[role] || (ROLE_KO[role] || role || '승무원') + '가';
}

const VALID_QUESTION_TARGETS = ['doctor', 'engineer', 'navigator', 'pilot', 'player', 'captain'];

function getValidQuestionTargetKo(role, target) {
  const raw = (target ?? '').toString().trim().toLowerCase();
  if (!raw) return null;
  if (raw === role) return null;
  if (!VALID_QUESTION_TARGETS.includes(raw)) return null;
  return TARGET_KO[raw] || null;
}

function makeReadableSummaryKo(role, action, target, dialogue) {
  const subj = subjectKo(role);
  const r = ROLE_KO[role] || role || '승무원';
  const a = String(action || 'WAIT').toUpperCase();
  const tQuestion = getValidQuestionTargetKo(role, target);
  const tAccuse = target ? (TARGET_KO[String(target).toLowerCase()] || target) : null;

  switch (a) {
    case 'QUESTION':
      if (role === 'navigator') return tQuestion ? `네비게이터가 ${tQuestion}에게 동선을 추궁했다.` : '네비게이터가 동선을 추궁했다.';
      if (role === 'doctor') return tQuestion ? `의사가 ${tQuestion}에게 확인을 요청했다.` : '의사가 확인을 요청했다.';
      if (role === 'engineer') return tQuestion ? `엔지니어가 ${tQuestion}에게 기술적 질문을 했다.` : '엔지니어가 질문했다.';
      if (role === 'pilot') return tQuestion ? `파일럿이 ${tQuestion}에게 공기 변화에 대해 물었다.` : '파일럿이 공기 변화에 대해 물었다.';
      return tQuestion ? `${subj} ${tQuestion}에게 질문했다.` : `${subj} 질문했다.`;
    case 'OBSERVE':
      if (role === 'captain') return '함장이 브리지를 살폈다.';
      if (role === 'doctor') return '의사가 승무원들의 반응을 관찰했다.';
      if (role === 'engineer') return '엔지니어가 시스템 상태를 점검했다.';
      if (role === 'navigator') return '네비게이터가 상황을 살폈다.';
      if (role === 'pilot') return '파일럿이 브리지의 분위기 변화를 살폈다.';
      return `${subj} 상황을 관찰했다.`;
    case 'CHECK_LOG':
      if (role === 'engineer') return '엔지니어가 시스템 로그를 확인했다.';
      return `${subj} 기록을 확인했다.`;
    case 'REPAIR':
      if (role === 'engineer') return '엔지니어가 장비를 점검했다.';
      return `${subj} 수리를 진행했다.`;
    case 'ACCUSE':
      return tAccuse ? `${subj} ${tAccuse}를 고발했다.` : `${subj} 고발했다.`;
    case 'WAIT':
      if (role === 'pilot') return '파일럿이 대기하며 분위기를 살폈다.';
      return `${subj} 대기했다.`;
    default:
      break;
  }
  if (tQuestion) return `${subj} ${tQuestion}에게 ${a.toLowerCase()}했다.`;
  const d = (dialogue || '').slice(0, 40);
  return d ? `${r}: ${d}${d.length >= 40 ? '...' : ''}` : `${subj} 행동했다.`;
}

function summaryFallbackKo(role, action) {
  const subj = subjectKo(role);
  const a = String(action || 'WAIT').toUpperCase();
  const actKo = { QUESTION: '질문', OBSERVE: '관찰', CHECK_LOG: '로그 확인', REPAIR: '수리', ACCUSE: '고발', WAIT: '대기' }[a] || '행동';
  return `${subj} ${actKo}했다.`;
}

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

  const readableSummary = makeReadableSummaryKo(role, action, payload.target, payload.dialogue);
  const serverResult = { summary: readableSummary, event_type: getEventType(action) };

  const ok = await appendEvent(matchId, payload, readableSummary, serverResult);
  if (!ok) {
    return errRes(res, 500, 'Failed to append event');
  }

  const updatedMatch = await getOrCreateMatch(matchId);
  const pub = await getPublicEvents(matchId);
  const recentRaw = await getRecentEventsForCurrentTurn(matchId);
  const recent_events = recentRaw.map((e) => ({
    turn: e.turn,
    actor: e.actor,
    role: e.role,
    action: e.action,
    summary: e.server_result?.summary || summaryFallbackKo(e.role, e.action)
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

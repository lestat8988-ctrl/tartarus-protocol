/**
 * api/ep1/action.js - 1편 전용 행동 제출 API (Supabase)
 * POST body: { match_id, turn, actor, role, action, target?, reason?, dialogue? }
 * returns: { ok, server_result, next_state, game_over, outcome }
 *
 * tartarus_ep1_loop.js submitAction()가 호출.
 * game_over / outcome 반환 시 루프 즉시 중단.
 *
 * Captain dialogue 우선순위: dialogue > text > command > input > fallback. 실제 입력 있으면 fallback 사용 안 함.
 *
 * Crew dialogue 우선순위:
 * 1. req.body에 실제 LLM 생성 결과(dialogue/reason/target) 있으면 우선 사용
 * 2. 비어 있으면 여기서 LLM 생성 시도 (재시도 1회)
 * 3. 실패 시에만 role별 fallback 사용
 *
 * summary vs dialogue 분리:
 * - summary: action/role 기반 helper로 public_events용. dialogue를 덮어쓰지 않음.
 * - dialogue: 실제 생성값 또는 fallback. 빈 문자열 저장 금지.
 *
 * TODO: clue resolution, accuse resolution, pistol/fire resolution, death/win-loss resolution, hidden truth
 */
const SECRET = process.env.TARTARUS_SECRET;
const {
  getOrCreateMatch,
  getMatch,
  appendEvent,
  getRecentEventsForCurrentTurn,
  getEventsCount,
  getPublicEvents,
  formatEventForResponse,
  normalizeRole,
  normalizeAction,
  getPrivateContextForRole
} = require('./store');

const ROLE_KO = { captain: '함장', doctor: '의사', engineer: '엔지니어', navigator: '네비게이터', pilot: '파일럿' };
const TARGET_KO = { player: '함장', captain: '함장', doctor: '의사', engineer: '엔지니어', navigator: '네비게이터', pilot: '파일럿' };
const ROLE_SUBJECT_KO = { captain: '함장이', doctor: '의사가', engineer: '엔지니어가', navigator: '네비게이터가', pilot: '파일럿이' };

const VALID_TARGETS = new Set(['player', 'doctor', 'engineer', 'navigator', 'pilot', 'captain']);
const VALID_ACTIONS = new Set(['QUESTION', 'OBSERVE', 'CHECK_LOG', 'REPAIR', 'ACCUSE', 'WAIT']);

const CREW_DIALOGUE_FALLBACK_KO = {
  doctor: '승무원들의 반응을 먼저 살펴보겠습니다.',
  engineer: '시스템 상태와 로그를 다시 확인해 보겠습니다.',
  navigator: '각자의 위치와 동선을 다시 짚어보겠습니다.',
  pilot: '브리지의 분위기와 변화를 다시 느껴보겠습니다.'
};

const CAPTAIN_DIALOGUE_FALLBACK_KO = '브리지 상황을 확인한다.';

const CREW_ROLES = new Set(['doctor', 'engineer', 'navigator', 'pilot']);

const LLM_SYSTEM_BASE = `You are an AI crew member aboard a ship. Respond in character. Korean only.
Output JSON: {"action":"QUESTION|OBSERVE|CHECK_LOG|REPAIR|ACCUSE|WAIT","target":"player"|"doctor"|"engineer"|"navigator"|"pilot"|null,"reason":"한국어 이유","dialogue":"한국어 1~3문장 대사"}
dialogue: required, in-character speech.`;

const ROLE_PROMPTS = {
  doctor: 'Role: Doctor. 말투 차분·정확. 생체반응·지연·불일치 근거로 묻는다. QUESTION/OBSERVE 균형.',
  engineer: 'Role: Engineer. 말투 건조·직설. 로그·시스템·기록 중심. CHECK_LOG 우선.',
  navigator: 'Role: Navigator. 말투 날카로움. 동선·시간·위치 추궁. QUESTION 우선.',
  pilot: 'Role: Pilot. 말투 직감적. 분위기·공기·침묵 감지. OBSERVE+QUESTION.'
};

function isEmptyDialogue(s) {
  if (s == null) return true;
  if (typeof s !== 'string') return true;
  return s.trim() === '';
}

function isPredominantlyEnglish(text) {
  if (!text || typeof text !== 'string' || text.length < 3) return false;
  const hasKo = /[가-힣]/.test(text);
  if (hasKo) return false;
  const alphaRatio = (text.match(/[a-zA-Z]/g) || []).length / Math.max(1, text.length);
  return alphaRatio > 0.5;
}

function looksLikeEnglishTestString(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 10) return false;
  const lower = t.toLowerCase();
  if (/witnessed the murder of|identity code|\[witness\]|\[auto-kill\]/i.test(lower)) return true;
  if (/engineer.*navigator|navigator.*engineer|doctor.*pilot/i.test(lower)) return true;
  const alphaRatio = (t.match(/[a-zA-Z]/g) || []).length / Math.max(1, t.length);
  const hasKo = /[가-힣]/.test(t);
  return alphaRatio > 0.7 && !hasKo;
}

// captain dialogue 우선순위: dialogue > text > command > input > message. 하나라도 non-empty면 fallback 사용 안 함.
function getCaptainDialogueFromBody(body) {
  const candidates = [
    body.dialogue,
    body.text,
    body.command,
    body.input,
    body.message
  ].filter((x) => x != null && typeof x === 'string' && x.trim() !== '');
  const raw = candidates[0] ? String(candidates[0]).trim() : '';
  if (isEmptyDialogue(raw)) return null;
  if (looksLikeEnglishTestString(raw)) return null;
  return raw;
}

function truncateDialogue(s, max = 300) {
  if (!s || typeof s !== 'string') return '';
  return String(s).trim().slice(0, max);
}

function parseAndValidateCrewLLM(content, role) {
  if (!content || typeof content !== 'string') return null;
  try {
    const cleaned = content.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1').trim();
    const parsed = JSON.parse(cleaned);
    let action = String(parsed.action ?? '').trim().toUpperCase();
    if (!action || !VALID_ACTIONS.has(action)) action = 'OBSERVE';
    let target = parsed.target != null ? String(parsed.target).trim().toLowerCase() || null : null;
    if (target && !VALID_TARGETS.has(target)) target = null;
    if (target && target === role) target = null;
    let reason = parsed.reason != null ? String(parsed.reason).trim().slice(0, 120) : null;
    let dialogue = parsed.dialogue != null ? String(parsed.dialogue).trim() : '';
    dialogue = truncateDialogue(dialogue) || null;
    if (!dialogue || isPredominantlyEnglish(dialogue) || isPredominantlyEnglish(reason)) return null;
    return { action, target, reason: reason || '상황을 파악 중이다.', dialogue };
  } catch {
    return null;
  }
}

async function generateCrewDialogueLLM(matchId, role, observation) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || '10000', 10);
  if (!apiKey) return null;

  const systemContent = `${LLM_SYSTEM_BASE}\n\n${ROLE_PROMPTS[role] || ''}`;
  const obsJson = JSON.stringify(observation).slice(0, 1600);
  const userContent = `Observation:\n${obsJson}\n\n반드시 한국어로만 답하라. dialogue와 reason은 한국어 필수.\nRespond with JSON only: {"action":"...","target":null|"...","reason":"...","dialogue":"..."}`;

  const url = `${baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 300
      })
    });
    clearTimeout(timeoutId);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    const content = data?.choices?.[0]?.message?.content || '';
    return parseAndValidateCrewLLM(content, role);
  } catch {
    clearTimeout(timeoutId);
    return null;
  }
}

async function resolveCrewPayloadWithLLM(matchId, body, role) {
  const rawDialogue = body.dialogue ?? body.command ?? body.input ?? body.text ?? '';
  const s = (rawDialogue != null && typeof rawDialogue === 'string') ? String(rawDialogue).trim() : '';

  if (!isEmptyDialogue(s) && !looksLikeEnglishTestString(s)) {
    return {
      action: normalizeAction(body.action),
      target: body.target ?? null,
      reason: body.reason ?? null,
      dialogue: s
    };
  }

  const match = await getMatch(matchId);
  if (!match) return null;

  const recentRaw = await getRecentEventsForCurrentTurn(matchId);
  const captainEv = (recentRaw || []).find((e) => e.role === 'captain');
  const observation = {
    match_id: matchId,
    turn: match.turn ?? 1,
    captain_action: captainEv ? { action: captainEv.action, target: captainEv.target, dialogue: captainEv.dialogue } : {},
    recentEvents: (recentRaw || []).map((e) => ({ role: e.role, action: e.action, dialogue: (e.dialogue || '').slice(0, 80) })),
    your_role: role
  };
  const privateCtx = getPrivateContextForRole(match, role);
  if (privateCtx) observation.private_context = privateCtx;

  // 여기서 LLM 생성 시도
  let result = await generateCrewDialogueLLM(matchId, role, observation);
  if (!result) {
    await new Promise((r) => setTimeout(r, 500));
    result = await generateCrewDialogueLLM(matchId, role, observation);
  }
  if (result) {
    return {
      action: result.action,
      target: result.target,
      reason: result.reason,
      dialogue: result.dialogue
    };
  }

  // 실패 시 fallback
  return {
    action: normalizeAction(body.action),
    target: body.target ?? null,
    reason: body.reason ?? '상황을 파악 중이다.',
    dialogue: CREW_DIALOGUE_FALLBACK_KO[role] || '상황을 확인하겠습니다.'
  };
}

async function resolvePayloadForCrew(matchId, body, role) {
  const resolved = await resolveCrewPayloadWithLLM(matchId, body, role);
  return resolved || {
    action: normalizeAction(body.action),
    target: body.target ?? null,
    reason: body.reason ?? '상황을 파악 중이다.',
    dialogue: CREW_DIALOGUE_FALLBACK_KO[role] || '상황을 확인하겠습니다.'
  };
}

function resolveDialogueForPayload(body, role) {
  const raw = body.dialogue ?? body.command ?? body.input ?? body.text ?? body.message ?? '';
  const s = (raw != null && typeof raw === 'string') ? String(raw).trim() : '';

  if (role === 'captain') {
    const captainDialogue = getCaptainDialogueFromBody(body);
    if (captainDialogue) return captainDialogue;
    if (looksLikeEnglishTestString(s)) return CAPTAIN_DIALOGUE_FALLBACK_KO;
    return isEmptyDialogue(s) ? CAPTAIN_DIALOGUE_FALLBACK_KO : s;
  }

  if (CREW_ROLES.has(role)) {
    if (!isEmptyDialogue(s) && !looksLikeEnglishTestString(s)) return s;
    return CREW_DIALOGUE_FALLBACK_KO[role] || '상황을 확인하겠습니다.';
  }

  if (!isEmptyDialogue(s) && !looksLikeEnglishTestString(s)) return s;
  return '상황을 확인하겠습니다.';
}

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
  let action = normalizeAction(body.action);
  let target = body.target ?? null;
  let reason = body.reason ?? null;
  let dialogue = null;

  const match = await getOrCreateMatch(matchId);
  if (!match) {
    return errRes(res, 500, 'Failed to get or create match');
  }

  if (role === 'captain') {
    // captain dialogue 우선순위: dialogue > text > command > input > fallback. 실제 입력 있으면 fallback 사용 안 함.
    dialogue = resolveDialogueForPayload(body, role);
    dialogue = dialogue || CAPTAIN_DIALOGUE_FALLBACK_KO;
    const rawInput = [body.dialogue, body.text, body.command, body.input].find((x) => x != null && typeof x === 'string' && String(x).trim() !== '');
    const isLegacyReason = reason === 'auto_kill' || reason === 'witness';
    const isRealUserInput = rawInput && !/^\[AUTO-KILL\]|^\[WITNESS\]/i.test(String(rawInput).trim());
    if (isLegacyReason && isRealUserInput) reason = 'player_input';
  } else if (CREW_ROLES.has(role)) {
    const crewResolved = await resolvePayloadForCrew(matchId, body, role);
    action = crewResolved.action;
    target = crewResolved.target;
    reason = crewResolved.reason;
    dialogue = crewResolved.dialogue || CREW_DIALOGUE_FALLBACK_KO[role] || '상황을 확인하겠습니다.';
  } else {
    dialogue = resolveDialogueForPayload(body, role) || '상황을 확인하겠습니다.';
  }

  const payload = {
    actor: body.actor ?? null,
    role,
    action,
    target,
    reason,
    dialogue: dialogue || '상황을 확인하겠습니다.'
  };

  const readableSummary = makeReadableSummaryKo(role, action, payload.target, payload.dialogue);
  const serverResult = { summary: readableSummary, event_type: getEventType(action) };

  const ok = await appendEvent(matchId, payload, readableSummary, serverResult);
  if (!ok) {
    return errRes(res, 500, 'Failed to append event');
  }

  const updatedMatch = await getOrCreateMatch(matchId);
  const pub = await getPublicEvents(matchId);
  const recentRaw = await getRecentEventsForCurrentTurn(matchId);
  const recent_events = recentRaw.map((e) => {
    const base = formatEventForResponse(e);
    if (base && !base.summary) base.summary = summaryFallbackKo(e.role, e.action);
    return base;
  }).filter(Boolean);
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

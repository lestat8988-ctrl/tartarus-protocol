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
 * 1. req.body에 유효한 dialogue 있으면 그대로 사용
 * 2. 비어 있으면 서버에서 LLM 생성 (OPENAI_API_KEY 필요, 재시도 1회)
 * 3. LLM 실패 시에만 role별 fallback 4문장 사용
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
  updateMatch,
  getRecentEvents,
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

/** 게임 규칙 엔진용 액션 (뼈대). result.js에서 판정 연결 예정. */
const GAME_ACTIONS = new Set(['ACCUSE', 'TAKE_CLUE', 'FIND_CLUE', 'TAKE_PISTOL', 'USE_PISTOL', 'SHOOT', 'KILL', 'DEATH']);

/** match/state 레벨 게임 상태 기본값. 없으면 안전 초기화. */
const DEFAULT_GAME_STATE = {
  clues: [],
  pistol_holder: null,
  dead_roles: [],
  accuse_history: [],
  game_over: false,
  outcome: null,
  winner: null,
  loser_reason: null
};

const CREW_DIALOGUE_FALLBACK_KO = {
  doctor: '표정과 호흡을 확인 중입니다. 이상 징후가 있으면 보고하겠습니다.',
  engineer: '기록 끊김과 접근 로그를 확인 중입니다. 불일치가 있으면 짚겠습니다.',
  navigator: '그 시간대 동선부터 다시 말해봐. 알리바이가 비어 있다.',
  pilot: '그때 공기가 달라졌어. 네가 뭘 봤는지 숨기고 있는 것 같아.'
};

/** role + captain_action별 action-aware fallback. generic placeholder 대신 맥락 있는 1~2문장. 누구/무엇/왜 중 2개 이상 포함. */
const ACTION_AWARE_FALLBACKS = {
  CHECK_LOG: {
    doctor: ['로그에서 누가 불안정해 보이는지 확인하겠습니다. 반응이 어색한 구간을 짚어보겠습니다.', '기록상 이상 반응·상태 변화를 살펴보겠습니다. 누가 긴장을 숨기는지 봅니다.'],
    engineer: ['기록이 끊긴 구간이 있는지 먼저 보겠습니다. 누군가 접근 권한을 썼을 수도 있습니다.', 'CCTV·엔진실 로그에 비정상 기록이 있는지 확인합니다. 불일치가 있으면 짚겠습니다.'],
    navigator: ['로그에서 동선이 빠진 시간대를 찾겠습니다. 알리바이가 비어 있을 수 있습니다.', '위치 공백과 동선 누락을 확인 중입니다. 빈 시간대가 있으면 바로 짚겠습니다.'],
    pilot: ['로그 확인 중에도 공기가 이상합니다. 누군가 긴장을 숨기고 있는 느낌입니다.', '기록을 보는 동안 불길한 조짐이 느껴집니다. 기류 변화가 수상합니다.']
  },
  QUESTION: {
    doctor: ['방금 표정이 굳었습니다. 그 시간대에 무슨 일이 있었는지 말해 주세요.', '호흡과 떨림이 이상합니다. 그때 어디 있었는지 구체적으로 말해봐.', '대상의 반응이 지연됐습니다. 긴장 상태가 드러나고 있어.'],
    engineer: ['기록과 네 말이 맞지 않아. 그 시간대 접근 로그를 보여줘.', '장비 로그로 교차 검증이 필요합니다. 불일치하는 부분을 짚겠습니다.', '시스템 기록과 네 동선이 어긋납니다. 다시 말해봐.'],
    navigator: ['그 시간대 동선부터 다시 말해봐. 알리바이가 비어 있다.', '그때 어디 있었어? 위치가 비어 있어. 구체적으로 말해.', '동선에 빈틈이 있어. 그 시간대를 채워봐.'],
    pilot: ['그때 공기가 달라졌어. 네가 뭘 봤는지 숨기고 있는 것 같아.', '분위기가 이상해. 직감적으로 뭔가 숨기고 있어.', '침묵이 너무 길었어. 시선이 흔들렸어.']
  },
  OBSERVE: {
    doctor: ['승무원들의 표정과 반응을 관찰했습니다. 이상한 점이 있으면 말하겠습니다.', '생체 반응을 확인 중입니다. 누가 긴장하는지 살펴보겠습니다.'],
    engineer: ['시스템 상태를 점검했습니다. 비정상 기록이 보이면 보고하겠습니다.', '로그와 장비 기록을 확인 중입니다. 끊긴 구간이 있으면 짚겠습니다.'],
    navigator: ['동선을 확인했습니다. 빈틈이 보이면 바로 짚겠습니다.', '시간대와 위치를 짚어보겠습니다. 알리바이 공백이 있으면 말하겠습니다.'],
    pilot: ['브리지 공기가 가라앉아 있습니다. 누군가 긴장을 숨기는 느낌입니다.', '분위기 변화를 감지했습니다. 이상 징후가 있으면 말하겠습니다.']
  },
  REPAIR: {
    doctor: ['장비 점검 중 승무원 상태도 함께 확인하겠습니다.', '수리 진행 중 반응과 표정을 살펴보겠습니다.'],
    engineer: ['장비를 점검 중입니다. 오류나 변조 흔적이 있는지 확인하겠습니다.', '점검 중 로그와 기록을 교차 확인합니다.'],
    navigator: ['수리 진행 중 동선과 시간대를 짚어보겠습니다.', '점검하는 동안 동선 빈틈을 확인하겠습니다.'],
    pilot: ['점검하는 동안 분위기 변화를 살펴보겠습니다.', '수리 중 공기와 기류를 감지하겠습니다.']
  },
  WAIT: {
    doctor: ['대기하며 승무원들의 미세한 반응을 관찰하겠습니다.', '대기 중 표정과 호흡을 확인하겠습니다.'],
    engineer: ['대기하며 로그와 기록을 재확인하겠습니다.', '대기 중 끊긴 구간을 다시 확인합니다.'],
    navigator: ['대기하며 동선과 알리바이를 다시 짚어보겠습니다.', '대기 중 빈 시간대를 확인하겠습니다.'],
    pilot: ['대기하며 공기와 분위기 변화를 감지하겠습니다.', '대기 중 이상 징후를 살펴보겠습니다.']
  },
  ACCUSE: {
    doctor: ['처형 결정에 앞서 대상의 반응과 상태를 마지막으로 확인하겠습니다.', '대상의 표정을 마지막으로 확인합니다.'],
    engineer: ['처형 전 기록과 로그를 한 번 더 확인하겠습니다.', '마지막으로 불일치를 확인합니다.'],
    navigator: ['처형 결정에 동의합니다. 동선상 빈틈이 있었습니다.', '동선상 의심스러운 부분이 있었어.'],
    pilot: ['공기가 더욱 무거워졌습니다. 처형이 맞는지 직감이 말합니다.', '분위기가 처형을 요구하고 있어.']
  }
};

function getCrewFallbackByRoleAndAction(role, captainAction, turnNum = 1) {
  const act = (captainAction || 'OBSERVE').toUpperCase();
  const map = ACTION_AWARE_FALLBACKS[act] || ACTION_AWARE_FALLBACKS.OBSERVE;
  const arr = map[role];
  if (Array.isArray(arr) && arr.length > 0) {
    const idx = (turnNum + (role || '').length) % arr.length;
    return arr[idx];
  }
  if (typeof map[role] === 'string') return map[role];
  return CREW_DIALOGUE_FALLBACK_KO[role] || '상황을 확인하겠습니다.';
}

/** QUESTION 액션 전용: captain 지목 대상에 첫 초점을 맞춘 role별 fallback. */
function getQuestionTargetFocusedFallback(role, targetRoleKo) {
  const t = (targetRoleKo || '대상').toString().trim();
  const byRole = {
    doctor: `${t}의 표정과 호흡을 보니 긴장이 보입니다. 그 시간대에 무슨 일이 있었는지 말해 주세요.`,
    engineer: `${t} 관련 기록과 로그를 확인 중입니다. 불일치가 있으면 짚겠습니다.`,
    navigator: `${t}, 그 시간대 동선부터 다시 말해봐. 알리바이가 비어 있어.`,
    pilot: `${t} 쪽 공기가 달라졌어. 뭘 숨기고 있는 것 같아.`
  };
  return byRole[role] || `${t}에 대한 반응을 확인 중입니다.`;
}

/** dialogue 첫 절(약 50자)에 targetRoleKo가 포함되어 있는지. QUESTION 초점 검사용. */
function doesDialogueFocusOnTarget(dialogue, targetRoleKo) {
  if (!dialogue || typeof dialogue !== 'string') return false;
  if (!targetRoleKo || typeof targetRoleKo !== 'string') return true;
  const head = String(dialogue).trim().slice(0, 55);
  const t = String(targetRoleKo).trim();
  return head.indexOf(t) >= 0;
}

const GENERIC_PLACEHOLDER_PATTERNS = [
  /^반응을\s*살펴보겠습니다\.?$/,
  /^로그\s*(를\s*)?확인\s*중입니다\.?$/,
  /^동선을\s*짚어보겠습니다\.?$/,
  /^분위기가\s*이상합니다\.?$/,
  /^기류가\s*불안정합니다\.?$/,
  /^이상\s*징후가\s*있습니다\.?$/,
  /^상황을\s*확인하겠습니다\.?$/,
  /^상황을\s*파악\s*중입니다\.?$/,
  /^로그\s*확인\s*중\.?$/,
  /^기록\s*확인\s*중\.?$/,
  /^동선\s*확인\s*중\.?$/
];

function isGenericPlaceholderDialogue(s) {
  if (!s || typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 5 || t.length > 70) return false;
  return GENERIC_PLACEHOLDER_PATTERNS.some((re) => re.test(t));
}

const CAPTAIN_DIALOGUE_FALLBACK_KO = '브리지 상황을 확인한다.';

const CREW_ROLES = new Set(['doctor', 'engineer', 'navigator', 'pilot']);

const LLM_SYSTEM_BASE = `You are an AI crew member aboard a ship. Respond in character. Korean only.
Output JSON: {"action":"QUESTION|OBSERVE|CHECK_LOG|REPAIR|ACCUSE|WAIT","target":"player"|"doctor"|"engineer"|"navigator"|"pilot"|null,"reason":"한국어 이유(짧게)","dialogue":"한국어 1~2문장 대사"}
규칙: dialogue는 1~2문장, 120자 안쪽. 장황한 설명·긴 문장 금지. reason도 짧고 선명하게.`;

const ROLE_PROMPTS = {
  doctor: `Role: Doctor. 차분하고 짧게 말한다. QUESTION일 때: 대상의 표정·떨림·호흡·긴장 상태를 구체적으로 짚고 확인 요청. "상태가 이상하다"보다 "방금 표정이 굳었어", "호흡이 빨라졌어" 식으로. CHECK_LOG일 때: 로그가 의미하는 "누가 불안정한가·반응이 왜 어색한가"에 연결. dialogue: 1~2문장, 120자 이내.`,
  engineer: `Role: Engineer. 건조하고 직설적으로 말한다. QUESTION일 때: 시간 기록·시스템 로그·접근 기록·장비 상태를 근거로 의심. 기록 불일치·로그 근거를 들게. CHECK_LOG일 때: 로그·기록·불일치·오류를 가장 직접적으로 해석. dialogue: 1~2문장, 120자 이내.`,
  navigator: `Role: Navigator. 날카롭고 공격적으로 말한다. QUESTION일 때: 시간·위치·동선·알리바이 빈틈을 직접 추궁. 가장 압박감 있는 질문 담당. CHECK_LOG일 때: 로그의 빈 시간대·위치 공백·동선 누락을 물고 늘어짐. dialogue: 1~2문장, 120자 이내.`,
  pilot: `Role: Pilot. 분위기·침묵·시선·공기 변화·직감적 불안 중심. QUESTION일 때: 증거보다 감각·정서적 이상 징후로 압박. CHECK_LOG일 때: 로그 확인 중 드러나는 이상한 조짐·기류 변화·불길함. dialogue: 1~2문장, 120자 이내.`
};

/** impostor일 때 role별 행동 규칙 (자백 금지, target은 자기 제외, 시선 돌리기·역공·흐리기) */
const IMPOSTOR_BEHAVIOR = {
  doctor: '생체·심리 상태를 핑계로 타인의 불안·반응을 과장한다. "상태가 이상하다", "반응이 부자연스럽다" 식으로 유도. 직접 단정은 피하고 시선을 다른 사람에게 돌린다. target은 반드시 자신(doctor)이 아닌 다른 role로.',
  engineer: '로그·기록·오류·센서 탓으로 사실을 기술적 문제처럼 흐린다. CHECK_LOG를 방패처럼 사용. 사람 심문보다 기계로 몰아감. target은 반드시 자신(engineer)이 아닌 다른 role로.',
  navigator: '동선·시간·위치의 빈틈을 집요하게 물고 늘어짐. 논리적 추궁처럼 보이지만 실제로는 시선을 특정 타깃으로 몰아감. 질문을 질문으로 되받기. target은 반드시 자신(navigator)이 아닌 다른 role로.',
  pilot: '분위기·압박감·직감·불길함을 키운다. 명확한 증거 대신 감정적 불안과 공기 자체를 흔든다. 애매한 표현으로 확정 회피. target은 반드시 자신(pilot)이 아닌 다른 role로.'
};

/** impostor 공통 규칙 */
const IMPOSTOR_RULES = '자기에게 의심이 오지 않게 한다. 질문을 질문으로 되받기. 시선을 다른 사람에게 돌리기. 애매한 표현으로 확정 회피. 불안·의심을 다른 방향으로 증폭. 자신은 관찰자인 척하면서 프레임 유도. 노골적 자백 금지. 너무 완벽한 추론 피함. innocent보다 방어적·비틀린 reasoning.';

/** innocent일 때 행동 규칙 */
const INNOCENT_BEHAVIOR = '직선적이고 관찰형. 본인이 본 것·확인한 것·느낀 이상 징후를 비교적 정직하게 말한다. 억지 변명·과잉 방어·과한 남 탓 없음. 정보 전달이 정직하게 느껴지게. 스트레스는 있어도 정보 중심.';

/** turn 1 impostor: 선제 방어/시선 분산 */
const FIRST_TURN_IMPOSTOR = 'turn 1이면 선제적으로 방어하거나 시선을 분산시킨다. 먼저 다른 이의 이상함을 언급하거나, 로그/동선/분위기로 화제를 돌린다.';

/** turn 1 innocent: role 근거 중심 관찰 */
const FIRST_TURN_INNOCENT = 'turn 1이면 자기 role 특성에 맞는 관찰을 담백하게 한다. 불필요한 추측 없이 보이는 것·확인한 것만 말한다.';

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
  const out = parseAndValidateCrewLLMWithDebug(content, role);
  return out.result;
}

function parseAndValidateCrewLLMWithDebug(content, role) {
  if (!content || typeof content !== 'string') return { result: null, errorCode: 'empty_response' };
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
    if (!dialogue) return { result: null, errorCode: 'empty_dialogue' };
    if (isPredominantlyEnglish(dialogue) || isPredominantlyEnglish(reason)) return { result: null, errorCode: 'safety_fallback' };
    return { result: { action, target, reason: reason || '상황을 파악 중이다.', dialogue }, errorCode: null };
  } catch {
    return { result: null, errorCode: 'invalid_json' };
  }
}

async function generateCrewDialogueLLM(matchId, role, observation) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
  const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS || '10000', 10);
  if (!apiKey) return { result: null, errorCode: 'missing_openai_key', errorMessage: 'OPENAI_API_KEY not set' };

  const capAct = observation.captain_action || {};
  const capActionType = (capAct.action || 'OBSERVE').toUpperCase();
  const ACTION_CONTEXT_HINTS = {
    CHECK_LOG: '함장이 로그 확인을 지시함. doctor: 로그가 의미하는 "누가 불안정한가·반응이 왜 어색한가"에 연결. engineer: 로그·기록·불일치·오류를 가장 직접적으로 해석. navigator: 로그의 빈 시간대·위치 공백·동선 누락을 물고 늘어짐. pilot: 로그 확인 중 드러나는 이상한 조짐·기류 변화·불길함.',
    QUESTION: '함장이 특정 승무원을 심문함. [필수] 첫 문장은 captain이 지목한 대상(current_question_target)에 대한 반응으로 시작. doctor: 그 대상의 표정·떨림·호흡·긴장을 구체적으로 짚고 확인 요청. engineer: 그 대상 관련 기록·불일치·장비 로그를 근거로 의심. navigator: 그 대상의 시간·위치·동선·알리바이 빈틈을 직접 추궁. pilot: 그 대상 쪽 분위기·침묵·시선·공기 변화·직감적 불안으로 압박. 제3자로 초점 튀면 안 됨.',
    OBSERVE: '함장이 관찰·자유 입력. captain_action.dialogue가 있으면 그 맥락을 각 role 관점으로 해석. 똑같은 질문을 role만 바꿔 말하는 느낌 금지. doctor는 생체·표정, engineer는 로그·기록, navigator는 동선·시간, pilot는 분위기·감각으로 다르게 답하라.',
    REPAIR: '함장이 수리·점검 지시. 각 role이 자기 관점에서 장비·상태·동선·분위기를 언급.',
    WAIT: '대기 상황. 각 role이 자기 관점에서 관찰·확인할 것을 짧게.',
    ACCUSE: '함장이 처형을 지시함. 각 role이 자기 관점에서 마지막 확인·동의·직감을 짧게.'
  };
  const actionContextHint = ACTION_CONTEXT_HINTS[capActionType] || ACTION_CONTEXT_HINTS.OBSERVE;

  const targetDiversifyNote = observation.target_diversification_hint
    ? `\n\n[질문 대상 다양화] ${observation.target_diversification_hint}`
    : '';
  const questionFocusNote =
    capActionType === 'QUESTION' && observation.question_focus_rule
      ? `\n\n[QUESTION 필수] ${observation.question_focus_rule} current_question_target(${observation.current_question_target_role_ko || observation.current_question_target})에 대한 반응으로 첫 문장을 시작하라. 제3자(의사/엔지니어/네비게이터/파일럿 중 captain 지목 대상이 아닌 사람)로 초점이 튀면 안 됨.`
      : '';
  const systemContent = `${LLM_SYSTEM_BASE}\n\n${ROLE_PROMPTS[role] || ''}\n\n[태도 규칙] observation의 am_i_hidden_host, behavior_rules, suspicion_style, first_turn_hint를 반드시 따른다. am_i_hidden_host가 true면 redirect_deflect_evade(회피·유도·방어·시선 분산). false면 direct_observation(직선·관찰·정보 제공). target이 있으면 am_i_hidden_host일 때 자신(your_role)이 아닌 다른 role을 지목한다.\n\n[액션 맥락] 현재 함장 행동: ${capActionType}. ${actionContextHint}${targetDiversifyNote}${questionFocusNote}\n\n[금지] "반응을 살펴보겠습니다", "로그 확인 중입니다", "동선을 짚어보겠습니다", "분위기가 이상합니다", "기류가 불안정합니다", "이상 징후가 있습니다" 같은 generic 상투문구 금지. 최소한 누구/무엇/왜 중 2개 이상이 들어간 구체적 문장으로. 같은 턴 안에서 같은 표현 연속 반복 금지.`;
  const obsJson = JSON.stringify(observation).slice(0, 2000);
  const roleActionHint = {
    doctor: 'action: QUESTION 또는 OBSERVE.',
    engineer: 'action: CHECK_LOG 또는 OBSERVE.',
    navigator: 'action: QUESTION 우선.',
    pilot: 'action: OBSERVE 또는 QUESTION.'
  }[role] || '';
  const questionFocusUser =
    capActionType === 'QUESTION' && observation.current_question_target_role_ko
      ? ` 첫 문장은 반드시${observation.current_question_target_role_ko}에 대한 반응으로 시작. 제3자로 초점 튀면 안 됨.`
      : '';
  const userContent = `Observation:\n${obsJson}\n\n한국어만. dialogue 1~2문장·120자 이내. reason 짧고 선명하게. behavior_rules와 first_turn_hint를 강하게 반영. captain_action(${capActionType}) 맥락을 반드시 반영. QUESTION/CHECK_LOG/OBSERVE에 따라 반응 결을 다르게. am_i_hidden_host가 true면 회피적·유도적·방어적·남 탓 유도형. false면 직선적·관찰형·정보 제공형. generic 상투문구("반응을 살펴보겠습니다","로그 확인 중입니다","분위기가 이상합니다" 등) 절대 금지. 누구/무엇/왜 중 2개 이상 포함. target_diversification_hint와 dead_crew 있으면 반드시 따르라.${questionFocusUser}${roleActionHint ? ' ' + roleActionHint : ''}\nJSON: {"action":"...","target":null|"...","reason":"...","dialogue":"..."}`;

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
        temperature: 0.35,
        max_tokens: 180
      })
    });
    clearTimeout(timeoutId);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = data?.error?.message || data?.message || `HTTP ${res.status}`;
      return { result: null, errorCode: 'llm_error', errorMessage: String(errMsg).slice(0, 80) };
    }
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = parseAndValidateCrewLLMWithDebug(content, role);
    if (parsed.result) return { result: parsed.result, errorCode: null, errorMessage: null };
    return { result: null, errorCode: parsed.errorCode || 'parse_error', errorMessage: parsed.errorCode || null };
  } catch (err) {
    clearTimeout(timeoutId);
    const msg = err?.message || String(err);
    const code = /abort|timeout/i.test(msg) ? 'llm_error' : 'llm_error';
    return { result: null, errorCode: code, errorMessage: msg.slice(0, 80) };
  }
}

function buildCrewDebug(source, fallbackReason, rawDialoguePresent, rawReasonPresent, llmErrorMessage) {
  return {
    generation_source: source,
    fallback_reason: fallbackReason,
    raw_dialogue_present: !!rawDialoguePresent,
    raw_reason_present: !!rawReasonPresent,
    llm_error_message: llmErrorMessage != null ? String(llmErrorMessage).slice(0, 120) : null
  };
}

async function resolveCrewPayloadWithLLM(matchId, body, role) {
  const rawDialogue = body.dialogue ?? body.command ?? body.input ?? body.text ?? '';
  const s = (rawDialogue != null && typeof rawDialogue === 'string') ? String(rawDialogue).trim() : '';
  const rawDialoguePresent = !isEmptyDialogue(s) && !looksLikeEnglishTestString(s);
  const rawReasonPresent = body.reason != null && typeof body.reason === 'string' && String(body.reason).trim() !== '';

  if (rawDialoguePresent) {
    // body에 유효한 dialogue 있음 → 그대로 사용. generation_source는 "llm" (fallback 아님)
    return {
      action: normalizeAction(body.action),
      target: body.target ?? null,
      reason: body.reason ?? null,
      dialogue: s,
      _debug: buildCrewDebug('llm', null, true, rawReasonPresent, null)
    };
  }

  const match = await getMatch(matchId);
  const recentRaw = await getRecentEventsForCurrentTurn(matchId);
  const captainEv = (recentRaw || []).find((e) => e.role === 'captain');
  const captainAction = captainEv ? (captainEv.action || 'OBSERVE') : 'OBSERVE';

  /** 최근 1~2턴 QUESTION target 수집 (같은 role이 매번 같은 대상만 고르지 않게) */
  let recentQuestionTargets = [];
  try {
    const recentMultiTurn = await getRecentEvents(matchId, 20);
    const questionEvs = (recentMultiTurn || []).filter((e) => (e.action || '').toUpperCase() === 'QUESTION' && e.target);
    recentQuestionTargets = [...new Set(questionEvs.map((e) => String(e.target).toLowerCase()).filter(Boolean))];
  } catch (_) {}

  if (!match) {
    const fallbackReasonVal = (body.reason && body.reason !== 'crew') ? body.reason : '상황을 파악 중이다.';
    return {
      action: normalizeAction(body.action),
      target: body.target ?? null,
      reason: fallbackReasonVal,
      dialogue: getCrewFallbackByRoleAndAction(role, captainAction, 1),
      _debug: buildCrewDebug('fallback', 'match_not_found', false, rawReasonPresent, null)
    };
  }

  const turnNum = match.turn ?? 1;
  const privateCtx = getPrivateContextForRole(match, role);
  const amIHost = !!(privateCtx && privateCtx.is_hidden_host);
  const deadCrewArr = Array.isArray(body.dead_crew) ? body.dead_crew : [];
  const isQuestion = (captainAction || '').toUpperCase() === 'QUESTION';
  const currentQuestionTarget = (captainEv && captainEv.target) ? String(captainEv.target).trim().toLowerCase() : null;
  const currentQuestionTargetRoleKo = currentQuestionTarget ? (TARGET_KO[currentQuestionTarget] || currentQuestionTarget) : null;

  const targetDiversifyRaw =
    !isQuestion && (recentQuestionTargets.length > 0 || deadCrewArr.length > 0)
      ? [
          recentQuestionTargets.length > 0 && `최근 1~2턴에 이미 ${recentQuestionTargets.join(', ')}에게 질문이 많이 갔음. 가능하면 다른 유력 대상이나 다른 관점으로 다양화하라.`,
          deadCrewArr.length > 0 && `dead_crew(${deadCrewArr.join(', ')})는 target으로 절대 선택하지 마라.`
        ].filter(Boolean).join(' ')
      : null;

  const observation = {
    match_id: matchId,
    turn: turnNum,
    captain_action: captainEv ? { action: captainEv.action, target: captainEv.target, dialogue: captainEv.dialogue } : {},
    current_question_target: isQuestion ? currentQuestionTarget : null,
    current_question_target_role_ko: isQuestion ? currentQuestionTargetRoleKo : null,
    question_focus_rule: isQuestion && currentQuestionTargetRoleKo
      ? `첫 문장 또는 첫 절은 반드시 ${currentQuestionTargetRoleKo}에 대한 반응으로 시작. 제3자로 초점이 튀면 안 됨.`
      : null,
    recentEvents: (recentRaw || []).map((e) => ({ role: e.role, action: e.action, target: e.target, dialogue: (e.dialogue || '').slice(0, 80) })),
    recent_question_targets: recentQuestionTargets,
    target_diversification_hint: isQuestion ? null : targetDiversifyRaw,
    dead_crew: deadCrewArr.map((d) => String(d || '').toLowerCase()).filter(Boolean),
    your_role: role,
    am_i_hidden_host: amIHost,
    suspicion_style: amIHost ? 'redirect_deflect_evade' : 'direct_observation',
    turn_pressure: turnNum <= 1 ? 'early' : 'mid',
    behavior_rules: amIHost
      ? `[IMPOSTOR] ${IMPOSTOR_RULES} [role별]: ${IMPOSTOR_BEHAVIOR[role] || IMPOSTOR_BEHAVIOR.doctor}`
      : `[INNOCENT] ${INNOCENT_BEHAVIOR}`,
    first_turn_hint: turnNum <= 1 ? (amIHost ? FIRST_TURN_IMPOSTOR : FIRST_TURN_INNOCENT) : null
  };
  if (privateCtx) {
    observation.private_context = {
      ...privateCtx,
      suspicion_bias: observation.behavior_rules,
      attitude_guidance: observation.behavior_rules
    };
  }

  // dialogue 비어 있음 → 서버에서 LLM으로 crew dialogue 생성 (우선순위 1)
  let llmOut = await generateCrewDialogueLLM(matchId, role, observation);
  if (!llmOut.result) {
    await new Promise((r) => setTimeout(r, 500));
    llmOut = await generateCrewDialogueLLM(matchId, role, observation);
  }
  if (llmOut.result) {
    let dialogue = llmOut.result.dialogue;
    if (isGenericPlaceholderDialogue(dialogue)) {
      dialogue =
        (captainAction || '').toUpperCase() === 'QUESTION' && currentQuestionTargetRoleKo
          ? getQuestionTargetFocusedFallback(role, currentQuestionTargetRoleKo)
          : getCrewFallbackByRoleAndAction(role, captainAction, turnNum);
    }
    if (
      (captainAction || '').toUpperCase() === 'QUESTION' &&
      currentQuestionTargetRoleKo &&
      !doesDialogueFocusOnTarget(dialogue, currentQuestionTargetRoleKo)
    ) {
      dialogue = getQuestionTargetFocusedFallback(role, currentQuestionTargetRoleKo);
    }
    let target = llmOut.result.target;
    if (target && deadCrewArr.some((d) => String(d || '').toLowerCase() === String(target).toLowerCase())) {
      target = null;
    }
    return {
      action: llmOut.result.action,
      target,
      reason: llmOut.result.reason,
      dialogue,
      _debug: buildCrewDebug('llm', null, false, rawReasonPresent, null)
    };
  }

  // LLM 실패 → action-aware fallback (최후 수단). reason은 "crew" 대신 실제 의미 있는 값 사용.
  const fallbackReason = llmOut.errorCode || 'unknown';
  const llmErrMsg = llmOut.errorMessage || null;
  const fallbackReasonVal = (body.reason && body.reason !== 'crew') ? body.reason : '상황을 파악 중이다.';
  let fallbackDialogue = getCrewFallbackByRoleAndAction(role, captainAction, turnNum);
  if ((captainAction || '').toUpperCase() === 'QUESTION' && currentQuestionTargetRoleKo) {
    fallbackDialogue = getQuestionTargetFocusedFallback(role, currentQuestionTargetRoleKo);
  }
  return {
    action: normalizeAction(body.action),
    target: body.target ?? null,
    reason: fallbackReasonVal,
    dialogue: fallbackDialogue,
    _debug: buildCrewDebug('fallback', fallbackReason, false, rawReasonPresent, llmErrMsg)
  };
}

async function resolvePayloadForCrew(matchId, body, role) {
  const resolved = await resolveCrewPayloadWithLLM(matchId, body, role);
  if (resolved) return resolved;
  const rawReasonPresent = body.reason != null && typeof body.reason === 'string' && String(body.reason).trim() !== '';
  const fallbackReasonVal = (body.reason && body.reason !== 'crew') ? body.reason : '상황을 파악 중이다.';
  return {
    action: normalizeAction(body.action),
    target: body.target ?? null,
    reason: fallbackReasonVal,
    dialogue: getCrewFallbackByRoleAndAction(role, 'OBSERVE', 1),
    _debug: buildCrewDebug('fallback', 'unknown', false, rawReasonPresent, null)
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

/** dialogue가 "저는", "제가", "그때 저는", "내가"로 시작하는지. 해명형 summary 우선 판단용. */
function doesDialogueStartWithSelfDefense(dialogue) {
  if (!dialogue || typeof dialogue !== 'string') return false;
  const t = String(dialogue).trim();
  return /^저는\b/.test(t) || /^제가\b/.test(t) || /^그때\s*저는/.test(t) || /^내가\b/.test(t);
}

/** dialogue가 1인칭 해명/방어형인지. QUESTION self-target summary 판단용. */
function isSelfDefenseDialogue(dialogue) {
  if (!dialogue || typeof dialogue !== 'string') return false;
  const t = String(dialogue).trim().slice(0, 120);
  const patterns = [
    /^저는\s/, /^제가\s/, /^나는\s/, /^내가\s/, /^내\s/, /^제\s/,
    /그때\s*저는/, /저는\s*그때/, /제\s*위치/, /제\s*기록/, /내\s*기록/,
    /설명하겠습니다/, /해명했/, /설명했/, /설명할\s*수\s*있습니다/,
    /저\s*때문은\s*아닙니다/, /숨길\s*이유가\s*없/, /혼자가\s*아니었/
  ];
  return patterns.some((re) => re.test(t));
}

/** dialogue가 관찰/분위기/반응형인지. 관찰형 summary 판단용. */
function isObserveTypeDialogue(dialogue) {
  if (!dialogue || typeof dialogue !== 'string') return false;
  const t = String(dialogue).trim();
  const observeMarkers = /(살펴보겠습니다|관찰|분위기|반응을|지켜보|표정|긴장감|확인하겠습니다|확인\s*중|지켜보겠습니다|주의\s*깊게|상황을\s*(확인|파악|살펴)|보이네요|보입니다|보인다)/;
  return observeMarkers.test(t);
}

function makeReadableSummaryKo(role, action, target, dialogue) {
  const subj = subjectKo(role);
  const r = ROLE_KO[role] || role || '승무원';
  const a = String(action || 'WAIT').toUpperCase();
  const tQuestion = getValidQuestionTargetKo(role, target);
  const tAccuse = target ? (TARGET_KO[String(target).toLowerCase()] || target) : null;

  switch (a) {
    case 'QUESTION': {
      const rawTarget = (target ?? '').toString().trim().toLowerCase();
      const isSelfTarget = rawTarget === role;
      const startsWithSelfDefense = doesDialogueStartWithSelfDefense(dialogue);

      if (isSelfTarget || startsWithSelfDefense) {
        return `${subj} 자신의 위치를 해명했다.`;
      }

      const targetIsNullOrSelf = !rawTarget || rawTarget === role;
      const hasDialogue = dialogue && typeof dialogue === 'string' && String(dialogue).trim().length > 0;

      if (hasDialogue && targetIsNullOrSelf) {
        if (isSelfDefenseDialogue(dialogue)) {
          if (role === 'doctor') return '의사가 자신의 위치를 해명했다.';
          if (role === 'engineer') return '엔지니어가 자신의 알리바이를 설명했다.';
          if (role === 'navigator') return '네비게이터가 자신의 동선을 해명했다.';
          if (role === 'pilot') return '파일럿이 자신의 위치를 설명했다.';
          return `${subj} 자신의 입장을 해명했다.`;
        }
        if (isObserveTypeDialogue(dialogue)) {
          if (role === 'doctor') return '의사가 승무원들의 반응을 관찰했다.';
          if (role === 'engineer') return '엔지니어가 시스템 상태를 점검했다.';
          if (role === 'navigator') return '네비게이터가 상황을 살폈다.';
          if (role === 'pilot') return '파일럿이 브리지의 분위기 변화를 살폈다.';
          return `${subj} 상황을 관찰했다.`;
        }
      }

      if (tQuestion) {
        if (role === 'navigator') return `네비게이터가 ${tQuestion}에게 동선을 추궁했다.`;
        if (role === 'doctor') return `의사가 ${tQuestion}에게 확인을 요청했다.`;
        if (role === 'engineer') return `엔지니어가 ${tQuestion}에게 기술적 질문을 했다.`;
        if (role === 'pilot') return `파일럿이 ${tQuestion}에게 공기 변화에 대해 물었다.`;
        return `${subj} ${tQuestion}에게 질문했다.`;
      }
      if (role === 'navigator') return '네비게이터가 동선을 추궁했다.';
      if (role === 'doctor') return '의사가 확인을 요청했다.';
      if (role === 'engineer') return '엔지니어가 질문했다.';
      if (role === 'pilot') return '파일럿이 공기 변화에 대해 물었다.';
      return `${subj} 질문했다.`;
    }
    case 'OBSERVE':
      if (role === 'captain' && dialogue && dialogue !== CAPTAIN_DIALOGUE_FALLBACK_KO) return `${ROLE_KO.captain}: ${dialogue.slice(0, 60)}${dialogue.length > 60 ? '...' : ''}`;
      if (role === 'captain') return '함장이 브리지를 살폈다.';
      if (role === 'doctor') return '의사가 승무원들의 반응을 관찰했다.';
      if (role === 'engineer') return '엔지니어가 시스템 상태를 점검했다.';
      if (role === 'navigator') return '네비게이터가 상황을 살폈다.';
      if (role === 'pilot') return '파일럿이 브리지의 분위기 변화를 살폈다.';
      return `${subj} 상황을 관찰했다.`;
    case 'CHECK_LOG':
      if (role === 'captain' && dialogue && dialogue !== CAPTAIN_DIALOGUE_FALLBACK_KO) return `${ROLE_KO.captain}: ${dialogue.slice(0, 60)}${dialogue.length > 60 ? '...' : ''}`;
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
  const types = {
    QUESTION: 'question', OBSERVE: 'observe', CHECK_LOG: 'check_log', REPAIR: 'repair', ACCUSE: 'accuse', WAIT: 'wait',
    TAKE_CLUE: 'take_clue', FIND_CLUE: 'find_clue', TAKE_PISTOL: 'take_pistol', USE_PISTOL: 'use_pistol',
    SHOOT: 'shoot', KILL: 'kill', DEATH: 'death'
  };
  return types[a] || 'act';
}

function errRes(res, status, message) {
  return res.status(status).json({ ok: false, error: { message } });
}

/** match에서 게임 상태 병합. 없으면 기본값. */
function getGameState(match) {
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
    winner: gs.winner ?? null,
    loser_reason: gs.loser_reason ?? null
  };
}

/**
 * accuse / clue / pistol / death / win-loss 액션 뼈대.
 * 실제 판정은 result.js에서 연결. 여기선 상태 변경 구조만 준비.
 * 종료 조건: accuse 성공/실패, 총 사용 사망, impostor/captain/전원 사망 → outcome/winner/loser_reason 저장 가능.
 */
function processGameAction(match, action, role, target, gameState) {
  const a = String(action || '').toUpperCase();
  const patch = {};
  const serverResult = { game_action: a };
  const hiddenHost = match?.hidden_host_role || null;

  if (a === 'ACCUSE' && target) {
    const entry = { turn: match.turn ?? 1, accuser: role, accused: target };
    patch.accuse_history = [...(gameState.accuse_history || []), entry];
    serverResult.accuse_recorded = true;
    serverResult.accused = target;
    if (hiddenHost) {
      const correct = String(target).toLowerCase() === String(hiddenHost).toLowerCase();
      if (correct) {
        patch.game_over = true;
        patch.outcome = 'crew_win';
        patch.winner = 'crew';
        patch.loser_reason = 'impostor_accused';
      } else {
        patch.game_over = true;
        patch.outcome = 'impostor_win';
        patch.winner = 'impostor';
        patch.loser_reason = 'accuse_failed';
      }
    }
  } else if (GAME_ACTIONS.has(a) && (a === 'TAKE_CLUE' || a === 'FIND_CLUE')) {
    const clue = { role, turn: match.turn ?? 1 };
    patch.clues = [...(gameState.clues || []), clue];
    serverResult.clue_recorded = true;
  } else if (GAME_ACTIONS.has(a) && (a === 'TAKE_PISTOL' || a === 'USE_PISTOL')) {
    patch.pistol_holder = role;
    serverResult.pistol_holder = role;
  } else if (GAME_ACTIONS.has(a) && (a === 'SHOOT' || a === 'KILL' || a === 'DEATH') && target) {
    const dead = [...new Set([...(gameState.dead_roles || []), target])];
    patch.dead_roles = dead;
    serverResult.death_recorded = true;
    serverResult.dead_role = target;
    if (hiddenHost && dead.some((r) => String(r).toLowerCase() === String(hiddenHost).toLowerCase())) {
      patch.game_over = true;
      patch.outcome = 'crew_win';
      patch.winner = 'crew';
      patch.loser_reason = 'impostor_killed';
    }
  }

  return { serverResult, statePatch: patch };
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
  let crewGenerationDebug = null;

  const deadCrewRaw = body.dead_crew;
  const deadCrewArr = Array.isArray(deadCrewRaw) ? deadCrewRaw : [];
  const isRoleInDeadCrew = (r) => deadCrewArr.some((d) => String(d || '').toLowerCase() === String(r || '').toLowerCase());

  if (CREW_ROLES.has(role) && isRoleInDeadCrew(role)) {
    const match = await getOrCreateMatch(matchId);
    if (!match) return errRes(res, 500, 'Failed to get or create match');
    const pub = await getPublicEvents(matchId);
    const recentRaw = await getRecentEventsForCurrentTurn(matchId);
    const events_count = await getEventsCount(matchId);
    const recent_events = (recentRaw || []).map((e) => {
      const base = formatEventForResponse(e);
      if (base && !base.summary) base.summary = (e.summary || summaryFallbackKo(e.role, e.action));
      return base;
    }).filter(Boolean);
    const gs = getGameState(match);
    return res.status(200).json({
      ok: true,
      server_result: { crew_dead: true, accepted: false },
      next_state: {
        match_id: matchId,
        turn: match.turn ?? 1,
        phase: match.phase ?? 'playing',
        location: match.location ?? 'bridge',
        public_events: Array.isArray(pub) ? pub : [],
        recent_events,
        events_count,
        game_state: gs
      },
      game_over: match.game_over || false,
      outcome: match.outcome ?? null
    });
  }

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
    crewGenerationDebug = crewResolved._debug || null;
  } else {
    dialogue = resolveDialogueForPayload(body, role) || '상황을 확인하겠습니다.';
  }

  const rawAction = (body.action || '').toString().trim().toUpperCase();
  if (GAME_ACTIONS.has(rawAction)) action = rawAction;

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
  if (crewGenerationDebug) {
    serverResult.generation_source = crewGenerationDebug.generation_source;
    serverResult.fallback_reason = crewGenerationDebug.fallback_reason;
    serverResult.raw_dialogue_present = crewGenerationDebug.raw_dialogue_present;
    serverResult.raw_reason_present = crewGenerationDebug.raw_reason_present;
    serverResult.llm_error_message = crewGenerationDebug.llm_error_message;
  }

  const ok = await appendEvent(matchId, payload, readableSummary, serverResult);
  if (!ok) {
    return errRes(res, 500, 'Failed to append event');
  }

  let updatedMatch = await getOrCreateMatch(matchId);
  let gameState = getGameState(updatedMatch);

  if (action === 'ACCUSE' || GAME_ACTIONS.has(action)) {
    const { serverResult: gameResult, statePatch } = processGameAction(updatedMatch, action, role, target, gameState);
    Object.assign(serverResult, gameResult);
    gameState = { ...gameState, ...statePatch };
    const hasStateChanges = Object.keys(statePatch).length > 0;
    if (statePatch.game_over != null || statePatch.outcome != null || hasStateChanges) {
      const persistPatch = {};
      if (statePatch.game_over != null) persistPatch.game_over = statePatch.game_over;
      if (statePatch.outcome != null) persistPatch.outcome = statePatch.outcome;
      if (hasStateChanges) {
        persistPatch.game_state = {
          clues: gameState.clues,
          pistol_holder: gameState.pistol_holder,
          dead_roles: gameState.dead_roles,
          accuse_history: gameState.accuse_history,
          game_over: gameState.game_over || statePatch.game_over || false,
          outcome: gameState.outcome ?? statePatch.outcome ?? null,
          winner: gameState.winner ?? statePatch.winner ?? null,
          loser_reason: gameState.loser_reason ?? statePatch.loser_reason ?? null
        };
      }
      if (Object.keys(persistPatch).length > 0) {
        await updateMatch(matchId, persistPatch);
        updatedMatch = await getOrCreateMatch(matchId);
      }
    }
  }

  const pub = await getPublicEvents(matchId);
  let recentRaw = await getRecentEventsForCurrentTurn(matchId);
  if (CREW_ROLES.has(role)) {
    const hasMe = (recentRaw || []).some((e) => e && (e.role === role || e.actor === payload.actor));
    if (!hasMe) {
      const fallbackEv = { ...payload, turn: updatedMatch.turn ?? 1, summary: readableSummary, server_result: { summary: readableSummary } };
      recentRaw = [...(recentRaw || []), fallbackEv];
    }
  }
  const recent_events = (recentRaw || []).map((e) => {
    const base = formatEventForResponse(e);
    if (base && !base.summary) base.summary = (e.summary || summaryFallbackKo(e.role, e.action));
    return base;
  }).filter(Boolean);
  const events_count = await getEventsCount(matchId);

  const serverResultPayload = { ...serverResult, accepted: true, placeholder: true };
  if (CREW_ROLES.has(role)) {
    serverResultPayload.current_event = {
      role,
      dialogue: payload.dialogue || null,
      summary: readableSummary,
      actor: payload.actor || null
    };
  }
  serverResultPayload.handler_source = 'action.js';
  serverResultPayload.debug_version = 1;

  const finalGameOver = gameState.game_over || updatedMatch.game_over || false;
  const finalOutcome = gameState.outcome ?? updatedMatch.outcome ?? null;

  return res.status(200).json({
    ok: true,
    server_result: serverResultPayload,
    next_state: {
      match_id: matchId,
      turn: updatedMatch.turn ?? 1,
      phase: updatedMatch.phase ?? 'playing',
      location: updatedMatch.location ?? 'bridge',
      public_events: Array.isArray(pub) ? pub : [],
      recent_events,
      events_count,
      game_state: {
        clues: gameState.clues,
        pistol_holder: gameState.pistol_holder,
        dead_roles: gameState.dead_roles,
        accuse_history: gameState.accuse_history,
        game_over: finalGameOver,
        outcome: finalOutcome,
        winner: gameState.winner,
        loser_reason: gameState.loser_reason
      }
    },
    game_over: finalGameOver,
    outcome: finalOutcome
  });
};

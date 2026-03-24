/**
 * core/engine/ep1Engine.js - EP1 게임 규칙 엔진
 * match state 입력 → action 적용 → 결과 반환
 * 타이머/자동살해/승패 판정 연결.
 */

const timers = require('./timers');
const kills = require('./kills');
const winlose = require('./winlose');

const GAME_TOTAL_SEC = 420;

function getGameTotalSec(matchState) {
  if (matchState?.deadline_at && matchState?.started_at) {
    const start = new Date(matchState.started_at);
    const deadline = new Date(matchState.deadline_at);
    return Math.floor((deadline - start) / 1000);
  }
  return GAME_TOTAL_SEC;
}

const VALID_ACTIONS = new Set(['QUESTION', 'OBSERVE', 'CHECK_LOG', 'REPAIR', 'ACCUSE', 'SUSPECT', 'WAIT', 'TAKE_PISTOL', 'FIND_CLUE', 'DEATH']);
const VALID_TARGETS = new Set(['doctor', 'engineer', 'navigator', 'pilot', 'captain', 'player']);

/**
 * @param {object} matchState - { match_id, turn, started_at, deadline_at, game_state, hidden_host_role, ... }
 * @param {object} action - { actor, role, action, target?, dialogue?, reason? }
 * @param {object} opts - { now?: Date } 테스트용 시각 주입
 * @returns {Promise<{ ok: boolean, next_state: object, game_over?: boolean, outcome?: string, events?: object[], summary?: string, remaining_sec?: number }>}
 */
async function applyAction(matchState, action, opts = {}) {
  const { game_state = {}, hidden_host_role } = matchState;
  const deadRoles = game_state.dead_roles || [];
  const triggeredKillMarks = game_state.triggered_kill_marks || [];
  const now = opts.now;
  const totalSec = getGameTotalSec(matchState);
  const { remaining_sec } = timers.computeDeadline(totalSec, matchState.started_at || new Date(), now);

  // 0. game_over면 진행 중단
  if (game_state.game_over) {
    return {
      ok: true,
      next_state: matchState,
      summary: `Game over. Outcome: ${game_state.outcome || 'unknown'}`,
      game_over: true,
      outcome: game_state.outcome,
      remaining_sec
    };
  }

  // 0. timeout → impostor_win
  if (timers.isExpired(totalSec, matchState.started_at || new Date(), now)) {
    const result = winlose.resolveOutcome({ remainingSec: 0 });
    const nextState = {
      ...matchState,
      game_state: { ...game_state, game_over: true, outcome: result.outcome }
    };
    return {
      ok: true,
      next_state: nextState,
      summary: `Time's up. ${result.outcome}.`,
      game_over: true,
      outcome: result.outcome,
      events: [{ type: 'TIMEOUT' }],
      remaining_sec: 0
    };
  }

  // 0. 자동 살해 체크 (action 처리 전)
  const killResult = kills.checkAutoKill(deadRoles, hidden_host_role, remaining_sec, triggeredKillMarks);
  if (killResult.shouldKill && killResult.victimRole) {
    const nextDead = [...deadRoles, killResult.victimRole];
    const nextMarks = [...triggeredKillMarks, killResult.mark].filter(Boolean);
    const outcome = nextDead.length >= 4 ? winlose.resolveOutcome({ deadRoles: nextDead, impostorRole: hidden_host_role, remainingSec: remaining_sec }).outcome : null;
    const nextState = {
      ...matchState,
      game_state: {
        ...game_state,
        dead_roles: nextDead,
        triggered_kill_marks: nextMarks,
        ...(outcome && { game_over: true, outcome })
      }
    };
    const zone = kills.getDeathZone(killResult.victimRole);
    return {
      ok: true,
      next_state: nextState,
      events: [{ type: 'DEATH', role: killResult.victimRole, zone, reason: 'auto_kill' }],
      summary: `[AUTO KILL] ${killResult.victimRole} bio signal lost in ${zone}.`,
      game_over: nextDead.length >= 4,
      outcome,
      remaining_sec
    };
  }

  // 1. intent_type / action → 정규화 (accuse_hint → SUSPECT 비처형, accuse → ACCUSE 처형)
  const intentOrAction = String(action.intent_type || action.action || '').toLowerCase();
  const mapped = intentToAction(intentOrAction, action.target);
  action.action = mapped.action;
  action.target = mapped.target ?? action.target;

  const act = String(action.action || '').toUpperCase();
  if (!VALID_ACTIONS.has(act)) {
    action.action = 'OBSERVE';
  }

  // 2. DEATH 처리 (수동)
  if (String(action.action).toUpperCase() === 'DEATH') {
    const nextDead = [...deadRoles, action.target].filter(Boolean);
    const nextState = {
      ...matchState,
      game_state: { ...game_state, dead_roles: nextDead }
    };
    const outcome = nextDead.length >= 4 ? winlose.resolveOutcome({ deadRoles: nextDead, impostorRole: hidden_host_role, remainingSec: remaining_sec }).outcome : null;
    return {
      ok: true,
      next_state: nextState,
      events: [{ type: 'DEATH', role: action.target }],
      summary: `${action.target} bio signal lost.`,
      game_over: nextDead.length >= 4,
      outcome,
      remaining_sec
    };
  }

  // 3. ACCUSE 처리 (action=accuse 또는 명시적 처형 액션만. accuse_hint는 SUSPECT로 비처형 분기)
  const actFinal = String(action.action || '').toUpperCase();
  if (actFinal === 'ACCUSE' && action.target) {
    const result = winlose.resolveOutcome({
      accusedRole: action.target,
      impostorRole: hidden_host_role,
      deadRoles,
      remainingSec: remaining_sec
    });
    const nextAccuseHistory = [...(game_state.accuse_history || []), { target: action.target, outcome: result.outcome }];
    const nextState = {
      ...matchState,
      game_state: {
        ...game_state,
        game_over: true,
        outcome: result.outcome,
        accuse_history: nextAccuseHistory
      }
    };
    return {
      ok: true,
      next_state: nextState,
      events: [{ type: 'ACCUSE', role: 'captain', target: action.target }], // ACCUSE -> target
      summary: `Captain accused ${action.target}. Outcome: ${result.outcome}`,
      game_over: true,
      outcome: result.outcome,
      remaining_sec
    };
  }

  // 3.5. SUSPECT 처리 (베르셀 성공본처럼 함장 suspect + 크루 4명 반응 시퀀스. game_over/outcome 변경 없음)
  if (actFinal === 'SUSPECT' && action.target) {
    const target = String(action.target).toLowerCase();
    const crewOrder = ['doctor', 'engineer', 'navigator', 'pilot'];
    const aliveCrew = crewOrder.filter((r) => !deadRoles.includes(r));
    const events = buildCrewReactionEvents('SUSPECT', target, aliveCrew);
    const summary = `Captain suspects ${action.target}.`;
    return {
      ok: true,
      next_state: matchState,
      events,
      summary,
      remaining_sec
    };
  }

  // 3.6. QUESTION 처리 (베르셀 성공본처럼 함장 question + 크루 4명 반응 시퀀스)
  if (actFinal === 'QUESTION' && action.target) {
    const target = String(action.target).toLowerCase();
    const crewOrder = ['doctor', 'engineer', 'navigator', 'pilot'];
    const aliveCrew = crewOrder.filter((r) => !deadRoles.includes(r));
    const events = buildCrewReactionEvents('QUESTION', target, aliveCrew);
    const summary = `Captain questioned ${action.target}.`;
    return {
      ok: true,
      next_state: matchState,
      events,
      summary,
      remaining_sec
    };
  }

  // 4. 일반 액션 (OBSERVE, CHECK_LOG 등)
  const actOut = String(action.action || '').toUpperCase();
  const event = { type: actOut, role: action.role || 'captain', target: action.target };
  const summary = buildSummary(actOut, action.role, action.target);
  return {
    ok: true,
    next_state: matchState,
    events: [event],
    summary,
    remaining_sec
  };
}

const ROLE_KO = { doctor: '닥터', engineer: '엔지니어', navigator: '네비게이터', pilot: '파일럿' };

/**
 * SUSPECT/QUESTION 시 크루 반응 시퀀스 (베르셀 성공본 흐름).
 * 대상 역할이 먼저 방어/회피, 그 다음 다른 크루들이 역할 톤대로 target을 중심 반응.
 * 각 역할: doctor=감정/상태, engineer=로그/시스템, navigator=동선/alibi, pilot=분위기/직감.
 * 필요 시 짧은 서술문을 추가.
 * @param {string} actionType - 'SUSPECT' | 'QUESTION'
 * @param {string} target - 의심/질문 대상
 * @param {string[]} aliveCrew
 * @returns {object[]}
 */
function buildCrewReactionEvents(actionType, target, aliveCrew) {
  const isSuspect = actionType === 'SUSPECT';
  const events = [{ type: actionType, role: 'captain', target }];

  const TARGET_DEFENSE_SUSPECT = {
    doctor: '[닥터] 저요? 저는 의무실에서 생체 모니터링 중이었습니다. 스트레스 반응은 모두 정상 범위였어요.',
    engineer: '[엔지니어] 제가요? 엔진실 접근 로그 확인해보세요. 수리 작업 때문에 그 시간대엔 꼼짝 못 했습니다.',
    navigator: '[네비게이터] 저를 의심하시다니… 그 시간대 동선은 교량, 그다음 항로 체크였습니다. 감시 로그에 있을 겁니다.',
    pilot: '[파일럿] 저요? 조종석에 있었어요. 공간 감압 로그 확인해보세요. 저 혼자일 때는 없었습니다.'
  };

  const TARGET_DEFENSE_QUESTION = {
    doctor: '[닥터] 그때요? 의무실에서 승무원 생체 신호 확인 중이었습니다. 닥터 로그에 찍혀 있어요.',
    engineer: '[엔지니어] 그 시간대요? 엔진실에서 코어 점검 중이었어요. 접근 기록이 있습니다.',
    navigator: '[네비게이터] 저요? 교량에서 항로 재계산하고 있었습니다. 네비 로그 확인해보세요.',
    pilot: '[파일럿] 그때는 조종석이었어요. 자동 조종 모드 확인 중이었습니다.'
  };

  const TARGET_KO = roleNameFromKey(target);

  const CREW_REACT_BY_TARGET = {
    doctor: {
      doctor: '[닥터] …',
      engineer: '[엔지니어] 의무실 접근 로그부터 확인해봅시다. 누가 언제 출입했는지.',
      navigator: '[네비게이터] 닥터님, 그 시간대 의무실에서 정확히 뭘 하셨는지부터 말씀해 주세요. 알리바이가 애매해요.',
      pilot: '[파일럿] 닥터 쪽 생체 신호가 한 순간 요동쳤던 것 같아요. 제가 조종석에서 감지했어요.'
    },
    engineer: {
      doctor: '[닥터] 엔지니어 구역 생체 기록을 확인해봐야겠어요. 스트레스 반응이 비정상적이었을 수 있어요.',
      engineer: '[엔지니어] …',
      navigator: '[네비게이터] 엔지니어님, 그 시간대 엔진실 동선부터 짚어봅시다. 타임스탬프가 안 맞아요.',
      pilot: '[파일럿] 엔진실에서 뭔가 다른 게 느껴졌어요. 기계음이 아닌… 숨소리?'
    },
    navigator: {
      doctor: '[닥터] 네비게이터님 표정을 보니 뭔가 숨기는 것 같아요. 심리 상태 체크가 필요해요.',
      engineer: '[엔지니어] 교량 감시 로그 확인했습니다. 접근 기록에 끊김이 있어요.',
      navigator: '[네비게이터] …',
      pilot: '[파일럿] 네비님, 그때 교량에서 뭐 하셨는지 구체적으로 말해 주세요. 분위기가 이상했어요.'
    },
    pilot: {
      doctor: '[닥터] 파일럿에게 확인을 요청하고 싶어요. 조종석 생체 데이터가 일시적으로 꼬였어요.',
      engineer: '[엔지니어] 조종석 로그 확인해봐야겠다. 자동 조종 전환 기록이 의심스러워요.',
      navigator: '[네비게이터] 파일럿님, 그 시간대 동선부터 다시 말해봐요. 알리바이가 비어 있어요.',
      pilot: '[파일럿] …'
    }
  };

  const NARRATIVE_KO = {
    doctor: (t) => {
      if (t === 'pilot') return '닥터가 파일럿에게 확인을 요청했다.';
      if (t === 'engineer') return '닥터가 엔지니어 구역 생체 기록을 확인했다.';
      if (t === 'navigator') return '닥터가 네비게이터의 심리 상태를 체크했다.';
      return '닥터가 승무원 반응을 살폈다.';
    },
    engineer: () => '엔지니어가 시스템 로그를 확인했다.',
    navigator: (t) => (t && t !== 'navigator' ? `네비게이터가 ${roleNameFromKey(t)}에게 동선을 추궁했다.` : '네비게이터가 동선 기록을 추궁했다.'),
    pilot: () => '파일럿이 브리지의 분위기 변화를 살폈다.'
  };

  const targetFirst = aliveCrew.filter((r) => r === target);
  const others = aliveCrew.filter((r) => r !== target);
  const orderedCrew = targetFirst.length ? [...targetFirst, ...others] : aliveCrew;

  const defenseMap = isSuspect ? TARGET_DEFENSE_SUSPECT : TARGET_DEFENSE_QUESTION;
  const reactMap = CREW_REACT_BY_TARGET[target] || {};

  for (const role of orderedCrew) {
    const isTargetRole = role === target;
    const dialogue = isTargetRole
      ? (defenseMap[role] || `[${ROLE_KO[role]}] 제가요? 저는 그때 할 일이 있었습니다.`)
      : (reactMap[role] || `[${ROLE_KO[role]}] ${TARGET_KO} 쪽을 한번 짚어봐야 할 것 같아요.`);
    events.push({ type: 'CREW_DIALOGUE', role, dialogue });
    const narrativeFn = NARRATIVE_KO[role];
    if (narrativeFn) {
      const narrative = typeof narrativeFn === 'function' ? narrativeFn(target) : narrativeFn;
      events.push({ type: 'CREW_DIALOGUE', role, dialogue: narrative });
    }
  }

  return events;
}

function roleNameFromKey(r) {
  return ROLE_KO[String(r || '').toLowerCase()] || String(r || '');
}

/** deterministic fallback summary */
function buildSummary(action, role, target) {
  const t = target ? (target.charAt(0).toUpperCase() + target.slice(1).toLowerCase()) : null;
  const act = String(action || '').toUpperCase();
  if (act === 'QUESTION' && t) return `Captain questioned ${t}.`;
  if (act === 'CHECK_LOG') return 'Captain checked ship logs.';
  if (act === 'OBSERVE') return 'Captain observed the bridge.';
  if (act === 'SUSPECT' && t) return `Captain suspects ${t}.`;
  if (act === 'ACCUSE' && t) return `Captain accused ${t}.`;
  return 'Captain acted.';
}

/** intent_type → engine action 매핑. accuse_hint는 비처형(SUSPECT), accuse만 실제 처형(ACCUSE) */
function intentToAction(intent_type, target) {
  const map = {
    question: 'QUESTION',
    check_log: 'CHECK_LOG',
    accuse_hint: 'SUSPECT',
    accuse: 'ACCUSE',
    observe: 'OBSERVE',
    threat: 'QUESTION',
    unknown: 'OBSERVE'
  };
  const action = map[intent_type] || 'OBSERVE';
  return { action, target: target || null };
}

/**
 * @param {object} matchState
 * @param {Date} [now]
 * @returns {{ shouldAutoKill: boolean, victimRole: string|null, remaining_sec: number }}
 */
function checkAutoKillForMatch(matchState, now) {
  const { game_state = {}, hidden_host_role } = matchState;
  const deadRoles = game_state.dead_roles || [];
  const triggeredKillMarks = game_state.triggered_kill_marks || [];
  const totalSec = getGameTotalSec(matchState);
  const { remaining_sec } = timers.computeDeadline(totalSec, matchState.started_at || new Date(), now);
  const result = kills.checkAutoKill(deadRoles, hidden_host_role, remaining_sec, triggeredKillMarks);
  return { shouldAutoKill: result.shouldKill, victimRole: result.victimRole, remaining_sec };
}

/**
 * @param {object} matchState
 * @param {Date} [now]
 * @returns {{ remaining_sec: number, is_expired: boolean }}
 */
function getTimerStatus(matchState, now) {
  const totalSec = getGameTotalSec(matchState);
  const { remaining_sec } = timers.computeDeadline(totalSec, matchState.started_at || new Date(), now);
  return { remaining_sec, is_expired: remaining_sec <= 0 };
}

module.exports = {
  applyAction,
  checkAutoKillForMatch,
  getTimerStatus,
  intentToAction,
  GAME_TOTAL_SEC,
  VALID_ACTIONS,
  VALID_TARGETS
};

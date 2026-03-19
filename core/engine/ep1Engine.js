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

const VALID_ACTIONS = new Set(['QUESTION', 'OBSERVE', 'CHECK_LOG', 'REPAIR', 'ACCUSE', 'WAIT', 'TAKE_PISTOL', 'FIND_CLUE', 'DEATH']);
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

  // 1. intent_type → action 정규화
  const raw = String(action.action || '').toLowerCase();
  const mapped = intentToAction(raw, action.target);
  action.action = mapped.action;
  action.target = mapped.target;

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

  // 3. ACCUSE 처리 → 승패 판정, accuse_history 반영
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
      events: [{ type: 'ACCUSE', role: 'captain', target: action.target }],
      summary: `Captain accused ${action.target}. Outcome: ${result.outcome}`,
      game_over: true,
      outcome: result.outcome,
      remaining_sec
    };
  }

  // 4. 일반 액션 (QUESTION, OBSERVE, CHECK_LOG 등)
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

/** deterministic fallback summary */
function buildSummary(action, role, target) {
  const t = target ? (target.charAt(0).toUpperCase() + target.slice(1).toLowerCase()) : null;
  const act = String(action || '').toUpperCase();
  if (act === 'QUESTION' && t) return `Captain questioned ${t}.`;
  if (act === 'CHECK_LOG') return 'Captain checked ship logs.';
  if (act === 'OBSERVE') return 'Captain observed the bridge.';
  if (act === 'ACCUSE' && t) return `Captain accused ${t}.`;
  return 'Captain acted.';
}

/** intent_type → engine action 매핑 */
function intentToAction(intent_type, target) {
  const map = {
    question: 'QUESTION',
    check_log: 'CHECK_LOG',
    accuse_hint: 'ACCUSE',
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

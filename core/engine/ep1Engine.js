/**
 * core/engine/ep1Engine.js - EP1 게임 규칙 엔진
 * match state 입력 → action 적용 → 결과 반환
 * 브라우저 로직과 분리, 서버 권위형.
 */

const timers = require('./timers');
const kills = require('./kills');
const winlose = require('./winlose');

const GAME_TOTAL_SEC = 420;
const VALID_ACTIONS = new Set(['QUESTION', 'OBSERVE', 'CHECK_LOG', 'REPAIR', 'ACCUSE', 'WAIT', 'TAKE_PISTOL', 'FIND_CLUE', 'DEATH']);
const VALID_TARGETS = new Set(['doctor', 'engineer', 'navigator', 'pilot', 'captain', 'player']);

/**
 * @param {object} matchState - { match_id, turn, started_at, game_state, hidden_host_role, ... }
 * @param {object} action - { actor, role, action, target?, dialogue?, reason? }
 * @returns {Promise<{ ok: boolean, next_state: object, game_over?: boolean, outcome?: string, events?: object[] }>}
 */
async function applyAction(matchState, action) {
  const { game_state = {}, hidden_host_role } = matchState;
  const deadRoles = game_state.dead_roles || [];
  const { remaining_sec } = timers.computeDeadline(GAME_TOTAL_SEC, matchState.started_at || new Date());

  // 1. 유효성 검사
  const act = String(action.action || '').toUpperCase();
  if (!VALID_ACTIONS.has(act)) {
    return { ok: false, next_state: matchState, error: 'invalid_action' };
  }

  // 2. DEATH 처리
  if (act === 'DEATH') {
    const nextDead = [...deadRoles, action.target].filter(Boolean);
    const nextState = { ...matchState, game_state: { ...game_state, dead_roles: nextDead } };
    const killResult = kills.checkAutoKill(nextDead, hidden_host_role, remaining_sec);
    return {
      ok: true,
      next_state: nextState,
      events: [{ type: 'DEATH', role: action.target }],
      game_over: nextDead.length >= 4,
      outcome: nextDead.length >= 4 ? winlose.resolveOutcome({ deadRoles: nextDead, impostorRole: hidden_host_role, remainingSec: remaining_sec }).outcome : null
    };
  }

  // 3. ACCUSE 처리 → 승패 판정
  if (act === 'ACCUSE' && action.target) {
    const result = winlose.resolveOutcome({
      accusedRole: action.target,
      impostorRole: hidden_host_role,
      deadRoles,
      remainingSec: remaining_sec
    });
    return {
      ok: true,
      next_state: { ...matchState, game_state: { ...game_state, game_over: true, outcome: result.outcome } },
      game_over: true,
      outcome: result.outcome
    };
  }

  // 4. 일반 액션 (QUESTION, OBSERVE, CHECK_LOG, REPAIR, WAIT 등)
  return {
    ok: true,
    next_state: matchState,
    events: [{ type: act, role: action.role, target: action.target }]
  };
}

/**
 * @param {object} matchState
 * @returns {{ shouldAutoKill: boolean, victimRole: string|null }}
 */
function checkAutoKillForMatch(matchState) {
  const { game_state = {}, hidden_host_role } = matchState;
  const deadRoles = game_state.dead_roles || [];
  const { remaining_sec } = timers.computeDeadline(GAME_TOTAL_SEC, matchState.started_at || new Date());
  const result = kills.checkAutoKill(deadRoles, hidden_host_role, remaining_sec);
  return { shouldAutoKill: result.shouldKill, victimRole: result.victimRole };
}

module.exports = {
  applyAction,
  checkAutoKillForMatch,
  GAME_TOTAL_SEC,
  VALID_ACTIONS,
  VALID_TARGETS
};

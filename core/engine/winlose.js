/**
 * core/engine/winlose.js - 승패 판정
 * crew_win / accuse_failed / impostor_win / timeout
 */

/**
 * @param {string} accusedRole - 처형된 역할
 * @param {string} impostorRole - 실제 임포스터
 * @returns {boolean} - crew 승리(임포스터 처형)
 */
function isCrewWin(accusedRole, impostorRole) {
  return accusedRole && impostorRole && accusedRole.toLowerCase() === impostorRole.toLowerCase();
}

/**
 * @param {string} accusedRole - 처형된 역할
 * @param {string} impostorRole - 실제 임포스터
 * @returns {boolean} - accuse_failed(무고한 크루 처형)
 */
function isAccuseFailed(accusedRole, impostorRole) {
  return accusedRole && impostorRole && accusedRole.toLowerCase() !== impostorRole.toLowerCase();
}

/**
 * @param {string} impostorRole
 * @param {string[]} deadRoles - 사망한 크루
 * @returns {boolean} - impostor_win(임포스터만 생존)
 */
function isImpostorWin(impostorRole, deadRoles) {
  const crew = ['doctor', 'engineer', 'navigator', 'pilot'];
  const alive = crew.filter((r) => !deadRoles.includes(r));
  return alive.length === 1 && alive[0] === impostorRole;
}

/**
 * @param {number} remainingSec
 * @returns {boolean} - timeout(시간 초과)
 */
function isTimeout(remainingSec) {
  return remainingSec <= 0;
}

/**
 * @param {object} ctx - { accusedRole, impostorRole, deadRoles, remainingSec }
 * @returns {{ outcome: string, winner: string|null, loser_reason: string|null }}
 */
function resolveOutcome(ctx) {
  const { accusedRole, impostorRole, deadRoles = [], remainingSec } = ctx;

  if (isTimeout(remainingSec)) {
    return { outcome: 'timeout', winner: null, loser_reason: 'timeout' };
  }
  if (isCrewWin(accusedRole, impostorRole)) {
    return { outcome: 'crew_win', winner: 'crew', loser_reason: null };
  }
  if (isAccuseFailed(accusedRole, impostorRole)) {
    return { outcome: 'accuse_failed', winner: 'impostor', loser_reason: 'wrong_accusation' };
  }
  if (isImpostorWin(impostorRole, deadRoles)) {
    return { outcome: 'impostor_win', winner: 'impostor', loser_reason: null };
  }

  return { outcome: 'playing', winner: null, loser_reason: null };
}

module.exports = {
  isCrewWin,
  isAccuseFailed,
  isImpostorWin,
  isTimeout,
  resolveOutcome
};

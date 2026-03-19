/**
 * core/engine/timers.js - deadline_at, remaining_sec 계산
 * 서버 권위형 타이머. 브라우저 타이머와 분리.
 */

/**
 * @param {number} totalSec - 총 게임 시간(초)
 * @param {Date|string} startedAt - 게임 시작 시각
 * @returns {{ deadline_at: Date, remaining_sec: number }}
 */
function computeDeadline(totalSec, startedAt) {
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const deadline = new Date(start.getTime() + totalSec * 1000);
  const now = new Date();
  const remaining = Math.max(0, Math.floor((deadline - now) / 1000));
  return { deadline_at: deadline, remaining_sec: remaining };
}

/**
 * @param {number} totalSec
 * @param {Date|string} startedAt
 * @returns {boolean} - 시간 초과 여부
 */
function isExpired(totalSec, startedAt) {
  const { remaining_sec } = computeDeadline(totalSec, startedAt);
  return remaining_sec <= 0;
}

module.exports = { computeDeadline, isExpired };

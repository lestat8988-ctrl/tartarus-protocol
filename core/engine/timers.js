/**
 * core/engine/timers.js - deadline_at, remaining_sec 계산
 * 서버 권위형 타이머. now 주입으로 테스트 가능.
 */

/**
 * @param {number} totalSec - 총 게임 시간(초)
 * @param {Date|string} startedAt - 게임 시작 시각
 * @param {Date|string} [now] - 기준 시각 (테스트용, 없으면 new Date())
 * @returns {{ deadline_at: Date, remaining_sec: number }}
 */
function computeDeadline(totalSec, startedAt, now) {
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const deadline = new Date(start.getTime() + totalSec * 1000);
  const baseNow = now != null ? (now instanceof Date ? now : new Date(now)) : new Date();
  const remaining = Math.max(0, Math.floor((deadline - baseNow) / 1000));
  return { deadline_at: deadline, remaining_sec: remaining };
}

/**
 * @param {number} totalSec
 * @param {Date|string} startedAt
 * @param {Date|string} [now]
 * @returns {boolean} - 시간 초과 여부
 */
function isExpired(totalSec, startedAt, now) {
  const { remaining_sec } = computeDeadline(totalSec, startedAt, now);
  return remaining_sec <= 0;
}

module.exports = { computeDeadline, isExpired };

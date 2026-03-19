/**
 * core/engine/kills.js - 자동 살해 규칙
 * 4:00, 1:00 등 특정 시점에 크루 1명 자동 사망.
 * triggered_kill_marks로 중복 발동 방지. deterministic.
 */

const CREW_ROLES = ['doctor', 'engineer', 'navigator', 'pilot'];
const AUTO_KILL_AT_REMAINING = [240, 60]; // 4:00, 1:00

/**
 * @param {string[]} deadRoles - 이미 사망한 역할
 * @param {string|null} impostorRole - 임포스터 역할(자동 살해 제외)
 * @param {number} remainingSec - 남은 시간(초)
 * @param {number[]} triggeredKillMarks - 이미 발동한 구간 (예: [240, 60])
 * @returns {{ shouldKill: boolean, victimRole: string|null, mark: number|null }}
 */
function checkAutoKill(deadRoles, impostorRole, remainingSec, triggeredKillMarks = []) {
  const marks = Array.isArray(triggeredKillMarks) ? triggeredKillMarks : [];
  // 구간 진입: remaining_sec < threshold 이면 1회 발동. 높은 구간부터 검사.
  const sorted = [...AUTO_KILL_AT_REMAINING].sort((a, b) => b - a);
  let mark = null;
  for (const threshold of sorted) {
    if (remainingSec < threshold && !marks.includes(threshold)) {
      mark = threshold;
      break;
    }
  }
  if (mark == null) return { shouldKill: false, victimRole: null, mark: null };

  const alive = CREW_ROLES.filter(
    (r) => !deadRoles.includes(r) && r !== impostorRole
  );
  if (alive.length === 0) return { shouldKill: false, victimRole: null, mark: null };

  // deterministic: 첫 번째 생존자 (알파벳 순)
  const victim = alive[0];
  return { shouldKill: true, victimRole: victim, mark };
}

/**
 * @param {string} victimRole
 * @returns {string} - 사망 이벤트용 zone 라벨
 */
function getDeathZone(victimRole) {
  const zones = {
    doctor: 'Medical Bay',
    engineer: 'Engine Room',
    navigator: 'Navigation',
    pilot: 'Cockpit'
  };
  return zones[victimRole] || victimRole;
}

module.exports = { checkAutoKill, getDeathZone, AUTO_KILL_AT_REMAINING, CREW_ROLES };

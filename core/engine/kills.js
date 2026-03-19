/**
 * core/engine/kills.js - 자동 살해 규칙
 * 4:00, 1:00 등 특정 시점에 랜덤 크루 1명 자동 사망.
 */

const CREW_ROLES = ['doctor', 'engineer', 'navigator', 'pilot'];
const AUTO_KILL_AT_REMAINING = [240, 60]; // 4:00, 1:00

/**
 * @param {string[]} deadRoles - 이미 사망한 역할
 * @param {string|null} impostorRole - 임포스터 역할(자동 살해 제외)
 * @param {number} remainingSec - 남은 시간(초)
 * @returns {{ shouldKill: boolean, victimRole: string|null, firedAt: number[] }}
 */
function checkAutoKill(deadRoles, impostorRole, remainingSec) {
  const firedAt = []; // 스텁: 실제로는 match에서 관리
  const idx = AUTO_KILL_AT_REMAINING.indexOf(remainingSec);
  if (idx < 0) return { shouldKill: false, victimRole: null, firedAt };

  const alive = CREW_ROLES.filter(
    (r) => !deadRoles.includes(r) && r !== impostorRole
  );
  if (alive.length === 0) return { shouldKill: false, victimRole: null, firedAt };

  const victim = alive[Math.floor(Math.random() * alive.length)];
  return { shouldKill: true, victimRole: victim, firedAt: [remainingSec] };
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

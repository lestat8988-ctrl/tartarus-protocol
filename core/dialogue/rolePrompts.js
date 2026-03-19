/**
 * core/dialogue/rolePrompts.js - 역할별 응답 생성용 프롬프트/템플릿
 * 인터페이스만 정의. 나중에 LLM 연동.
 */

const CREW_ROLES = ['doctor', 'engineer', 'navigator', 'pilot'];

/**
 * @param {string} role
 * @param {string} action - captain의 action (QUESTION, CHECK_LOG 등)
 * @param {string|null} target
 * @returns {string} - 역할별 시스템 프롬프트
 */
function getRolePrompt(role, action, target) {
  const base = `You are the ${role} on a spaceship. Stay in character.`;
  if (action === 'QUESTION' && target) {
    return `${base} The captain is questioning you. Respond briefly.`;
  }
  if (action === 'CHECK_LOG') {
    return `${base} The captain asked to check logs. Report your findings.`;
  }
  return base;
}

/**
 * @param {string} role
 * @param {string} action
 * @returns {string[]} - fallback 문장 목록 (LLM 실패 시)
 */
function getFallbacks(role, action) {
  const fallbacks = {
    doctor: ['Checking reactions.', 'Will report any anomalies.'],
    engineer: ['Checking logs.', 'Will flag discrepancies.'],
    navigator: ['Tracing movements.', 'Your alibi has gaps.'],
    pilot: ['Sensing something off.', 'The air shifted.']
  };
  return fallbacks[role] || ['Acting.'];
}

module.exports = { getRolePrompt, getFallbacks, CREW_ROLES };

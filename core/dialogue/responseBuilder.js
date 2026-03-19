/**
 * core/dialogue/responseBuilder.js - 역할별 응답 생성 인터페이스
 * LLM 호출 또는 fallback 반환.
 */

const rolePrompts = require('./rolePrompts');

/**
 * @param {string} role - doctor | engineer | navigator | pilot
 * @param {object} context - { action, target, captainDialogue?, recentEvents? }
 * @returns {Promise<{ dialogue: string, summary: string }>}
 */
async function buildCrewResponse(role, context) {
  const { action = 'OBSERVE', target = null } = context;
  const fallbacks = rolePrompts.getFallbacks(role, action);
  const dialogue = fallbacks[0]; // 스텁: 첫 fallback 사용
  const summary = `${role} responded.`;
  return { dialogue, summary };
}

/**
 * @param {string} role
 * @param {object} context
 * @returns {string} - summary용 한 줄
 */
function buildSummary(role, action, target) {
  const r = role.charAt(0).toUpperCase() + role.slice(1);
  const t = target ? (target.charAt(0).toUpperCase() + target.slice(1)) : null;
  if (action === 'QUESTION' && t) return `${r} questioned ${t}.`;
  if (action === 'CHECK_LOG') return `${r} checked logs.`;
  if (action === 'OBSERVE') return `${r} observed.`;
  return `${r} acted.`;
}

module.exports = { buildCrewResponse, buildSummary };

/**
 * suspect_utils.js - 공통 suspect/accuse 후보 및 dead 필터
 * 텍스트에서 언급되는 suspect와 accuse 가능 후보를 일치시키기 위한 유틸
 */
'use strict';

const CREW = ['Navigator', 'Engineer', 'Doctor', 'Pilot'];

/**
 * accuse 가능한 후보 목록 (dead/eliminated 제외)
 * @param {string[]} crew
 * @param {string[]} deadCrew
 * @returns {string[]}
 */
function getAccuseCandidates(crew, deadCrew) {
  const list = Array.isArray(crew) ? crew : CREW.slice();
  const dead = Array.isArray(deadCrew) ? deadCrew : [];
  return list.filter((c) => !dead.includes(c));
}

/**
 * 라인이 dead 역할을 suspect로 언급하는지
 * @param {string} line - "Role: message" 형식
 * @param {string[]} deadCrew
 * @returns {boolean}
 */
function lineMentionsDeadRoles(line, deadCrew) {
  if (!line || !Array.isArray(deadCrew) || deadCrew.length === 0) return false;
  const msg = String(line).split(':').slice(1).join(':').trim();
  if (!msg) return false;
  const lower = msg.toLowerCase();
  for (const role of deadCrew) {
    if (!role) continue;
    const r = String(role).trim();
    if (!r) continue;
    const re = new RegExp('\\b' + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(msg)) return true;
  }
  return false;
}

/**
 * testimonies 배열에서 dead 언급 제외
 * @param {string[]} testimonies
 * @param {string[]} deadCrew
 * @param {string} [excludeLine] - 중복 방지용 제외할 라인
 * @returns {string[]}
 */
function filterTestimoniesForAlive(testimonies, deadCrew, excludeLine) {
  if (!Array.isArray(testimonies) || testimonies.length === 0) return [];
  let out = testimonies.filter((t) => !lineMentionsDeadRoles(t, deadCrew));
  if (excludeLine && out.length > 1) {
    out = out.filter((t) => t !== excludeLine);
  }
  return out.length > 0 ? out : testimonies;
}

/**
 * deterministic pick index from hash
 */
function simpleHash(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

module.exports = {
  CREW,
  getAccuseCandidates,
  lineMentionsDeadRoles,
  filterTestimoniesForAlive,
  simpleHash
};

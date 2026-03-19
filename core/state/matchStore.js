/**
 * core/state/matchStore.js - 매치 저장소 (메모리 스텁)
 * 나중에 Supabase로 교체 가능하도록 인터페이스만 정의.
 */

const CREW_ROLES = ['doctor', 'engineer', 'navigator', 'pilot'];

const matches = new Map();

/**
 * @param {string} matchId
 * @param {object} opts - { hidden_host_role?, started_at? }
 * @returns {Promise<object>} match
 */
async function getOrCreateMatch(matchId, opts = {}) {
  let m = matches.get(matchId);
  if (!m) {
    m = {
      match_id: matchId,
      turn: 1,
      started_at: opts.started_at || new Date().toISOString(),
      game_state: {
        clues: [],
        pistol_holder: null,
        dead_roles: [],
        accuse_history: [],
        game_over: false,
        outcome: null
      },
      hidden_host_role: opts.hidden_host_role || CREW_ROLES[Math.floor(Math.random() * CREW_ROLES.length)],
      events: []
    };
    matches.set(matchId, m);
  }
  return { ...m };
}

/**
 * @param {string} matchId
 * @returns {Promise<object|null>}
 */
async function getMatch(matchId) {
  const m = matches.get(matchId);
  return m ? { ...m } : null;
}

/**
 * @param {string} matchId
 * @param {object} event
 * @returns {Promise<void>}
 */
async function appendEvent(matchId, event) {
  const m = matches.get(matchId);
  if (m) {
    m.events = m.events || [];
    m.events.push({ ...event, ts: new Date().toISOString() });
  }
}

/**
 * @param {string} matchId
 * @param {object} patch - 부분 업데이트
 * @returns {Promise<object|null>}
 */
async function updateMatch(matchId, patch) {
  const m = matches.get(matchId);
  if (!m) return null;
  Object.assign(m, patch);
  return { ...m };
}

module.exports = {
  getOrCreateMatch,
  getMatch,
  appendEvent,
  updateMatch,
  _store: matches
};

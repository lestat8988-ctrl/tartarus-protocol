/**
 * core/state/playerStore.js - 플레이어 저장소 (메모리 스텁)
 * telegram_id ↔ match_id, role 매핑.
 * 나중에 Supabase로 교체 가능.
 */

const players = new Map(); // telegram_id -> { match_id, role, joined_at }

/**
 * @param {string} telegramId
 * @returns {Promise<object|null>} { match_id, role }
 */
async function getPlayer(telegramId) {
  const p = players.get(telegramId);
  return p ? { ...p } : null;
}

/**
 * @param {string} playerId
 * @param {object} data - { match_id, role?, joined_at? }
 * @returns {Promise<void>}
 */
async function setPlayer(playerId, data) {
  players.set(playerId, {
    match_id: data.match_id,
    role: data.role || 'captain',
    joined_at: data.joined_at || new Date().toISOString()
  });
}

/**
 * @param {string} matchId
 * @returns {Promise<Array<{ telegram_id: string, role: string }>>}
 */
async function getPlayersInMatch(matchId) {
  const list = [];
  for (const [tid, p] of players) {
    if (p.match_id === matchId) list.push({ telegram_id: tid, role: p.role });
  }
  return list;
}

/**
 * @param {string} telegramId
 * @returns {Promise<void>}
 */
async function clearPlayer(telegramId) {
  players.delete(telegramId);
}

module.exports = {
  getPlayer,
  setPlayer,
  getPlayersInMatch,
  clearPlayer,
  _store: players
};

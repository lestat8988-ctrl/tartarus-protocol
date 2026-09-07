'use strict';

// Persistence contract only; implementations must override both methods.
class PlayerRepository {
  /** @param {string} playerId @returns {Promise<object|null>} Detached record, or null. */
  async getById(playerId) {
    throw new Error('PlayerRepository.getById must be implemented');
  }

  /**
   * Store or replace a structured-cloneable record with a non-empty string player_id.
   * Implementations must isolate stored data from caller mutations.
   * @param {object} player
   * @returns {Promise<void>}
   */
  async save(player) {
    throw new Error('PlayerRepository.save must be implemented');
  }
}

module.exports = { PlayerRepository };

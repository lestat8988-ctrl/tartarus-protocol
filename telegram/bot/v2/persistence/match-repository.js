'use strict';

// Persistence contract only; implementations must override both methods.
class MatchRepository {
  /** @param {string} matchId @returns {Promise<object|null>} Detached record, or null. */
  async getById(matchId) {
    throw new Error('MatchRepository.getById must be implemented');
  }

  /**
   * Store or replace a structured-cloneable record with a non-empty string match_id.
   * Implementations must isolate stored data from caller mutations.
   * @param {object} match
   * @returns {Promise<void>}
   */
  async save(match) {
    throw new Error('MatchRepository.save must be implemented');
  }
}

module.exports = { MatchRepository };

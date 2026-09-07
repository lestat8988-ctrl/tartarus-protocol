'use strict';

const { MatchRepository } = require('../match-repository');

class MemoryMatchRepository extends MatchRepository {
  #matches = new Map();

  async getById(matchId) {
    return this.#matches.has(matchId) ? structuredClone(this.#matches.get(matchId)) : null;
  }

  async save(match) {
    if (!match || typeof match.match_id !== 'string' || match.match_id.length === 0) {
      throw new TypeError('match.match_id must be a non-empty string');
    }
    const snapshot = structuredClone(match);
    this.#matches.set(snapshot.match_id, snapshot);
  }
}

module.exports = { MemoryMatchRepository };

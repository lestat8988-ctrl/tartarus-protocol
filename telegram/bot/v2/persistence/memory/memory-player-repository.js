'use strict';

const { PlayerRepository } = require('../player-repository');

class MemoryPlayerRepository extends PlayerRepository {
  #players = new Map();

  async getById(playerId) {
    return this.#players.has(playerId) ? structuredClone(this.#players.get(playerId)) : null;
  }

  async save(player) {
    if (!player || typeof player.player_id !== 'string' || player.player_id.length === 0) {
      throw new TypeError('player.player_id must be a non-empty string');
    }
    const snapshot = structuredClone(player);
    this.#players.set(snapshot.player_id, snapshot);
  }
}

module.exports = { MemoryPlayerRepository };

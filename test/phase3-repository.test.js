'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MatchRepository } = require('../telegram/bot/v2/persistence/match-repository');
const { PlayerRepository } = require('../telegram/bot/v2/persistence/player-repository');
const { MemoryMatchRepository } = require('../telegram/bot/v2/persistence/memory/memory-match-repository');
const { MemoryPlayerRepository } = require('../telegram/bot/v2/persistence/memory/memory-player-repository');

for (const [name, Contract, Implementation, idKey] of [
  ['match', MatchRepository, MemoryMatchRepository, 'match_id'],
  ['player', PlayerRepository, MemoryPlayerRepository, 'player_id']
]) {
  const fixture = () => ({ [idKey]: 'record-1', data: { label: 'original', items: [{ value: 1 }] } });

  test(`${name}: base contract requires implementation`, async () => {
    const repository = new Contract();
    await assert.rejects(repository.getById('record-1'), /must be implemented/);
    await assert.rejects(repository.save(fixture()), /must be implemented/);
  });

  test(`${name}: save/get and replacement by ID`, async () => {
    const repository = new Implementation();
    const record = fixture();
    assert.equal(await repository.save(record), undefined);
    assert.deepEqual(await repository.getById('record-1'), record);
    const replacement = { [idKey]: 'record-1', data: { label: 'replacement' } };
    await repository.save(replacement);
    assert.deepEqual(await repository.getById('record-1'), replacement);
  });

  test(`${name}: missing ID returns null without creating a record`, async () => {
    const repository = new Implementation();
    await repository.save(fixture());
    assert.equal(await repository.getById('missing'), null);
    assert.equal(await repository.getById('missing'), null);
    assert.equal(await new Implementation().getById('record-1'), null);
  });

  test(`${name}: original object mutations do not change stored data`, async () => {
    const repository = new Implementation();
    const record = fixture();
    await repository.save(record);
    record[idKey] = 'changed';
    record.data.label = 'changed';
    record.data.items[0].value = 99;
    record.data.items.push({ value: 2 });
    assert.deepEqual(await repository.getById('record-1'), fixture());
    assert.equal(await repository.getById('changed'), null);
  });

  test(`${name}: returned object mutations do not change stored data`, async () => {
    const repository = new Implementation();
    await repository.save(fixture());
    const result = await repository.getById('record-1');
    result[idKey] = 'changed';
    result.data.label = 'changed';
    result.data.items[0].value = 99;
    result.data.items.push({ value: 2 });
    assert.deepEqual(await repository.getById('record-1'), fixture());
    assert.equal(await repository.getById('changed'), null);
  });

  test(`${name}: save rejects missing or invalid IDs`, async () => {
    const repository = new Implementation();
    for (const record of [null, {}, { [idKey]: '' }, { [idKey]: 123 }]) {
      await assert.rejects(repository.save(record), TypeError);
    }
    assert.equal(await repository.getById(undefined), null);
  });
}

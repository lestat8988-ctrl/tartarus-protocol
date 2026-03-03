/**
 * Load and evaluate public/game-data.js safely.
 * Uses fs + path + new Function (fallback for vm) with mocked window.
 * Returns window.GAME_DATA.
 */
const fs = require('fs');
const path = require('path');

function loadGameData() {
  const gameDataPath = path.resolve(__dirname, '../../public/game-data.js');
  const raw = fs.readFileSync(gameDataPath, 'utf8');

  const window = {};
  const fn = new Function('window', raw + '\nreturn window;');
  fn(window);

  if (!window.GAME_DATA) {
    throw new Error('loadGameData: window.GAME_DATA not found after evaluation');
  }

  const data = window.GAME_DATA;
  const required = [
    'crew',
    'statusResponses',
    'interrogateResponses',
    'cctvResponses',
    'engineResponses',
    'genericResponses',
    'killDescriptions',
    'witnessTestimonies',
    'accuseVictory',
    'accuseDefeat'
  ];
  for (const key of required) {
    if (!(key in data)) {
      throw new Error(`loadGameData: missing required key: ${key}`);
    }
  }

  return data;
}

module.exports = { loadGameData };

/**
 * TartarusEngine - Deterministic game engine for Tartarus Protocol
 * CommonJS, no DOM APIs.
 */
const { loadGameData } = require('./loadGameData');

const GAME_DATA = loadGameData();

function seedToState(seed) {
  let h = 0;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function mulberry32Next(state) {
  let t = (state + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = (t ^ (t >>> 14)) >>> 0;
  const newState = (state + 0x6d2b79f5) >>> 0;
  return { value, state: newState };
}

function pickFromArray(arr, rng) {
  const { value, state } = mulberry32Next(rng);
  const idx = value % arr.length;
  return { item: arr[idx], state };
}

function TartarusEngine(opts = {}) {
  const { seed = 'default', rngState = null } = opts;
  this.seed = seed;
  this.rngState = rngState;
}

TartarusEngine.prototype.calculateNextState = function (opts = {}) {
  const { history = [], rngState = null, action = null } = opts;
  const effectiveHistory = action ? [...history, action] : history;

  let currentRng = rngState !== null ? rngState : seedToState(this.seed);
  let resultText = 'System: [WAITING FOR INPUT]';
  let deadCrew = [];
  let isGameOver = false;
  let imposter = null;

  if (effectiveHistory.length === 0) {
    return {
      resultText,
      rngState: currentRng,
      deadCrew,
      isGameOver,
      actualImposter: imposter
    };
  }

  // Pick imposter once at start of replay
  const pickResult = pickFromArray(GAME_DATA.crew, currentRng);
  imposter = pickResult.item;
  currentRng = pickResult.state;

  const crew = GAME_DATA.crew.slice();

  for (let i = 0; i < effectiveHistory.length; i++) {
    const act = effectiveHistory[i];
    const type = act.type || 'message';

    if (type === 'accuse') {
      const target = act.target || '';
      const won = target === imposter;
      const templates = won ? GAME_DATA.accuseVictory : GAME_DATA.accuseDefeat;
      const { item: msg, state } = pickFromArray(templates, currentRng);
      currentRng = state;
      resultText = msg.replace(/\{0\}/g, imposter);
      isGameOver = true;
      break;
    }

    if (type === 'wait') {
      const alive = crew.filter((c) => !deadCrew.includes(c) && c !== imposter);
      if (alive.length === 0) {
        resultText = 'TOTAL SYSTEM FAILURE. All crew members terminated.';
        isGameOver = true;
        break;
      }
      const { item: victim, state } = pickFromArray(alive, currentRng);
      currentRng = state;
      deadCrew = [...deadCrew, victim];
      resultText = GAME_DATA.killDescriptions[victim] || `System: ${victim} terminated.`;

      const witnesses = crew.filter((c) => !deadCrew.includes(c) && c !== victim);
      if (witnesses.length > 0) {
        const { value, state: s2 } = mulberry32Next(currentRng);
        currentRng = s2;
        if ((value / 0xffffffff) < 0.6) {
          const { item: witness, state: s3 } = pickFromArray(witnesses, currentRng);
          currentRng = s3;
          const testimonies = GAME_DATA.witnessTestimonies[witness];
          if (testimonies && testimonies.length > 0) {
            const { item: testimony, state: s4 } = pickFromArray(testimonies, currentRng);
            currentRng = s4;
            resultText = resultText + '\n' + testimony;
          }
        }
      }

      const stillAlive = crew.filter((c) => !deadCrew.includes(c) && c !== imposter);
      if (stillAlive.length === 0) {
        resultText = 'TOTAL SYSTEM FAILURE. All crew members terminated.';
        isGameOver = true;
        break;
      }
      continue;
    }

    // message
    const text = (act.text || '').toUpperCase();
    let responses;
    if (text.includes('INTERROGATE')) responses = GAME_DATA.interrogateResponses;
    else if (text.includes('CCTV')) responses = GAME_DATA.cctvResponses;
    else if (text.includes('ENGINE')) responses = GAME_DATA.engineResponses;
    else if (text.includes('STATUS')) responses = GAME_DATA.statusResponses;
    else responses = GAME_DATA.genericResponses;

    const { item: msg, state } = pickFromArray(responses, currentRng);
    currentRng = state;
    resultText = msg;
  }

  return {
    resultText,
    rngState: currentRng,
    deadCrew,
    isGameOver,
    actualImposter: imposter
  };
};

module.exports = { TartarusEngine, GAME_DATA };

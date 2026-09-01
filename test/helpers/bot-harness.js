'use strict';

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

// dotenv must never restore real credentials during Phase 1 tests. Non-empty
// sentinels also make accidental provider construction observable through fakes.
const BLOCKED_ENV = {
  NODE_ENV: 'test',
  ENABLE_TELEGRAM_POLLING: 'false',
  TELEGRAM_BOT_TOKEN: 'phase1-fake-telegram-token',
  OPENAI_API_KEY: 'phase1-fake-openai-key',
  DEEPSEEK_API_KEY: 'phase1-fake-deepseek-key',
  OPENROUTER_API_KEY: 'phase1-fake-openrouter-key',
  SUPABASE_URL: 'https://phase1.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'phase1-fake-supabase-key',
  SUPABASE_ANON_KEY: 'phase1-fake-supabase-anon-key',
  TELEGRAM_DIALOGUE_MODEL: 'phase1-fake-model',
  TELEGRAM_DIALOGUE_MODEL_L2: 'phase1-fake-model',
  FREE_INPUT_PARSE_MODE: 'off'
};

for (const [key, value] of Object.entries(BLOCKED_ENV)) process.env[key] = value;

const calls = {
  aiConstructed: 0,
  aiRequests: 0,
  supabaseConstructed: 0,
  telegramConstructed: 0,
  rngCalls: 0
};

// The test process owns this global. Production code is loaded only after the
// deterministic RNG is installed, so any hidden Math.random dependency is safe.
Math.random = () => {
  calls.rngCalls += 1;
  return 0;
};

function replaceModule(moduleName, exportsValue) {
  const filename = require.resolve(moduleName, { paths: [ROOT] });
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports: exportsValue,
    children: [],
    paths: []
  };
}

class FakeOpenAI {
  constructor() {
    calls.aiConstructed += 1;
    this.chat = {
      completions: {
        create: async () => {
          calls.aiRequests += 1;
          throw new Error('PHASE1_FAKE_AI_UNAVAILABLE');
        }
      }
    };
  }
}

class FakeTelegramBot {
  constructor() {
    calls.telegramConstructed += 1;
    throw new Error('PHASE1_TELEGRAM_POLLING_FORBIDDEN');
  }
}

replaceModule('openai', { OpenAI: FakeOpenAI, default: FakeOpenAI });
replaceModule('@supabase/supabase-js', {
  createClient() {
    calls.supabaseConstructed += 1;
    throw new Error('PHASE1_SUPABASE_NETWORK_FORBIDDEN');
  }
});
replaceModule('node-telegram-bot-api', FakeTelegramBot);

const bot = require(path.join(ROOT, 'telegram', 'bot', 'bot.js'));
const matchStore = require(path.join(ROOT, 'core', 'state', 'matchStore.js'));
const playerStore = require(path.join(ROOT, 'core', 'state', 'playerStore.js'));

const STARTED_AT = '2026-01-01T00:00:00.000Z';
const NOW = new Date(STARTED_AT);

function defaultGameState(overrides = {}) {
  return {
    clues: [],
    pistol_holder: null,
    dead_roles: [],
    accuse_history: [],
    game_over: false,
    outcome: null,
    triggered_kill_marks: [],
    ...overrides
  };
}

function seedMatch({
  playerId,
  matchId = 'phase1-match-' + playerId,
  locale = 'ko',
  hiddenHostRole = 'engineer',
  turn = 1,
  gameState = {},
  events = []
}) {
  const state = defaultGameState({ locale, ...gameState });
  const match = {
    match_id: matchId,
    turn,
    started_at: STARTED_AT,
    deadline_at: '2026-01-01T00:07:00.000Z',
    game_state: state,
    hidden_host_role: hiddenHostRole,
    events: events.map((event) => ({ ...event }))
  };
  matchStore._store.set(matchId, match);
  playerStore._store.set(playerId, {
    match_id: matchId,
    role: 'captain',
    joined_at: STARTED_AT
  });
  return match;
}

function resetState() {
  matchStore._store.clear();
  playerStore._store.clear();
  calls.aiConstructed = 0;
  calls.aiRequests = 0;
  calls.telegramConstructed = 0;
  calls.rngCalls = 0;
}

module.exports = {
  bot,
  matchStore,
  playerStore,
  calls,
  seedMatch,
  resetState,
  STARTED_AT,
  NOW
};

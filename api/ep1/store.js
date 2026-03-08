/**
 * api/ep1/store.js - 1편 전용 최소 상태 저장소 (module-scope memory)
 *
 * TODO: 실운영용 durable store 필요 (Supabase, Redis, DB 등)
 * 현재는 빠른 검증용 in-memory store.
 */

const VALID_ROLES = new Set(['captain', 'doctor', 'engineer', 'navigator', 'pilot']);
const VALID_ACTIONS = new Set(['QUESTION', 'OBSERVE', 'CHECK_LOG', 'REPAIR', 'ACCUSE', 'WAIT']);

const matches = new Map();

function createDefaultMatchState(matchId) {
  return {
    match_id: matchId,
    turn: 1,
    phase: 'playing',
    location: 'bridge',
    events: [],
    public_events: [],
    crew_status: {
      doctor: { alive: true, role: 'doctor' },
      engineer: { alive: true, role: 'engineer' },
      navigator: { alive: true, role: 'navigator' },
      pilot: { alive: true, role: 'pilot' }
    },
    game_over: false,
    outcome: null
  };
}

function normalizeRole(r) {
  if (!r || typeof r !== 'string') return null;
  const s = String(r).trim().toLowerCase();
  return VALID_ROLES.has(s) ? s : null;
}

function normalizeAction(a) {
  if (!a || typeof a !== 'string') return 'WAIT';
  const s = String(a).trim().toUpperCase();
  return VALID_ACTIONS.has(s) ? s : 'WAIT';
}

function makePublicEventSummary(actor, role, action, target, dialogue) {
  const roleLabel = role || actor || 'unknown';
  const act = (action || 'acted').toLowerCase();
  if (target) {
    return `${roleLabel} ${act} (target: ${target})`;
  }
  const snip = (dialogue || '').slice(0, 40);
  return snip ? `${roleLabel}: ${snip}${snip.length >= 40 ? '...' : ''}` : `${roleLabel} ${act}`;
}

function getOrCreateMatch(matchId) {
  let m = matches.get(matchId);
  if (!m) {
    m = createDefaultMatchState(matchId);
    matches.set(matchId, m);
  }
  return m;
}

function appendEvent(match, payload) {
  const event = {
    turn: match.turn,
    actor: payload.actor,
    role: payload.role,
    action: payload.action,
    target: payload.target ?? null,
    reason: payload.reason ?? null,
    dialogue: payload.dialogue ?? null,
    ts: Date.now()
  };
  match.events.push(event);
  const summary = makePublicEventSummary(
    payload.actor,
    payload.role,
    payload.action,
    payload.target,
    payload.dialogue
  );
  match.public_events.push({ turn: match.turn, summary });
}

module.exports = {
  getOrCreateMatch,
  appendEvent,
  createDefaultMatchState,
  normalizeRole,
  normalizeAction,
  VALID_ROLES,
  VALID_ACTIONS
};

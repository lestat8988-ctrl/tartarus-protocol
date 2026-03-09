/**
 * api/ep1/store.js - 1편 전용 Supabase 기반 저장소
 *
 * 테이블: public.ep1_matches, public.ep1_events
 * TODO: clue resolution, accuse resolution, pistol/fire resolution, death/win-loss resolution, hidden truth
 */
const { createClient } = require('@supabase/supabase-js');

const VALID_ROLES = new Set(['captain', 'doctor', 'engineer', 'navigator', 'pilot']);
const VALID_ACTIONS = new Set(['QUESTION', 'OBSERVE', 'CHECK_LOG', 'REPAIR', 'ACCUSE', 'WAIT']);

const ROLE_LABELS = { captain: 'Captain', doctor: 'Doctor', engineer: 'Engineer', navigator: 'Navigator', pilot: 'Pilot' };
const TARGET_LABELS = { player: 'the captain', captain: 'the captain', doctor: 'the doctor', engineer: 'the engineer', navigator: 'the navigator', pilot: 'the pilot' };

const DEFAULT_CREW_STATUS = {
  doctor: { status: 'alive' },
  engineer: { status: 'alive' },
  navigator: { status: 'alive' },
  pilot: { status: 'alive' }
};

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    || process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key);
}

function makeReadableSummary(role, action, target, dialogue) {
  const r = ROLE_LABELS[role] || role || 'Unknown';
  const a = String(action || 'WAIT').toUpperCase();
  const t = target ? (TARGET_LABELS[String(target).toLowerCase()] || target) : null;

  switch (a) {
    case 'QUESTION':
      return t ? `${r} questioned ${t}.` : `${r} asked for clarification.`;
    case 'OBSERVE':
      return role === 'captain' ? `${r} observed the bridge.` : `${r} observed the situation.`;
    case 'CHECK_LOG':
      return `${r} checked ship logs.`;
    case 'REPAIR':
      return `${r} performed repairs.`;
    case 'ACCUSE':
      return t ? `${r} accused ${t}.` : `${r} made an accusation.`;
    case 'WAIT':
      return `${r} held position.`;
    default:
      break;
  }
  if (t) return `${r} ${a.toLowerCase()} (target: ${t}).`;
  const d = (dialogue || '').slice(0, 50);
  return d ? `${r}: ${d}${d.length >= 50 ? '...' : ''}` : `${r} acted.`;
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

async function getMatch(matchId) {
  const sb = getSupabaseClient();
  if (!sb) return null;
  const { data, error } = await sb.from('ep1_matches').select('*').eq('match_id', matchId).maybeSingle();
  if (error) return null;
  return data;
}

async function createMatchIfMissing(matchId) {
  const sb = getSupabaseClient();
  if (!sb) return null;

  const existing = await getMatch(matchId);
  if (existing) return existing;

  const row = {
    match_id: matchId,
    turn: 1,
    phase: 'playing',
    location: 'bridge',
    game_over: false,
    outcome: null,
    crew_status: DEFAULT_CREW_STATUS,
    public_events: []
  };

  const { data, error } = await sb.from('ep1_matches').upsert(row, { onConflict: 'match_id' }).select().single();
  if (error) return null;

  await sb.from('ep1_events').insert({
    match_id: matchId,
    turn: 1,
    actor: 'system',
    role: 'system',
    action: 'INTRO',
    target: null,
    reason: null,
    dialogue: null,
    server_result: { summary: 'AXIS emergency briefing initiated.' }
  });

  const updated = await getMatch(matchId);
  if (updated && Array.isArray(updated.public_events)) {
    updated.public_events.push({ turn: 1, summary: 'AXIS emergency briefing initiated.' });
    await updateMatch(matchId, { public_events: updated.public_events });
  }
  return await getMatch(matchId);
}

async function getOrCreateMatch(matchId) {
  const m = await getMatch(matchId);
  if (m) return m;
  return createMatchIfMissing(matchId);
}

async function appendEvent(matchId, payload, summary, serverResult) {
  const sb = getSupabaseClient();
  if (!sb) return false;

  const match = await getMatch(matchId);
  if (!match) return false;

  const turn = match.turn || 1;

  const { error: evError } = await sb.from('ep1_events').insert({
    match_id: matchId,
    turn,
    actor: payload.actor ?? null,
    role: payload.role ?? null,
    action: payload.action ?? null,
    target: payload.target ?? null,
    reason: payload.reason ?? null,
    dialogue: payload.dialogue ?? null,
    server_result: serverResult ?? { summary }
  });

  if (evError) return false;

  const pub = Array.isArray(match.public_events) ? [...match.public_events] : [];
  pub.push({ turn, summary: summary || makeReadableSummary(payload.role, payload.action, payload.target, payload.dialogue) });

  await updateMatch(matchId, { public_events: pub });
  return true;
}

async function updateMatch(matchId, patch) {
  const sb = getSupabaseClient();
  if (!sb) return false;
  const { error } = await sb.from('ep1_matches').update(patch).eq('match_id', matchId);
  return !error;
}

async function getRecentEvents(matchId, limit = 5) {
  const sb = getSupabaseClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('ep1_events')
    .select('*')
    .eq('match_id', matchId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data || []).reverse();
}

async function getEventsCount(matchId) {
  const sb = getSupabaseClient();
  if (!sb) return 0;
  const { count, error } = await sb.from('ep1_events').select('*', { count: 'exact', head: true }).eq('match_id', matchId);
  if (error) return 0;
  return count ?? 0;
}

async function getPublicEvents(matchId) {
  const match = await getMatch(matchId);
  if (!match) return [];
  return Array.isArray(match.public_events) ? match.public_events : [];
}

module.exports = {
  getSupabaseClient,
  getMatch,
  createMatchIfMissing,
  getOrCreateMatch,
  appendEvent,
  updateMatch,
  getRecentEvents,
  getEventsCount,
  getPublicEvents,
  makeReadableSummary,
  normalizeRole,
  normalizeAction,
  VALID_ROLES,
  VALID_ACTIONS
};

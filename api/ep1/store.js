/**
 * api/ep1/store.js - 1편 전용 Supabase 기반 저장소
 *
 * 테이블: public.ep1_matches, public.ep1_events
 * ep1_matches 서버 전용 필드: hidden_host_role (text), private_state (jsonb)
 *   - migration 필요 시: ALTER TABLE ep1_matches ADD COLUMN IF NOT EXISTS hidden_host_role text;
 *   - ALTER TABLE ep1_matches ADD COLUMN IF NOT EXISTS private_state jsonb;
 *
 * ep1_events full event 컬럼 (recent_events dialogue 렌더링용):
 *   - target (text nullable), reason (text nullable), dialogue (text nullable), server_result (jsonb nullable)
 *   - migration 필요 시:
 *     ALTER TABLE ep1_events ADD COLUMN IF NOT EXISTS target text;
 *     ALTER TABLE ep1_events ADD COLUMN IF NOT EXISTS reason text;
 *     ALTER TABLE ep1_events ADD COLUMN IF NOT EXISTS dialogue text;
 *     ALTER TABLE ep1_events ADD COLUMN IF NOT EXISTS server_result jsonb;
 *
 * TODO: clue resolution, accuse resolution, pistol/fire resolution, death/win-loss resolution, hidden truth
 */
const { createClient } = require('@supabase/supabase-js');

const VALID_ROLES = new Set(['captain', 'doctor', 'engineer', 'navigator', 'pilot']);
const CREW_ROLES = ['doctor', 'engineer', 'navigator', 'pilot'];
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

function pickRandomFrom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * hidden_host_role에 따라 role별 private note 생성.
 * 중첩체인 role은 자기 보호/회피 성향, 나머지는 의심/추적 성향.
 */
function generateRolePrivateNotes(hiddenHostRole) {
  const seed = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const notes = { doctor: '', engineer: '', navigator: '', pilot: '' };

  const hostNotes = {
    doctor: '자기 감정 반응을 조금 늦게 처리. 생체/감정 질문엔 조심. 지나치게 정상처럼 보이려 함.',
    engineer: '시스템/로그 쪽으로 화제를 돌리려 함. 사람 심문보다 기계 문제로 몰아가려 함.',
    navigator: '동선 추궁은 강하지만 자기 시간축 질문은 흐리게 답할 수 있음.',
    pilot: '분위기/직감 얘기는 많이 하지만 결정적 순간엔 회피할 수 있음.'
  };

  const nonHostTemplates = {
    doctor: ['pilot가 너무 차분하다고 느낀다.', 'engineer 반응이 어긋난다.', 'navigator의 동선 설명이 애매하다.'],
    engineer: ['로그 불일치를 의심한다.', 'navigator 위치 기록이 이상하다.', 'pilot의 보고 타이밍이 수상하다.'],
    navigator: ['시간 순서를 집요하게 본다.', 'doctor 동선이 비어 있다.', 'engineer가 로그만 강조한다.'],
    pilot: ['분위기 변화를 감지한다.', 'navigator가 질문을 흐린다.', 'doctor 반응이 늦었다.']
  };

  for (const role of CREW_ROLES) {
    if (role === hiddenHostRole) {
      notes[role] = hostNotes[role] || '';
    } else {
      const opts = nonHostTemplates[role] || [];
      const idx = (seed.length + role.length) % Math.max(1, opts.length);
      notes[role] = opts[idx] || '';
    }
  }
  return notes;
}

/**
 * viewer_role용 private_context 생성. hidden_host_role 전체값은 노출하지 않음.
 * viewer_role이 중첩체면 is_hidden_host: true만 해당 context 안에서 허용.
 */
function getPrivateContextForRole(match, viewerRole) {
  if (!match || !viewerRole || !CREW_ROLES.includes(viewerRole)) return null;
  const ps = match.private_state;
  if (!ps || typeof ps !== 'object') return null;
  const notes = ps.role_private_notes || {};
  const hiddenHost = match.hidden_host_role;
  const isHost = hiddenHost === viewerRole;
  const note = notes[viewerRole] || '';
  const suspicionBias = isHost ? '질문을 피하거나 화제를 돌리거나 과잉방어하지 말고, 미묘한 차이만 허용.' : '자기 관점의 의심과 불일치를 자연스럽게 말하라.';
  return {
    you_are: viewerRole,
    private_note: note,
    suspicion_bias: suspicionBias,
    is_hidden_host: isHost
  };
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

  const hiddenHostRole = pickRandomFrom(CREW_ROLES);
  const rolePrivateNotes = generateRolePrivateNotes(hiddenHostRole);
  const privateState = {
    hidden_host_role: hiddenHostRole,
    seed_hint: Date.now().toString(36),
    role_private_notes: rolePrivateNotes
  };

  const row = {
    match_id: matchId,
    turn: 1,
    phase: 'playing',
    location: 'bridge',
    game_over: false,
    outcome: null,
    crew_status: DEFAULT_CREW_STATUS,
    public_events: [],
    hidden_host_role: hiddenHostRole,
    private_state: privateState
  };

  const { data, error } = await sb.from('ep1_matches').upsert(row, { onConflict: 'match_id' }).select().single();
  if (error) return null;

  const introSummaryKo = 'AXIS 긴급 브리핑이 시작되었다.';
  await sb.from('ep1_events').insert({
    match_id: matchId,
    turn: 1,
    actor: 'system',
    role: 'system',
    action: 'INTRO',
    target: null,
    reason: null,
    dialogue: null,
    server_result: { summary: introSummaryKo }
  });

  const updated = await getMatch(matchId);
  if (updated && Array.isArray(updated.public_events)) {
    updated.public_events.push({ turn: 1, summary: introSummaryKo });
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
  const role = payload.role ?? null;

  if (role) {
    const { data: existing } = await sb
      .from('ep1_events')
      .select('turn')
      .eq('match_id', matchId)
      .eq('turn', turn)
      .eq('role', role)
      .limit(1)
      .maybeSingle();
    if (existing) return true;
  }

  const { error: evError } = await sb.from('ep1_events').insert({
    match_id: matchId,
    turn,
    actor: payload.actor ?? null,
    role,
    action: payload.action ?? null,
    target: payload.target ?? null,
    reason: payload.reason ?? null,
    dialogue: payload.dialogue ?? null,
    server_result: serverResult ?? { summary }
  });

  if (evError) return false;

  const pub = Array.isArray(match.public_events) ? [...match.public_events] : [];
  const summaryText = summary || makeReadableSummary(payload.role, payload.action, payload.target, payload.dialogue);
  pub.push({ turn, summary: summaryText });

  const patch = { public_events: pub };
  if (role === 'pilot') {
    patch.turn = turn + 1;
  }
  await updateMatch(matchId, patch);
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

/**
 * recent_events용 full event 조회.
 * target, reason, dialogue, server_result 절대 누락 금지.
 * summary는 server_result.summary 기반 계산값.
 */
const RECENT_EVENTS_SELECT = 'turn, actor, role, action, target, reason, dialogue, server_result, created_at';

async function getRecentEventsForCurrentTurn(matchId) {
  const sb = getSupabaseClient();
  if (!sb) return [];
  const { data: latest } = await sb
    .from('ep1_events')
    .select('turn')
    .eq('match_id', matchId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const turn = latest?.turn ?? 1;
  const { data, error } = await sb
    .from('ep1_events')
    .select(RECENT_EVENTS_SELECT)
    .eq('match_id', matchId)
    .eq('turn', turn)
    .order('created_at', { ascending: true });
  if (error) return [];
  return (data || []).filter((e) => e.role && VALID_ROLES.has(e.role));
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

/**
 * full event 반환. target, reason, dialogue, server_result 절대 누락 금지.
 * summary는 server_result.summary 기반 계산 (DB 컬럼 아님).
 * 과거 이벤트 null-safe.
 */
function formatEventForResponse(e) {
  if (!e) return null;
  const sr = e.server_result;
  const summary = (sr && typeof sr === 'object' && sr.summary) || e.summary || (e.role && e.action ? `${e.role} ${e.action}` : '') || '';
  return {
    turn: e.turn ?? null,
    actor: e.actor ?? null,
    role: e.role ?? null,
    action: e.action ?? null,
    target: e.target ?? null,
    reason: e.reason ?? null,
    dialogue: e.dialogue ?? null,
    summary,
    server_result: sr ?? null,
    created_at: e.created_at ?? null
  };
}

module.exports = {
  getSupabaseClient,
  getMatch,
  createMatchIfMissing,
  getOrCreateMatch,
  appendEvent,
  updateMatch,
  getRecentEvents,
  getRecentEventsForCurrentTurn,
  getPublicEvents,
  formatEventForResponse,
  getEventsCount,
  makeReadableSummary,
  normalizeRole,
  normalizeAction,
  getPrivateContextForRole,
  VALID_ROLES,
  VALID_ACTIONS,
  CREW_ROLES
};

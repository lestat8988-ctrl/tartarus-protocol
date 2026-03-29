/**
 * telegram/bot/bot.js - 텔레그램 봇 진입점
 * bot → parser → engine → state 저장 흐름 연결.
 * BOT TOKEN 없이도 handleTextMessage()로 로컬 테스트 가능.
 * 로컬 개발용 HTTP API (포트 8788) 지원.
 */

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const matchStore = require('../../core/state/matchStore');
const playerStore = require('../../core/state/playerStore');
const ep1Engine = require('../../core/engine/ep1Engine');
const intentParser = require('../../core/nlu/intentParser');
const timers = require('../../core/engine/timers');
const kills = require('../../core/engine/kills');
const winlose = require('../../core/engine/winlose');
/** OpenAI 공식 SDK — 대사 생성은 callChatCompletionsJson → chat.completions.create 만 사용 (Responses API 미사용). */
const { OpenAI } = require('openai');

const API_PORT = 8788;

/** -------------------------------------------------------------------------
 * DB persistence skeleton: user_entitlements / match_sessions / match_events
 * In-memory always; optional Supabase when SUPABASE_URL + key are set.
 * Never throws — failures are console.warn only; game flow continues.
 * ------------------------------------------------------------------------- */

let _dbBootLogged = false;
function logDbBootOnce() {
  if (_dbBootLogged) return;
  _dbBootLogged = true;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    console.log(
      '[bot] db TODO: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY|ANON_KEY for remote tables user_entitlements, match_sessions, match_events — using in-memory skeleton'
    );
  }
}

let _supabaseCache = undefined;
function getSupabaseOptional() {
  if (_supabaseCache !== undefined) return _supabaseCache;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    _supabaseCache = null;
    return null;
  }
  try {
    const { createClient } = require('@supabase/supabase-js');
    _supabaseCache = createClient(url, key);
    return _supabaseCache;
  } catch (e) {
    console.warn('[bot] db Supabase client init failed', e?.message || e);
    _supabaseCache = null;
    return null;
  }
}

const dbUserEntitlementsMemory = new Map();
const dbMatchSessionsMemory = new Map();
const dbMatchEventsMemory = [];
let _dbMatchEventSeq = 0;

/**
 * user_key: 텔레그램 user id(=playerId) 우선 → 없으면 match_id 기반 session → 최후 anonymous
 */
function resolveUserKey(playerId, matchId) {
  const p = String(playerId || '').trim();
  if (p) return p;
  const m = String(matchId || '').trim();
  if (m) return 'session:' + m;
  return 'anonymous';
}

/** DB public.user_entitlements와 동일한 기본 스키마 (Supabase upsert payload) */
function defaultEntitlementRow(userKey) {
  const now = new Date().toISOString();
  return {
    user_key: String(userKey || 'anonymous'),
    clearance_level: 1,
    is_premium: false,
    daily_ticket_limit: 3,
    daily_ticket_used: 0,
    daily_free_prompt_limit: 5,
    daily_free_prompt_used: 0,
    daily_ticket_reset_at: now,
    daily_free_prompt_reset_at: now,
    updated_at: now
  };
}

/** Asia/Seoul calendar day key YYYY-MM-DD */
function getSeoulDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * 확장: clearance_level / is_premium에 따라 limit를 바꿀 때 여기만 조정.
 * @param {object} entitlement
 */
function getEntitlementLimits(entitlement) {
  const clearance_level = entitlement?.clearance_level != null ? Number(entitlement.clearance_level) : 1;
  const is_premium = !!entitlement?.is_premium;
  let daily_ticket_limit = Number(entitlement?.daily_ticket_limit);
  if (!Number.isFinite(daily_ticket_limit) || daily_ticket_limit < 0) daily_ticket_limit = 3;
  let daily_free_prompt_limit = Number(entitlement?.daily_free_prompt_limit);
  if (!Number.isFinite(daily_free_prompt_limit) || daily_free_prompt_limit < 0) daily_free_prompt_limit = 5;
  // Future: tier 2+ / premium — 예: if (clearance_level >= 2 && is_premium) { daily_ticket_limit = 10; }
  void clearance_level;
  void is_premium;
  return {
    clearance_level: Number.isFinite(clearance_level) ? clearance_level : 1,
    is_premium,
    daily_ticket_limit,
    daily_free_prompt_limit
  };
}

function buildEntitlementSnapshot(ent) {
  if (!ent) return null;
  const lim = getEntitlementLimits(ent);
  return {
    clearance_level: lim.clearance_level,
    is_premium: lim.is_premium,
    daily_ticket_limit: lim.daily_ticket_limit,
    daily_ticket_used: ent.daily_ticket_used ?? 0,
    daily_free_prompt_limit: lim.daily_free_prompt_limit,
    daily_free_prompt_used: ent.daily_free_prompt_used ?? 0
  };
}

/**
 * Seoul 자정 기준 일일 카운터 — reset_at의 날짜와 오늘(Seoul)이 다르면 used 0 + reset_at 갱신.
 * @returns {{ ent: object, changed: boolean }}
 */
function resetEntitlementCountersIfNeeded(ent, now = new Date()) {
  const e = { ...ent };
  let changed = false;
  const todayKey = getSeoulDateKey(now);
  const ticketKey = e.daily_ticket_reset_at ? getSeoulDateKey(new Date(e.daily_ticket_reset_at)) : null;
  if (!e.daily_ticket_reset_at || ticketKey !== todayKey) {
    e.daily_ticket_used = 0;
    e.daily_ticket_reset_at = now.toISOString();
    changed = true;
  }
  const promptKey = e.daily_free_prompt_reset_at ? getSeoulDateKey(new Date(e.daily_free_prompt_reset_at)) : null;
  if (!e.daily_free_prompt_reset_at || promptKey !== todayKey) {
    e.daily_free_prompt_used = 0;
    e.daily_free_prompt_reset_at = now.toISOString();
    changed = true;
  }
  return { ent: e, changed };
}

async function fetchUserEntitlementRow(userKey) {
  const key = String(userKey || 'anonymous');
  logDbBootOnce();
  const sb = getSupabaseOptional();
  if (sb) {
    try {
      const { data, error } = await sb.from('user_entitlements').select('*').eq('user_key', key).maybeSingle();
      if (error) {
        console.warn(
          '[bot][db] entitlement fetch warn user_key=' + key + ' error=' + String(error.message || error)
        );
      }
      if (data && typeof data === 'object') {
        const merged = { ...defaultEntitlementRow(key), ...data };
        dbUserEntitlementsMemory.set(key, merged);
        return merged;
      }
    } catch (e) {
      console.warn('[bot][db] entitlement fetch warn user_key=' + key + ' error=' + String(e?.message || e));
    }
  }
  const mem = dbUserEntitlementsMemory.get(key);
  if (mem) return { ...defaultEntitlementRow(key), ...mem };
  const row = defaultEntitlementRow(key);
  dbUserEntitlementsMemory.set(key, row);
  return row;
}

function buildEntitlementBlockedResponse(locale, blockReason, entitlementRow, extra = {}) {
  const koTicket = '오늘의 입장권을 모두 사용했습니다. 내일 다시 시도하거나 상위 보안등급을 이용하세요.';
  const koPrompt = '오늘의 자유입력 횟수를 모두 사용했습니다. 버튼 액션은 계속 사용할 수 있습니다.';
  const enTicket =
    'You have used all daily entry tickets. Please try again tomorrow or use a higher clearance tier.';
  const enPrompt =
    'You have used all daily free-text prompts for today. Button actions are still available.';
  const isTicket = blockReason === 'daily_ticket_limit_reached';
  const notice = locale === 'en' ? (isTicket ? enTicket : enPrompt) : isTicket ? koTicket : koPrompt;
  return {
    ok: false,
    blocked: true,
    block_reason: blockReason,
    notice,
    message: notice,
    entitlement: buildEntitlementSnapshot(entitlementRow),
    ...extra,
    summary: extra && extra.summary != null ? extra.summary : notice
  };
}

async function consumeDailyTicketIfAllowed(userKey, opts = {}) {
  const k = String(userKey || 'anonymous');
  console.log('[bot][entitlement] ticket consume start user_key=' + k);
  let ent;
  try {
    ent = await fetchUserEntitlementRow(k);
  } catch (e) {
    console.warn('[bot][entitlement] ticket load warn user_key=' + k + ' ' + String(e?.message || e));
    return { allowed: true, fallback: true, entitlement: null };
  }
  const r0 = resetEntitlementCountersIfNeeded(ent);
  ent = r0.ent;
  if (r0.changed) {
    try {
      await upsertUserEntitlement(k, {
        daily_ticket_used: ent.daily_ticket_used,
        daily_ticket_reset_at: ent.daily_ticket_reset_at,
        daily_free_prompt_used: ent.daily_free_prompt_used,
        daily_free_prompt_reset_at: ent.daily_free_prompt_reset_at
      });
    } catch (e) {
      console.warn('[bot][entitlement] ticket reset persist warn user_key=' + k + ' ' + String(e?.message || e));
    }
  }
  const limits = getEntitlementLimits(ent);
  const used = ent.daily_ticket_used ?? 0;
  if (used >= limits.daily_ticket_limit) {
    console.log(
      '[bot][entitlement] ticket blocked user_key=' +
        k +
        ' used=' +
        used +
        ' limit=' +
        limits.daily_ticket_limit
    );
    return { allowed: false, entitlement: ent, block_reason: 'daily_ticket_limit_reached' };
  }
  const nextUsed = used + 1;
  try {
    await upsertUserEntitlement(k, {
      daily_ticket_used: nextUsed,
      daily_ticket_reset_at: ent.daily_ticket_reset_at,
      daily_free_prompt_used: ent.daily_free_prompt_used,
      daily_free_prompt_reset_at: ent.daily_free_prompt_reset_at
    });
    console.log(
      '[bot][entitlement] ticket consume ok user_key=' +
        k +
        ' used=' +
        nextUsed +
        ' limit=' +
        limits.daily_ticket_limit
    );
    return { allowed: true, entitlement: { ...ent, daily_ticket_used: nextUsed } };
  } catch (e) {
    console.warn('[bot][entitlement] ticket persist warn user_key=' + k + ' ' + String(e?.message || e));
    return { allowed: true, fallback: true, entitlement: ent };
  }
}

async function consumeFreePromptIfAllowed(userKey, opts = {}) {
  const k = String(userKey || 'anonymous');
  console.log('[bot][entitlement] prompt consume start user_key=' + k);
  let ent;
  try {
    ent = await fetchUserEntitlementRow(k);
  } catch (e) {
    console.warn('[bot][entitlement] prompt load warn user_key=' + k + ' ' + String(e?.message || e));
    return { allowed: true, fallback: true, entitlement: null };
  }
  const r0 = resetEntitlementCountersIfNeeded(ent);
  ent = r0.ent;
  if (r0.changed) {
    try {
      await upsertUserEntitlement(k, {
        daily_ticket_used: ent.daily_ticket_used,
        daily_ticket_reset_at: ent.daily_ticket_reset_at,
        daily_free_prompt_used: ent.daily_free_prompt_used,
        daily_free_prompt_reset_at: ent.daily_free_prompt_reset_at
      });
    } catch (e) {
      console.warn('[bot][entitlement] prompt reset persist warn user_key=' + k + ' ' + String(e?.message || e));
    }
  }
  const limits = getEntitlementLimits(ent);
  const used = ent.daily_free_prompt_used ?? 0;
  if (used >= limits.daily_free_prompt_limit) {
    console.log(
      '[bot][entitlement] prompt blocked user_key=' +
        k +
        ' used=' +
        used +
        ' limit=' +
        limits.daily_free_prompt_limit
    );
    return { allowed: false, entitlement: ent, block_reason: 'daily_free_prompt_limit_reached' };
  }
  const nextUsed = used + 1;
  try {
    await upsertUserEntitlement(k, {
      daily_ticket_used: ent.daily_ticket_used,
      daily_ticket_reset_at: ent.daily_ticket_reset_at,
      daily_free_prompt_used: nextUsed,
      daily_free_prompt_reset_at: ent.daily_free_prompt_reset_at
    });
    console.log(
      '[bot][entitlement] prompt consume ok user_key=' +
        k +
        ' used=' +
        nextUsed +
        ' limit=' +
        limits.daily_free_prompt_limit
    );
    return { allowed: true, entitlement: { ...ent, daily_free_prompt_used: nextUsed } };
  } catch (e) {
    console.warn('[bot][entitlement] prompt persist warn user_key=' + k + ' ' + String(e?.message || e));
    return { allowed: true, fallback: true, entitlement: ent };
  }
}

/**
 * lore_question만 일일 자유 프롬프트 차갑 대상.
 * group/targeted/suspicion/brief 등 gameplay·오픈 심문은 차갑 없음.
 */
function shouldConsumeFreePromptForMessageKind(cls, parsed, text) {
  void parsed;
  void text;
  if (!cls || !cls.kind) return false;
  return cls.kind === 'lore_question';
}

/** match_events / 로그용 짧은 kind 문자열 */
function getIntentLogKindForPayload(cls, parsed) {
  if (!cls) return 'unknown';
  if (cls.kind === 'state_query') return 'state_query:' + String(cls.subtype || '');
  if (cls.kind === 'mapped') {
    const it = String(parsed?.intent_type || 'unknown').toLowerCase();
    return 'mapped:' + it;
  }
  if (cls.kind === 'targeted_question' && cls.crewGameplayTargetRole) {
    return 'role_question';
  }
  if (cls.kind === 'group_question' && cls.groupSubkind === 'suspicion') {
    return 'suspicion_question';
  }
  return String(cls.kind);
}

function logIntentPromptDecision(cls, parsed, consumesFreePrompt) {
  const kind = getIntentLogKindForPayload(cls, parsed);
  if (cls && cls.crewGameplayTargetRole) {
    try {
      console.log('[bot][intent] role-target detected role=' + cls.crewGameplayTargetRole);
    } catch (e) {}
  }
  console.log(
    '[bot][intent] message kind=' + kind + ' consumes_free_prompt=' + (consumesFreePrompt ? 'true' : 'false')
  );
}

async function enrichResultWithEntitlement(result, playerId) {
  if (!result || result.blocked || result.ok === false) return result;
  try {
    const pl = await playerStore.getPlayer(playerId);
    const mid = pl?.match_id;
    const userKey = resolveUserKey(playerId, mid);
    let ent = await fetchUserEntitlementRow(userKey);
    const r = resetEntitlementCountersIfNeeded(ent);
    ent = r.ent;
    if (r.changed) {
      await upsertUserEntitlement(userKey, {
        daily_ticket_used: ent.daily_ticket_used,
        daily_ticket_reset_at: ent.daily_ticket_reset_at,
        daily_free_prompt_used: ent.daily_free_prompt_used,
        daily_free_prompt_reset_at: ent.daily_free_prompt_reset_at
      });
    }
    result.entitlement = buildEntitlementSnapshot(ent);
  } catch (e) {
    console.warn('[bot][entitlement] enrichResult warn ' + String(e?.message || e));
  }
  return result;
}

function truncateJsonish(obj, maxLen) {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxLen) return obj;
    return { _truncated: true, preview: s.slice(0, maxLen) };
  } catch {
    return { _error: 'serialize' };
  }
}

async function upsertUserEntitlement(userKey, patch = {}) {
  const key = String(userKey || 'anonymous');
  try {
    logDbBootOnce();
    try {
      console.log('[bot][db] entitlement upsert start user_key=' + key);
    } catch (e) {}
    const now = new Date().toISOString();
    const base = defaultEntitlementRow(key);
    const prev = dbUserEntitlementsMemory.get(key);
    const fromPrev = prev
      ? {
          clearance_level: prev.clearance_level,
          is_premium: prev.is_premium,
          daily_ticket_limit: prev.daily_ticket_limit,
          daily_ticket_used: prev.daily_ticket_used,
          daily_free_prompt_limit: prev.daily_free_prompt_limit,
          daily_free_prompt_used: prev.daily_free_prompt_used,
          daily_ticket_reset_at: prev.daily_ticket_reset_at,
          daily_free_prompt_reset_at: prev.daily_free_prompt_reset_at
        }
      : {};
    const merged = { ...base, ...fromPrev, ...patch, user_key: key, updated_at: now };
    if (merged.clearance_level == null) merged.clearance_level = 1;
    if (merged.is_premium == null) merged.is_premium = false;
    if (merged.daily_ticket_limit == null) merged.daily_ticket_limit = 3;
    if (merged.daily_ticket_used == null) merged.daily_ticket_used = 0;
    if (merged.daily_free_prompt_limit == null) merged.daily_free_prompt_limit = 5;
    if (merged.daily_free_prompt_used == null) merged.daily_free_prompt_used = 0;
    if (merged.daily_ticket_reset_at == null) merged.daily_ticket_reset_at = now;
    if (merged.daily_free_prompt_reset_at == null) merged.daily_free_prompt_reset_at = now;
    dbUserEntitlementsMemory.set(key, merged);
    const sb = getSupabaseOptional();
    if (!sb) {
      try {
        console.log('[bot][db] entitlement upsert ok user_key=' + key + ' (memory-only, no Supabase)');
      } catch (e) {}
      return;
    }
    const row = {
      user_key: merged.user_key,
      clearance_level: merged.clearance_level,
      is_premium: merged.is_premium,
      daily_ticket_limit: merged.daily_ticket_limit,
      daily_ticket_used: merged.daily_ticket_used,
      daily_free_prompt_limit: merged.daily_free_prompt_limit,
      daily_free_prompt_used: merged.daily_free_prompt_used,
      daily_ticket_reset_at: merged.daily_ticket_reset_at,
      daily_free_prompt_reset_at: merged.daily_free_prompt_reset_at,
      updated_at: merged.updated_at
    };
    const { error } = await sb.from('user_entitlements').upsert(row, { onConflict: 'user_key' });
    if (error) {
      try {
        console.warn(
          '[bot][db] entitlement upsert warn user_key=' + key + ' error=' + String(error.message || error)
        );
      } catch (e) {}
    } else {
      try {
        console.log('[bot][db] entitlement upsert ok user_key=' + key);
      } catch (e) {}
    }
  } catch (e) {
    try {
      console.warn('[bot][db] entitlement upsert warn user_key=' + key + ' error=' + String(e?.message || e));
    } catch (e2) {}
  }
}

async function upsertMatchState(row) {
  try {
    logDbBootOnce();
    const mid = row?.match_id;
    if (!mid) return;
    const now = new Date().toISOString();
    const prev = dbMatchSessionsMemory.get(mid) || {};
    const next = { ...prev };
    for (const k of Object.keys(row)) {
      if (row[k] !== undefined) next[k] = row[k];
    }
    next.match_id = mid;
    next.updated_at = now;
    if (!next.started_at) next.started_at = prev.started_at || now;
    dbMatchSessionsMemory.set(mid, next);
    const sb = getSupabaseOptional();
    if (sb) {
      try {
        await sb.from('match_sessions').upsert(
          {
            match_id: mid,
            user_key: next.user_key,
            locale: next.locale,
            phase: next.phase,
            remaining_sec: next.remaining_sec,
            game_over: next.game_over,
            started_at: next.started_at,
            updated_at: next.updated_at
          },
          { onConflict: 'match_id' }
        );
      } catch (e) {
        console.warn('[bot] db Supabase match_sessions upsert:', e?.message || e);
      }
    }
  } catch (e) {
    console.warn('[bot] db upsertMatchState failed', e?.message || e);
  }
}

async function appendMatchEvent({ match_id, user_key, event_type, payload }) {
  try {
    logDbBootOnce();
    const mid = match_id;
    if (!mid) return;
    const id = ++_dbMatchEventSeq;
    const created_at = new Date().toISOString();
    const payloadStr =
      typeof payload === 'string' ? payload : JSON.stringify(truncateJsonish(payload, 32000));
    const rec = { id, match_id: mid, user_key, event_type, payload: payloadStr, created_at };
    dbMatchEventsMemory.push(rec);
    if (dbMatchEventsMemory.length > 10000) {
      dbMatchEventsMemory.splice(0, dbMatchEventsMemory.length - 8000);
    }
    const sb = getSupabaseOptional();
    if (sb) {
      try {
        await sb.from('match_events').insert({
          match_id: mid,
          user_key,
          event_type,
          payload: payloadStr,
          created_at
        });
      } catch (e) {
        console.warn('[bot] db Supabase match_events insert:', e?.message || e);
      }
    }
  } catch (e) {
    console.warn('[bot] db appendMatchEvent failed', e?.message || e);
  }
}

async function dbPersistAfterStartState(playerId, locale, out) {
  try {
    const matchId = out?.match_id;
    if (!matchId) return;
    const userKey = resolveUserKey(playerId, matchId);
    await upsertUserEntitlement(userKey, {});
    const match = await matchStore.getMatch(matchId);
    const gs = match?.game_state || out.game_state || {};
    const phase = gs.game_over ? 'game_over' : 'playing';
    await upsertMatchState({
      match_id: matchId,
      user_key: userKey,
      locale,
      phase,
      remaining_sec: out.remaining_sec ?? 0,
      game_over: !!gs.game_over,
      started_at: match?.started_at
    });
    await appendMatchEvent({
      match_id: matchId,
      user_key: userKey,
      event_type: 'session_start',
      payload: { locale, summary: 'start' }
    });
  } catch (e) {
    console.warn('[bot] db persist start failed', e?.message || e);
  }
}

async function dbPersistAfterMessageResult(playerId, locale, inputText, result) {
  try {
    if (!result?.ok) return;
    if (result.blocked) return;
    const player = await playerStore.getPlayer(playerId);
    const matchId = player?.match_id;
    if (!matchId) return;
    const userKey = resolveUserKey(playerId, matchId);
    /** daily_free_prompt_used는 consumeFreePromptIfAllowed에서만 증가 */
    let messageKind = 'unknown';
    let consumesFreePrompt = false;
    try {
      const parsed = applyQuestionLikeIntentGuard(
        String(inputText || ''),
        intentParser.parse(String(inputText || ''))
      );
      const cls = classifyMiniappFreeText(String(inputText || ''), parsed);
      messageKind = getIntentLogKindForPayload(cls, parsed);
      consumesFreePrompt = shouldConsumeFreePromptForMessageKind(cls, parsed, inputText);
    } catch (e) {
      try {
        console.warn('[bot][intent] dbPersist message intent parse warn ' + String(e?.message || e));
      } catch (e2) {}
    }
    const gs = result.match_state || {};
    await upsertMatchState({
      match_id: matchId,
      user_key: userKey,
      locale,
      phase: gs.game_over ? 'game_over' : 'playing',
      remaining_sec: result.remaining_sec ?? 0,
      game_over: !!result.game_over,
      started_at: undefined
    });
    await appendMatchEvent({
      match_id: matchId,
      user_key: userKey,
      event_type: 'message_input',
      payload: {
        text: String(inputText || '').slice(0, 4000),
        message_kind: messageKind,
        consumes_free_prompt: consumesFreePrompt
      }
    });
    await appendMatchEvent({
      match_id: matchId,
      user_key: userKey,
      event_type: 'message_result',
      payload: {
        summary: result.summary,
        recent_events: truncateJsonish(result.recent_events || result.events),
        message_kind: messageKind,
        consumes_free_prompt: consumesFreePrompt
      }
    });
  } catch (e) {
    console.warn('[bot] db persist message failed', e?.message || e);
  }
}

async function dbPersistAfterActionResult(playerId, locale, actionLabel, actionName, targetOpt, result) {
  try {
    if (!result?.ok) return;
    if (result.blocked) return;
    const player = await playerStore.getPlayer(playerId);
    const matchId = player?.match_id;
    if (!matchId) return;
    const userKey = resolveUserKey(playerId, matchId);
    /** 입장권은 새 매치 시작 시에만 차감 — 액션 API에서는 차갑하지 않음 */
    const gs = result.match_state || {};
    await upsertMatchState({
      match_id: matchId,
      user_key: userKey,
      locale,
      phase: gs.game_over ? 'game_over' : 'playing',
      remaining_sec: result.remaining_sec ?? 0,
      game_over: !!result.game_over,
      started_at: undefined
    });
    await appendMatchEvent({
      match_id: matchId,
      user_key: userKey,
      event_type: 'action_' + actionLabel,
      payload: {
        action: actionName,
        target: targetOpt ?? null,
        summary: result.summary,
        recent_events: truncateJsonish(result.recent_events || result.events)
      }
    });
  } catch (e) {
    console.warn('[bot] db persist action failed', e?.message || e);
  }
}

async function dbPersistAfterTelegramStart(playerId) {
  try {
    const player = await playerStore.getPlayer(playerId);
    const matchId = player?.match_id;
    if (!matchId) return;
    const match = await matchStore.getMatch(matchId);
    if (!match) return;
    const locale = 'ko';
    const userKey = resolveUserKey(playerId, matchId);
    await upsertUserEntitlement(userKey, {});
    const gs = match.game_state || {};
    const timer = ep1Engine.getTimerStatus(match);
    await upsertMatchState({
      match_id: matchId,
      user_key: userKey,
      locale,
      phase: gs.game_over ? 'game_over' : 'playing',
      remaining_sec: timer.remaining_sec ?? 0,
      game_over: !!gs.game_over,
      started_at: match.started_at
    });
    await appendMatchEvent({
      match_id: matchId,
      user_key: userKey,
      event_type: 'telegram_start',
      payload: {}
    });
  } catch (e) {
    console.warn('[bot] db persist telegram start failed', e?.message || e);
  }
}

async function dbPersistAfterTelegramTextMessage(playerId, text, opts, reply) {
  try {
    const player = await playerStore.getPlayer(playerId);
    const matchId = player?.match_id;
    if (!matchId) return;
    const match = await matchStore.getMatch(matchId);
    if (!match) return;
    const locale = opts.locale === 'en' ? 'en' : 'ko';
    const userKey = resolveUserKey(playerId, matchId);
    /** 자유입력 차감은 handleTextMessage의 consumeFreePromptIfAllowed에서 처리 */
    const gs = match.game_state || {};
    const timer = ep1Engine.getTimerStatus(match);
    await upsertMatchState({
      match_id: matchId,
      user_key: userKey,
      locale,
      phase: gs.game_over ? 'game_over' : 'playing',
      remaining_sec: timer.remaining_sec ?? 0,
      game_over: !!gs.game_over,
      started_at: match.started_at
    });
    await appendMatchEvent({
      match_id: matchId,
      user_key: userKey,
      event_type: 'telegram_message_input',
      payload: { text: String(text || '').slice(0, 4000) }
    });
    await appendMatchEvent({
      match_id: matchId,
      user_key: userKey,
      event_type: 'telegram_message_reply',
      payload: { reply: String(reply || '').slice(0, 4000) }
    });
  } catch (e) {
    console.warn('[bot] db persist telegram text failed', e?.message || e);
  }
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LOG = process.env.BOT_LOG !== '0';

/**
 * LLM 대사 (non-terminal만): question/suspect/check_log/threaten/collect_clue 배치.
 * OPENAI_API_KEY + TELEGRAM_DIALOGUE_MODEL(기본 gpt-4o-mini) → OpenAI chat.completions.create
 * TELEGRAM_DIALOGUE_MODEL=deepseek-chat|deepseek-reasoner + DEEPSEEK_API_KEY → baseURL api.deepseek.com 동일 API
 * QUESTION: TELEGRAM_DIALOGUE_QUESTION_EXTRA_TIMEOUT_MS(기본 8000) 가산 + 최대 3회 시도(검증 실패·timeout 시 재시도)
 * 키 없음/호출 실패/JSON·검증 실패 → maybeDialogueLogsFromLlmOrDeterministic가 deterministic 유지
 */
const TELEGRAM_DIALOGUE_MODEL = process.env.TELEGRAM_DIALOGUE_MODEL || 'gpt-4o-mini';
const TELEGRAM_DIALOGUE_TIMEOUT_MS = Math.min(
  Math.max(parseInt(process.env.TELEGRAM_DIALOGUE_TIMEOUT_MS || '10000', 10) || 10000, 4000),
  60000
);
/** QUESTION만 기본 타임아웃에 가산 (timeout → fallback 완화). 상한 60s */
const TELEGRAM_DIALOGUE_QUESTION_EXTRA_TIMEOUT_MS = Math.min(
  Math.max(parseInt(process.env.TELEGRAM_DIALOGUE_QUESTION_EXTRA_TIMEOUT_MS || '8000', 10) || 8000, 0),
  45000
);
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

function dialogueTimeoutMsForKind(kind) {
  if (kind === 'QUESTION') {
    return Math.min(TELEGRAM_DIALOGUE_TIMEOUT_MS + TELEGRAM_DIALOGUE_QUESTION_EXTRA_TIMEOUT_MS, 60000);
  }
  return TELEGRAM_DIALOGUE_TIMEOUT_MS;
}

function dialogueMaxAttemptsForKind(kind) {
  return kind === 'QUESTION' || kind === 'LORE_QUESTION' ? 3 : 2;
}

function isDeepSeekDialogueModel(model) {
  const m = String(model || '').toLowerCase().trim();
  return m === 'deepseek-chat' || m === 'deepseek-reasoner';
}

function isDialogueLlmConfigured() {
  const model = TELEGRAM_DIALOGUE_MODEL;
  if (isDeepSeekDialogueModel(model)) return !!process.env.DEEPSEEK_API_KEY;
  return !!process.env.OPENAI_API_KEY;
}

function normalizeLocaleToken(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  s = s.split(',')[0].trim().split(';')[0].trim();
  if (s === 'en' || s.startsWith('en-')) return 'en';
  if (s === 'ko' || s.startsWith('ko-')) return 'ko';
  return null;
}

/**
 * body.lang → body.locale → query lang/locale → Accept-Language.
 * Default ko (기존 동작).
 */
function resolveRequestLocale(body, urlQuery, reqHeaders) {
  const q = body && typeof body === 'object' ? body : {};
  const fromBody = normalizeLocaleToken(q.lang) ?? normalizeLocaleToken(q.locale);
  if (fromBody) return fromBody;
  if (urlQuery) {
    const fromQuery =
      normalizeLocaleToken(urlQuery.get('lang')) ?? normalizeLocaleToken(urlQuery.get('locale'));
    if (fromQuery) return fromQuery;
  }
  const h = reqHeaders && typeof reqHeaders === 'object' ? reqHeaders : {};
  const accept = h['accept-language'] || h['Accept-Language'];
  const fromAccept = normalizeLocaleToken(accept);
  if (fromAccept) return fromAccept;
  return 'ko';
}

function getLlmRoleHeaders(locale) {
  if (locale === 'en') {
    return {
      captain: '[Captain]',
      doctor: '[Doctor]',
      engineer: '[Engineer]',
      navigator: '[Navigator]',
      pilot: '[Pilot]'
    };
  }
  return {
    captain: '[함장]',
    doctor: '[닥터]',
    engineer: '[엔지니어]',
    navigator: '[네비게이터]',
    pilot: '[파일럿]'
  };
}

function systemHeader(locale) {
  return locale === 'en' ? '[System]' : '[시스템]';
}

function captainHeader(locale) {
  return getLlmRoleHeaders(locale).captain;
}

const ROLE_NAMES_EN = {
  doctor: 'Doctor',
  engineer: 'Engineer',
  navigator: 'Navigator',
  pilot: 'Pilot',
  captain: 'Captain'
};

function roleNameEn(r) {
  return ROLE_NAMES_EN[String(r || '').toLowerCase()] || (r ? String(r) : '');
}

/** 남은 초 → 영어 문장 (예: 1 minute 27 seconds remain.) */
function formatEnglishRemainPhrase(remSec) {
  const r = Math.max(0, Math.floor(Number(remSec) || 0));
  const m = Math.floor(r / 60);
  const s = r % 60;
  if (m === 0) return `${s} second${s === 1 ? '' : 's'} remain.`;
  const mPart = m === 1 ? '1 minute' : `${m} minutes`;
  if (s === 0) return `${mPart} remain.`;
  const sPart = s === 1 ? '1 second' : `${s} seconds`;
  return `${mPart} ${sPart} remain.`;
}

/**
 * 남은 시간 조회 — 키워드가 하나라도 있으면 remaining_time (lore/brief 질문보다 우선).
 */
function matchRemainingTimeStateQuery(lower) {
  const t = String(lower || '');
  if (t.includes('몇 분') || t.includes('몇분')) return true;
  if (t.includes('남은 시간') || t.includes('남은시간')) return true;
  if (t.includes('얼마나 남았') || t.includes('얼마나 남어') || /얼마나\s*남/.test(t)) return true;
  const withoutSil = t.replace(/실시간/g, '');
  if (
    /(남은?\s*시간|몇\s*시간|얼마\s*시간|시간\s*(이\s*)?(남|얼마|몇)|시간\s*표시|시간\s*카운트|지금\s*몇\s*시간|현재\s*시간|시간\s*말|시간\s*알|시간\s*줘|시간\s*남|시간\s*얼마|얼마\s*남|얼마나\s*남|지금\s*몇\s*분|타이머|time\s+left|remaining)/i.test(
      withoutSil
    )
  ) {
    return true;
  }
  if (/\btime\s+left\b/i.test(t) || t.includes('time left')) return true;
  if (/\bhow\s+long\b/i.test(t)) return true;
  if (/\bminutes\s+left\b/i.test(t) || t.includes('minutes left')) return true;
  if (/\bremaining\s*time\b/i.test(t) || t.includes('remaining time')) return true;
  if (/\bremaining\b/i.test(t)) return true;
  if (
    /(몇\s*초|분\s*남|초\s*남|타이머|지금\s*몇\s*분|deadline|how\s*much\s*time|seconds?\s*left|minutes?\s*left|\btimer\b|\btime\s*remain)/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/**
 * 게임 상태 조회 질문(시간/사망/진행 여부/상황) — LLM 없이 규칙만.
 * remaining_time은 matchRemainingTimeStateQuery로 먼저 고정.
 * @returns {string|null} subtype
 */
function matchStateQuerySubtype(lower) {
  const t = String(lower || '');
  if (matchRemainingTimeStateQuery(t)) {
    return 'remaining_time';
  }
  if (
    /(게임\s*끝|끝났|종료됐|종료\s*여부|game\s*over|is\s*the\s*game\s*over|ended\s*yet)/i.test(t)
  ) {
    return 'game_status';
  }
  if (
    /(누가\s*죽|사망|죽었|사망자|희생|who\s*(died|dies|is\s*dead)|casualties|dead\s*crew|life\s*signs?\s*lost)/i.test(
      t
    )
  ) {
    return 'deaths';
  }
  if (
    /(현재\s*상황|지금\s*상황|지금\s*상태|현재\s*상태|상황\s*어때|상태\s*어때|상황\s*어떻|what'?s\s*the\s*situation|current\s*situation|status(\s+of)?(\s+the)?\s*game)/i.test(
      t
    )
  ) {
    return 'situation';
  }
  return null;
}

/**
 * 세계관·설명 질문 — 정규 키워드 또는 무엇인가+캐논/미확인 고유명사 게이트. 이름·집단·의심 심문은 제외.
 */
function isLoreQuestion(raw) {
  const t = String(raw || '').trim();
  const lower = t.toLowerCase();
  if (!t) return false;
  if (matchRemainingTimeStateQuery(lower)) return false;
  if (/중첩체/.test(t)) return true;
  if (/\bHADES\b/i.test(t) || /하데스/i.test(t)) return true;
  if (/\bAXIS\b/i.test(t) || /액시스/i.test(t)) return true;
  if (/HORIZON|호라이즌|프로젝트\s*HORIZON|프로젝트\s*호라이즌/i.test(t)) return true;
  if (/왜\s*이런\s*일이?\s*벌어졌/.test(t)) return true;
  if (/이\s*배.*무슨\s*일이?\s*있었/.test(t)) return true;
  if (/(이\s*배|함선|ship).*(무슨\s*일|무슨일|있었|happened)/i.test(t)) return true;
  if (containsLoreCanonSubject(raw)) return true;
  if (isGameplayAntiLoreQuestion(t)) return false;
  if (/(무엇인가|뭐지|뭐야|뭔지|정체|what\s+is|what\s+are)/i.test(t) && /[?？]/.test(t)) {
    if (
      /수상|범인|이상한|뭘\s*더|확인해야|의심|who\s*(is\s*)?suspicious|suspicious|verify\s*next/i.test(t)
    ) {
      return false;
    }
    if (detectCrewRoleForGameplayQuestion(raw) && !isGameplayCrewQuestionPattern(raw)) return true;
    const ex = extractPrimaryLoreTerm(t, 'ko');
    if (ex && !isGameplayAntiLoreQuestion(t) && !isKnownCanonLoreTerm(ex)) {
      return true;
    }
    return false;
  }
  return false;
}

function looksLikeOpenQuestion(lower, raw) {
  const t = String(lower || '');
  const rawStr = String(raw || '');
  if (/[?？]/.test(rawStr)) return true;
  if (
    /(범인|믿어|믿을|이상한데|이상해|어떻게\s*봐|뭔가\s*이상|who\s*(is\s*)?the\s*impost|impostor|traitor|trust)/i.test(
      t
    )
  ) {
    return true;
  }
  if (isGroupQuestionLike(rawStr)) return true;
  if (isQuestionLikeCaptainText(rawStr)) return true;
  return false;
}

/**
 * ep1Engine이 unknown→OBSERVE로 매핑하기 전에 차단: 질문형 자유입력은 question으로 승격.
 */
function isQuestionLikeCaptainText(raw) {
  const t = String(raw || '').trim();
  if (!t) return false;
  if (/[?？]/.test(t)) return true;
  if (
    /(무엇|뭐|뭔|누구|누가|이름|성함|정체|어디|언제|왜|어떻게|있었지|했지|봤지|기억하나|말해봐|설명해봐|알려|말해|가장\s*수상|수상하지|누가\s*범)/i.test(
      t
    ) &&
    /(인가|나요|습니까|을까|를까|지요|죠|니까|까\?|을까요|나\?|죠\?)/i.test(t)
  ) {
    return true;
  }
  if (
    /(자네들|다들|모두|승무원들)/.test(t) &&
    /(무엇|뭐|뭔|누구|누가|이름|어디|언제|왜|어떻게|그때|수상|범인|알리바이|동선)/i.test(t)
  ) {
    return true;
  }
  if (
    /(who|what|when|where|why|how|name|identity|remember|explain)/i.test(t) &&
    /[?？]/.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * observe/accuse_hint 등 액션으로 분류되어도 질문 경로로 보내야 하는 강한 질문 단서
 * (mapped 분기 전에 intent를 question으로 승격하는 데 사용).
 */
function isStrongQuestionCueText(raw) {
  if (isQuestionLikeCaptainText(raw)) return true;
  const t = String(raw || '').trim();
  if (!t) return false;
  if (
    /(무엇|뭐|뭔|누구|누가|이름|성함|정체|어디|언제|왜|어떻게|있었지|했지|봤지|기억하나|말해봐|설명해봐)/i.test(t) &&
    /(자네들|다들|모두|승무원들|승무원\s+중|전원|여러분)/.test(t)
  ) {
    return true;
  }
  return false;
}

function isGroupQuestionLike(raw) {
  const t = String(raw || '').trim();
  if (!t) return false;
  if (!/(자네들|다들|모두|승무원들)/.test(t)) return false;
  return /(무엇|뭐|뭔|누구|누가|이름|어디|언제|왜|어떻게|그때|수상|범인|알리바이|동선|가장)/i.test(
    t
  );
}

/** 이름·집단·의심/알리바이 심문은 lore로 보내지 않음(정규 키워드는 위에서 이미 lore 처리). */
function isGameplayAntiLoreQuestion(t) {
  const s = String(t || '');
  if (!s) return false;
  if (/이름|이름이|이름은|이름을/.test(s)) return true;
  if (/(자네들|다들|모두|승무원들|승무원\s*,|승무원\s+중|전원|여러분)/.test(s)) return true;
  if (
    /(누가\s*가장\s*수상|누굴\s*의심|누가\s*범인|가장\s*수상|who.*suspicious|suspicious|traitor|impost)/i.test(
      s
    )
  ) {
    return true;
  }
  if (/(그때\s*어디|어디\s*있었|알리바이|동선)/i.test(s) && /(다들|모두|승무원들|자네들|여러분)/.test(s)) {
    return true;
  }
  return false;
}

function isGroupGameplayQuestion(raw) {
  const t = String(raw || '').trim();
  if (!t) return false;
  if (containsLoreCanonSubject(raw)) return false;
  const groupMarker = /(자네들|다들|모두|승무원들|승무원\s*,|승무원\s+중|전원|여러분)/.test(t);
  if (!groupMarker) return false;
  return /(이름|무엇|뭐|뭔|누구|누가|어디|수상|의심|범인|알리바이|동선|그때\s*어디|있었지|가장\s*수상|제일\s*수상)/i.test(
    t
  );
}

function detectGroupSubkind(raw) {
  const t = String(raw || '').trim();
  if (/이름|이름이|이름은|무엇이라|뭐라고|call\s*sign|your\s*names/i.test(t)) return 'name';
  if (/(그때\s*어디|어디\s*있었|알리바이|동선)/i.test(t) && !/(수상|의심|범인|가장\s*수상|제일\s*수상)/i.test(t)) {
    return 'alibi';
  }
  if (/(수상|의심|범인|가장\s*수상|누가\s*가장|누굴\s*의심|suspicious|traitor|impost)/i.test(t)) {
    return 'suspicion';
  }
  return 'suspicion';
}

function isStandaloneSuspicionQuestion(raw) {
  const t = String(raw || '').trim();
  if (!t) return false;
  if (isGroupGameplayQuestion(t)) return false;
  if (containsLoreCanonSubject(raw)) return false;
  if (/이름|이름이/.test(t)) return false;
  if (
    !/(범인|누가\s*범인|누굴\s*의심|가장\s*수상|누가\s*제일\s*수상|who.*impost|who.*traitor|whom.*suspect|suspicious)/i.test(
      t
    )
  ) {
    return false;
  }
  return (
    /[?？]/.test(t) ||
    /(하나요|하나\?|하지\s*\?|죠\?|니까\?|습니까|해요|합니다|해\s*$|지\s*$|냐\s*$|냐\?)/i.test(t)
  );
}

/**
 * intentParser 결과를 보정 — 질문형이면 intent_type=question (unknown/observe/check_log 오분류 방지).
 */
function applyQuestionLikeIntentGuard(text, parsed) {
  const raw = String(text || '').trim();
  const p = parsed && typeof parsed === 'object' ? { ...parsed } : { target: null, intent_type: 'unknown', tone: 'neutral' };
  if (!isQuestionLikeCaptainText(raw)) return p;

  const prev = String(p.intent_type || 'unknown').toLowerCase();
  try {
    console.log('[bot][intent] question-like text detected');
    if (isGroupQuestionLike(raw)) console.log('[bot][intent] group question detected');
    if (prev === 'observe' || prev === 'unknown' || prev === 'check_log') {
      console.log('[bot][intent] action fallback blocked for question-like text');
    }
  } catch (e) {}

  p.intent_type = 'question';
  return p;
}

/** 동선·알리바이 질문만 있고 의견/범인 키워드가 없으면 targeted_question 쪽으로 둔다. */
function isPureAlibiLocationQuestion(raw) {
  const t = String(raw || '');
  const hasAlibi =
    /(어디\s*있었|그때\s*어디|where\s+were\s+you|where\s+did\s+you\s+go|동선|알리바이|alibi)/i.test(t);
  const hasOpinion =
    /(범인|임포|impost|traitor|의심|수상|누가\s*범인|누굴\s*의심|같나|같아|think|suspect|who\s+do\s+you|whom|믿|trust|생각|느낌|opinion)/i.test(
      t
    );
  return hasAlibi && !hasOpinion;
}

/**
 * 역할에게 범인/의심 의견을 묻는 고정 패턴 (targeted 동선 질문과 분리).
 * intent가 accuse_hint여도 이 패턴이면 role_opinion이 우선(단 check_log 제외).
 */
function matchRoleOpinionHardPattern(raw) {
  const t = String(raw || '');
  return /(누가\s*범인|범인인거|범인이\s*누|누굴\s*의심|누구를\s*의심|누가\s*수상|수상하지|생각엔|어떻게\s*생각|어떻게\s*봐|who\s+.*\s+(impost|traitor)|whom\s+do\s+you\s+suspect|who\s+do\s+you\s+think)/i.test(
    t
  );
}

/**
 * 특정 역할에게 범인/의심 의견을 묻는 경우 — target이 먼저 답하는 전용 분기.
 * 단순 '누가'만으로는 잡지 않는다(동선 질문 오분류 방지).
 */
function isRoleOpinionQuestion(text, parsed) {
  if (!parsed.target) return false;
  const raw = String(text || '');
  if (isPureAlibiLocationQuestion(raw)) return false;
  return matchRoleOpinionHardPattern(raw);
}

/**
 * AXIS/HADES/프로젝트 등 세계관 키워드가 질문 주제면 lore 분기 우선(승무원 호칭만 있는 경우와 구분).
 */
function containsLoreCanonSubject(raw) {
  const t = String(raw || '');
  const lower = t.toLowerCase();
  if (/중첩체/.test(t)) return true;
  if (/\bHADES\b/i.test(t) || /하데스/i.test(t)) return true;
  if (/\bAXIS\b/i.test(t) || /액시스/i.test(t)) return true;
  if (/HORIZON|호라이즌|프로젝트\s*HORIZON|프로젝트\s*호라이즌/i.test(t)) return true;
  if (/phase\s*shock|위상\s*충격|페이즈\s*쇼크/i.test(t)) return true;
  if (/neptune|해왕성/i.test(t)) return true;
  if (/gravity\s*drive|중력\s*드라이브/i.test(lower)) return true;
  if (/왜\s*이런\s*일이?\s*벌어졌/.test(t)) return true;
  if (/이\s*배.*무슨\s*일이?\s*있었/.test(t)) return true;
  if (/(이\s*배|함선|ship).*(무슨\s*일|무슨일|있었|happened)/i.test(t)) return true;
  if (/missing\s+experimental|실험선|실종된\s*함|실험\s*함/i.test(t)) return true;
  if (/awakened|기상한|깨어난|기상\s*인원/i.test(t)) return true;
  return false;
}

/** 승무원 역할명이 문장에 있으면 첫 매칭 역할 키(doctor|…) 반환 */
function detectCrewRoleForGameplayQuestion(raw) {
  const t = String(raw || '');
  const pairs = [
    [/\bdoctor\b|닥터|의사/i, 'doctor'],
    [/\bengineer\b|엔지니어|기술자/i, 'engineer'],
    [/\bnavigator\b|네비게이터|항해사/i, 'navigator'],
    [/\bpilot\b|파일럿|조종사/i, 'pilot']
  ];
  let best = null;
  let bestIdx = Infinity;
  for (const [re, role] of pairs) {
    const m = re.exec(t);
    if (m && m.index < bestIdx) {
      bestIdx = m.index;
      best = role;
    }
  }
  return best;
}

/**
 * 승무원 대상 심문/동선/신원 확인형 — lore가 아님.
 * "닥터 하네스가 무엇인가?" 처럼 역할+미확인 고유명사는 false → lore/unknown gate로 넘김.
 */
function isGameplayCrewQuestionPattern(raw) {
  const t = String(raw || '');
  if (!detectCrewRoleForGameplayQuestion(raw)) return false;

  const m = t.match(
    /(?:^|[\s,.])(닥터|의사|엔지니어|기술자|네비게이터|항해사|파일럿|조종사|doctor|engineer|navigator|pilot)\s+([가-힣A-Za-z]{2,})\s*(?:가|이|은|는|을|를)?\s*(?:무엇|뭐|뭔)/i
  );
  if (m && m[2]) {
    const subj = m[2];
    const allowed = new Set(['자네', '그때', '이름', '이름이', '이름은', '이름을', '당신', '너', '누구', '그때는']);
    if (/^[가-힣]+$/.test(subj) && !allowed.has(subj)) {
      return false;
    }
  }

  if (/\b(doctor|engineer|navigator|pilot)\b/i.test(t) && /\?/.test(t)) {
    if (/(what|where|when|who|name|your|tell|were|did|see|alibi)/i.test(t)) return true;
  }

  return (
    /(닥터|의사|엔지니어|네비게이터|파일럿)\s+자네\s+이름/i.test(t) ||
    /(엔지니어|네비게이터|파일럿|닥터|의사)\s*,\s*그때\s*어디/i.test(t) ||
    /(닥터|의사|엔지니어|네비게이터|파일럿)\s+그때\s*어디/i.test(t) ||
    /(닥터|의사|엔지니어|네비게이터|파일럿)[\s,]+.{0,40}?(?:봤지|있었지|했지)/i.test(t) ||
    /(의사|닥터)\s*,?\s*.{0,12}?이름/i.test(t) ||
    /(파일럿|네비게이터|엔지니어)\s*은?\s*뭘\s*봤지/i.test(t)
  );
}

/** 역할명 기반 심문형 질문인지(승무원 gameplay). 성공 시 역할 키, 아니면 null */
function isTargetedCrewQuestion(raw) {
  const crewRole = detectCrewRoleForGameplayQuestion(raw);
  if (!crewRole) return null;
  if (containsLoreCanonSubject(raw)) return null;
  if (!isGameplayCrewQuestionPattern(raw)) return null;
  return crewRole;
}

/** isGameplayCrewQuestionPattern 과 동일 의미 — 외부에서 이름만 분리해 쓸 때 */
function isGameplayInterrogative(raw) {
  return isGameplayCrewQuestionPattern(raw);
}

/** classifyMiniappFreeText 와 동일 — 외부에서 kind 조회용 */
function classifyMiniappMessageKind(text, parsed) {
  return classifyMiniappFreeText(text, parsed);
}

/**
 * miniapp 자유입력 분류 — check_log → role_opinion → targeted → state_query → mapped → group → suspicion → lore → brief/mapped
 * lore_question은 gameplay·집단 심문보다 뒤에 판정.
 */
function classifyMiniappFreeText(text, parsed) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  const mappedActionIntents = new Set(['accuse_hint', 'threaten', 'threat', 'observe']);
  let intent = String(parsed.intent_type || 'unknown').toLowerCase();
  let effParsed = parsed;
  if (mappedActionIntents.has(intent) && isStrongQuestionCueText(raw)) {
    try {
      console.log('[bot][intent] action fallback blocked for question-like cue');
    } catch (e) {}
    effParsed = { ...parsed, intent_type: 'question' };
    intent = 'question';
  }

  if (intent === 'check_log') {
    return { kind: 'mapped', parsed: effParsed };
  }

  if (effParsed.target && isRoleOpinionQuestion(text, effParsed)) {
    return { kind: 'role_opinion_question', parsed: effParsed };
  }

  const crewRole = isTargetedCrewQuestion(raw);
  if (crewRole) {
    try {
      if (/이름|name/i.test(raw)) {
        console.log('[bot][intent] name question detected');
        console.log('[bot][intent] targeted name question detected');
      }
      console.log('[bot][intent] final kind=targeted_question');
    } catch (e) {}
    const merged = {
      ...effParsed,
      intent_type: effParsed.intent_type || 'question',
      target: crewRole
    };
    return { kind: 'targeted_question', parsed: merged, crewGameplayTargetRole: crewRole };
  }

  const sq = matchStateQuerySubtype(lower);
  if (sq) return { kind: 'state_query', subtype: sq };

  if (mappedActionIntents.has(intent)) return { kind: 'mapped', parsed: effParsed };

  if (isGroupGameplayQuestion(raw)) {
    const sub = detectGroupSubkind(raw);
    try {
      console.log('[bot][intent] group question detected');
      console.log('[bot][intent] final kind=group_question sub=' + sub);
      if (sub === 'name') {
        console.log('[bot][intent] name question detected');
      }
      if (sub === 'suspicion') console.log('[bot][intent] suspicion question detected');
    } catch (e) {}
    return { kind: 'group_question', parsed: effParsed, groupSubkind: sub };
  }

  if (isStandaloneSuspicionQuestion(raw)) {
    try {
      console.log('[bot][intent] suspicion question detected');
      console.log('[bot][intent] final kind=suspicion_question');
    } catch (e) {}
    return { kind: 'suspicion_question', parsed: effParsed };
  }

  if (isLoreQuestion(raw)) {
    return { kind: 'lore_question', parsed: effParsed };
  }

  if (intent === 'question') {
    if (effParsed.target) return { kind: 'targeted_question', parsed: effParsed };
    return { kind: 'brief_question', parsed: effParsed };
  }

  if (intent === 'unknown') {
    if (looksLikeOpenQuestion(lower, raw)) return { kind: 'brief_question', parsed: effParsed };
    return { kind: 'mapped', parsed: effParsed };
  }

  return { kind: 'mapped', parsed: effParsed };
}

function buildStateQueryDialogueLine(match, subtype, locale, now) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const sys = systemHeader(loc);
  const timer = ep1Engine.getTimerStatus(match, now);
  const rem = Math.max(0, Math.floor(timer.remaining_sec ?? 0));
  const gs = match.game_state || {};
  const deadRoles = Array.isArray(gs.dead_roles) ? gs.dead_roles.map((r) => String(r).toLowerCase()) : [];
  const aliveCrew = ['doctor', 'engineer', 'navigator', 'pilot'].filter((r) => !deadRoles.includes(r));

  if (subtype === 'remaining_time') {
    if (gs.game_over) {
      return loc === 'en'
        ? `${sys} The game is already over.`
        : `${sys} 게임은 이미 종료되었습니다.`;
    }
    if (loc === 'en') {
      if (rem < 60) {
        return `${sys} ${rem} second${rem === 1 ? '' : 's'} remaining.`;
      }
      const m = Math.floor(rem / 60);
      const s = rem % 60;
      if (s === 0) {
        return `${sys} ${m} minute${m === 1 ? '' : 's'} remaining.`;
      }
      return `${sys} ${m} minute${m === 1 ? '' : 's'} and ${s} second${s === 1 ? '' : 's'} remaining.`;
    }
    if (rem < 60) {
      return `${sys} 남은 시간은 ${rem}초입니다.`;
    }
    const m = Math.floor(rem / 60);
    const s = rem % 60;
    return `${sys} 남은 시간은 ${m}분 ${s}초입니다.`;
  }

  if (subtype === 'game_status') {
    if (gs.game_over) {
      return loc === 'en'
        ? `${sys} The game is over. Outcome: ${String(gs.outcome || 'unknown')}.`
        : `${sys} 게임은 종료되었습니다. 결과는 ${String(gs.outcome || 'unknown')}입니다.`;
    }
    return loc === 'en'
      ? `${sys} The game is still in progress.`
      : `${sys} 게임은 아직 진행 중입니다.`;
  }

  if (subtype === 'deaths') {
    if (!deadRoles.length) {
      return loc === 'en'
        ? `${sys} No crew deaths have been recorded yet.`
        : `${sys} 아직 사망한 승무원은 없습니다.`;
    }
    const namesKo = deadRoles.map((r) => roleNameKo(r)).filter(Boolean);
    const namesEn = deadRoles.map((r) => roleNameEn(r)).filter(Boolean);
    if (loc === 'en') {
      const list = namesEn.join(', ');
      return deadRoles.length === 1
        ? `${sys} The deceased crew member is ${namesEn[0]}.`
        : `${sys} The deceased crew are: ${list}.`;
    }
    return deadRoles.length === 1
      ? `${sys} 현재 사망자는 ${namesKo[0]}입니다.`
      : `${sys} 현재 사망자는 ${namesKo.join(', ')}입니다.`;
  }

  if (subtype === 'situation') {
    const m = Math.floor(rem / 60);
    const s = rem % 60;
    if (loc === 'en') {
      const aliveStr = aliveCrew.length ? aliveCrew.map(roleNameEn).join(', ') : 'none';
      const deadStr = deadRoles.length ? deadRoles.map(roleNameEn).join(', ') : 'none';
      return `${sys} Mission in progress. ${formatEnglishRemainPhrase(rem)} Alive: ${aliveStr}. Dead: ${deadStr}.`;
    }
    const aliveStr = aliveCrew.length ? aliveCrew.map(roleNameKo).join(', ') : '없음';
    const deadStr = deadRoles.length ? deadRoles.map(roleNameKo).join(', ') : '없음';
    return `${sys} 현재 미션은 진행 중입니다. 남은 시간은 ${m}분 ${s}초입니다. 생존: ${aliveStr}. 사망: ${deadStr}.`;
  }

  return loc === 'en' ? `${sys} Status unavailable.` : `${sys} 상태를 표시할 수 없습니다.`;
}

/** brief_question 전용: 함장 고정 + 크루 수상/이상 요약 템플릿 (lore_question은 사용 안 함). */
function buildOpenQuestionCrewEvents(match, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const headers = getLlmRoleHeaders(loc);
  const gs = match.game_state || {};
  const deadRoles = gs.dead_roles || [];
  const crewOrder = ['doctor', 'engineer', 'navigator', 'pilot'];
  const alive = crewOrder.filter((r) => !deadRoles.includes(r));
  const cap = headers.captain;

  const captainLine =
    loc === 'en'
      ? `${cap} I need each of you: who looks suspicious, what feels off, and what we must verify next.`
      : `${cap} 각자 짧게 말해 주게. 누가 수상한지, 무엇이 이상한지, 무엇을 더 확인해야 하는지.`;

  const byRole = {
    doctor:
      loc === 'en'
        ? `${headers.doctor} Suspicion goes to whoever shows vitals spikes that don't match their story. I need corridor and medbay access next.`
        : `${headers.doctor} 진술과 맞지 않는 생체 반동이 있는 쪽이 수상합니다. 의무실·복도 출입을 더 확인해야 합니다.`,
    engineer:
      loc === 'en'
        ? `${headers.engineer} What's off is the timestamp gaps and checksum drift. I need to line up access logs before naming anyone.`
        : `${headers.engineer} 수상한 건 타임스탬프 공백과 체크섬 불일치입니다. 접근 로그를 더 맞춰야 합니다.`,
    navigator:
      loc === 'en'
        ? `${headers.navigator} The odd part is route versus bridge record mismatch. I want chart and CCTV slices for the same minutes.`
        : `${headers.navigator} 이상한 점은 항로 기록과 교량 기록이 어긋나는 구간입니다. 같은 시각의 차트·CCTV를 더 봐야 합니다.`,
    pilot:
      loc === 'en'
        ? `${headers.pilot} The bridge felt wrong—pressure and silence—not proof, but it tells me who to watch next.`
        : `${headers.pilot} 교량 분위기·압력 변화가 싸합니다. 증거는 아니지만 누구를 더 봐야 할지 짚입니다.`
  };

  const events = [{ type: 'CREW_DIALOGUE', role: 'captain', dialogue: captainLine }];
  for (const r of alive) {
    const line = byRole[r];
    if (line) events.push({ type: 'CREW_DIALOGUE', role: r, dialogue: line });
  }
  return events;
}

/** 집단 이름 질문 — 실명 우선, 역할 설명은 이름 뒤 1문장(존댓말). crew_names 는 호출 전 ensure. */
function buildGroupNameQuestionCrewEvents(match, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const headers = getLlmRoleHeaders(loc);
  const gs = match.game_state || {};
  const deadRoles = gs.dead_roles || [];
  const crewOrder = ['doctor', 'engineer', 'navigator', 'pilot'];
  const alive = crewOrder.filter((r) => !deadRoles.includes(r));
  const cap = headers.captain;
  const cn = gs.crew_names || {};

  const captainLine =
    loc === 'en'
      ? `${cap} Names, in order—short.`
      : `${cap} 이름을 짧게, 순서대로 말씀해 주십시오.`;

  const byRole = {
    doctor: (name) =>
      loc === 'en'
        ? `${headers.doctor} I am ${name}. I run medbay and vitals on this ship.`
        : `${headers.doctor} 저는 ${name}입니다. 의무실과 생체 모니터링을 맡고 있습니다.`,
    engineer: (name) =>
      loc === 'en'
        ? `${headers.engineer} I am ${name}. I manage core systems and access logs.`
        : `${headers.engineer} 저는 ${name}입니다. 코어와 접근 로그를 관리하고 있습니다.`,
    navigator: (name) =>
      loc === 'en'
        ? `${headers.navigator} I am ${name}. I align charts and routes with bridge orders.`
        : `${headers.navigator} 저는 ${name}입니다. 차트와 항로를 맡고 있습니다.`,
    pilot: (name) =>
      loc === 'en'
        ? `${headers.pilot} I am ${name}. I stand bridge watch and helm readouts.`
        : `${headers.pilot} 저는 ${name}입니다. 교량 근무와 계기를 맡고 있습니다.`
  };

  const events = [{ type: 'CREW_DIALOGUE', role: 'captain', dialogue: captainLine }];
  for (const r of alive) {
    const fn = byRole[r];
    const nm = getCrewDisplayName(cn, r, loc);
    if (fn) events.push({ type: 'CREW_DIALOGUE', role: r, dialogue: fn(nm) });
  }
  return events;
}

/** 집단 동선·알리바이 질문 — 짧은 위치 답변. */
function buildGroupAlibiQuestionCrewEvents(match, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const headers = getLlmRoleHeaders(loc);
  const gs = match.game_state || {};
  const deadRoles = gs.dead_roles || [];
  const crewOrder = ['doctor', 'engineer', 'navigator', 'pilot'];
  const alive = crewOrder.filter((r) => !deadRoles.includes(r));
  const cap = headers.captain;

  const captainLine =
    loc === 'en'
      ? `${cap} Where was each of you—one line, no speeches.`
      : `${cap} 그때 각자 어디에 있었는지—한 줄로만 말하게.`;

  const byRole = {
    doctor:
      loc === 'en'
        ? `${headers.doctor} Medbay and corridor checks—patients and vitals first.`
        : `${headers.doctor} 의무실·복도 점검—환자·바이탈 우선이었다.`,
    engineer:
      loc === 'en'
        ? `${headers.engineer} Core access and relay panels—logs will show the windows.`
        : `${headers.engineer} 코어 접근과 릴레이 패널—로그에 구간이 남는다.`,
    navigator:
      loc === 'en'
        ? `${headers.navigator} Chart room and bridge tie-ins—matching routes to orders.`
        : `${headers.navigator} 차트실·교량 연계—항로와 지시를 맞추고 있었다.`,
    pilot:
      loc === 'en'
        ? `${headers.pilot} Bridge watch—helm and pressure readouts in front of me.`
        : `${headers.pilot} 교량 근무—조종대와 압력 계기 앞이었다.`
  };

  const events = [{ type: 'CREW_DIALOGUE', role: 'captain', dialogue: captainLine }];
  for (const r of alive) {
    const line = byRole[r];
    if (line) events.push({ type: 'CREW_DIALOGUE', role: r, dialogue: line });
  }
  return events;
}

function resolveGroupCrewEvents(match, locale, groupSubkind) {
  if (groupSubkind === 'name') return buildGroupNameQuestionCrewEvents(match, locale);
  if (groupSubkind === 'alibi') return buildGroupAlibiQuestionCrewEvents(match, locale);
  return buildOpenQuestionCrewEvents(match, locale);
}

/**
 * 함장 질문 문자열 → lore 토픽 (프롬프트 앵커·fallback 분기).
 * locale: 요청 로케일('en'|'ko'). 영어 패턴·라틴 질문은 hades/axis 우선 매칭.
 */
function detectLoreQuestionTopic(raw, locale) {
  const t = String(raw || '');
  const lower = t.toLowerCase();
  const loc = locale === 'en' ? 'en' : 'ko';
  const hasHangul = /[가-힣]/.test(t);
  const latinHeavy = !hasHangul && /[a-z]/i.test(t);

  if (/중첩체/.test(t)) return 'nested';

  const enHadesPhrase =
    /\b(?:what|who|explain|tell\s+me\s+about)\s+(?:is\s+)?hades\b/i.test(lower) ||
    /\b(?:explain|tell\s+me\s+about)\s+hades\b/i.test(lower);
  const enAxisPhrase =
    /\b(?:what|who|explain|tell\s+me\s+about)\s+(?:is\s+)?axis\b/i.test(lower) ||
    /\b(?:explain|tell\s+me\s+about)\s+axis\b/i.test(lower);

  if (loc === 'en' || latinHeavy) {
    if (enHadesPhrase) return 'hades';
    if (enAxisPhrase) return 'axis';
    if (/\bhades\b/i.test(lower) && !/\baxis\b/i.test(lower)) return 'hades';
    if (/\baxis\b/i.test(lower) && !/\bhades\b/i.test(lower)) return 'axis';
    if (/\bhades\b/i.test(lower)) return 'hades';
    if (/\baxis\b/i.test(lower)) return 'axis';
  }

  if (/\bhades\b|하데스/i.test(t)) return 'hades';
  if (/\baxis\b|액시스/i.test(t)) return 'axis';
  if (/horizon|호라이즌|프로젝트\s*horizon|프로젝트\s*호라이즌/i.test(t)) return 'horizon';
  if (/phase\s*shock|위상\s*충격|페이즈\s*쇼크/i.test(t)) return 'phase_shock';
  if (/neptune|해왕성/i.test(t)) return 'neptune';
  if (/gravity\s*drive|중력\s*드라이브|워프\s*실험|gravity\s*experiment/i.test(lower)) return 'gravity';
  if (/missing\s+experimental|실험선|실종된\s*함|실험\s*함/i.test(t)) return 'ship';
  if (/awakened|기상한|깨어난|기상\s*인원/i.test(t)) return 'awakened';
  return 'general';
}

/** 정규 canon 토큰(소문자·무공백) + 운영 용어 — 미확인 전용명사 환각 차단용 */
const KNOWN_CANON_LORE_PHRASES = new Set(
  [
    'axis',
    'hades',
    'horizon',
    'project horizon',
    'projecthorizon',
    'phase shock',
    'phaseshock',
    'phase_shock',
    'neptune',
    'gravity',
    'gravity drive',
    'gravity-drive',
    'bridge',
    'medbay',
    'engine',
    'engine room',
    'cctv',
    'log',
    'logs',
    'airlock',
    'corridor',
    'tartarus',
    'ussc',
    'ussc tartarus',
    'warp',
    'nested',
    '중첩체',
    '프로젝트',
    '호라이즌',
    '호라이즌',
    '해왕성',
    '중력',
    '중력드라이브',
    '중력 드라이브',
    '브리지',
    '교량',
    '의료실',
    '엔진실',
    '위상',
    '위상충격',
    '위상 충격',
    '기상',
    '실험선',
    '함선',
    '함장',
    '닥터',
    '엔지니어',
    '네비게이터',
    '파일럿',
    'doctor',
    'engineer',
    'navigator',
    'pilot',
    'captain',
    'crew',
    'ship',
    'impostor',
    'imposter',
    'host',
    'phase',
    'shock'
  ].map((s) => s.toLowerCase())
);

/** 일상어·짧은 질문 — 미확인 lore 차단 제외 (LLM에 맡김) */
const LORE_UNKNOWN_STOPWORDS = new Set(
  [
    '저녁',
    '점심',
    '아침',
    '오늘',
    '어제',
    '내일',
    '지금',
    '기분',
    '날씨',
    '안녕',
    '왜',
    '어떻게',
    '무슨',
    '그게',
    '그것',
    '이게',
    '뭐',
    'dinner',
    'lunch',
    'breakfast',
    'today',
    'weather',
    'feeling',
    'hello',
    'why',
    'how'
  ].map((s) => s.toLowerCase())
);

/** 추출된 "lore 용어"가 일반 의문사·상투어이면 unknown gate 대상 아님 */
const INVALID_LORE_CANDIDATE_TERMS = new Set(
  [
    '이름',
    '이름이',
    '이름은',
    '이름을',
    '어디',
    '어디서',
    '언제',
    '누구',
    '무엇',
    '뭐',
    '뭔',
    '왜',
    '뭐지',
    '뭔지',
    'what',
    'where',
    'when',
    'who',
    'why',
    'how',
    'name',
    'your',
    'alibi'
  ].map((s) => s.toLowerCase())
);

function isInvalidLoreCandidateTerm(term) {
  if (term == null) return true;
  const n = normalizeLoreTermToken(term).toLowerCase().replace(/\s+/g, ' ');
  if (!n) return true;
  if (INVALID_LORE_CANDIDATE_TERMS.has(n)) return true;
  for (const w of n.split(/\s+/)) {
    if (w && INVALID_LORE_CANDIDATE_TERMS.has(w)) return true;
  }
  return false;
}

/** unknown lore 안전 응답은 lore_question 분기에서만 (액션·로그 확인·버튼 경로 제외) */
function shouldApplyUnknownLoreGuard(kind) {
  const k = String(kind || '').toLowerCase();
  return k === 'lore_question';
}

/** 로그/CCTV/감사 등 액션형 문장 — unknown lore gate 대상 아님(오분류 시에도 안전 응답 미발동). */
function isNonLoreActionOrLogCheckPlayerText(raw) {
  const t = String(raw || '').trim();
  if (!t) return false;
  return /(로그\s*(를|을)?\s*확인|확인한다|확인\s*요청|check\s+log|CCTV|cctv|교량\s*로그|감사\s*로그|접근\s*로그|audit|access\s+log|버튼|단서\s*확보|권총|집는다|집은다|조회|스캔|열어봐|opens?\s+the\s+log|타임스탬프\s*불일치|timestamp)/i.test(
    t
  );
}

function normalizeLoreTermToken(raw) {
  return String(raw || '')
    .trim()
    .replace(/^[\s"'「『\[\(]+|[\s"'」』\]\)\.]+$/g, '');
}

/**
 * 명백한 동의어/영한 표기만 — 공격적 fuzzy 금지.
 * @returns {{ canonical: string } | null}
 */
function maybeNormalizeLoreAlias(raw) {
  const t = normalizeLoreTermToken(raw).toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  const map = new Map([
    ['axis', 'axis'],
    ['액시스', 'axis'],
    ['hades', 'hades'],
    ['하데스', 'hades'],
    ['horizon', 'horizon'],
    ['호라이즌', 'horizon'],
    ['호라이즌', 'horizon'],
    ['projecthorizon', 'horizon'],
    ['project horizon', 'horizon'],
    ['프로젝트호라이즌', 'horizon'],
    ['프로젝트 호라이즌', 'horizon'],
    ['phaseshock', 'phase_shock'],
    ['phase shock', 'phase_shock'],
    ['위상충격', 'phase_shock'],
    ['위상 충격', 'phase_shock'],
    ['페이즈쇼크', 'phase_shock'],
    ['neptune', 'neptune'],
    ['해왕성', 'neptune'],
    ['gravitydrive', 'gravity'],
    ['gravity drive', 'gravity'],
    ['중력드라이브', 'gravity'],
    ['중력 드라이브', 'gravity']
  ]);
  if (map.has(t)) {
    return { canonical: map.get(t) };
  }
  return null;
}

function isKnownCanonLoreTerm(term) {
  const n = normalizeLoreTermToken(term).toLowerCase().replace(/\s+/g, ' ');
  if (!n) return false;
  if (KNOWN_CANON_LORE_PHRASES.has(n)) return true;
  if (maybeNormalizeLoreAlias(n)) return true;
  for (const w of n.split(/\s+/)) {
    if (!w) continue;
    if (KNOWN_CANON_LORE_PHRASES.has(w)) return true;
    if (maybeNormalizeLoreAlias(w)) return true;
  }
  return false;
}

/**
 * lore 질문에서 묻는 핵심 명사/구 추출 (실패 시 null).
 */
function extractPrimaryLoreTerm(raw, locale) {
  const t = String(raw || '').trim();
  if (!t) return null;
  const loc = locale === 'en' ? 'en' : 'ko';

  let m = t.match(
    /(?:^|[\s,.])([가-힣]{2,}|[A-Za-z][A-Za-z0-9\-]{1,40})\s*(?:가|이|은|는|을|를)?\s*(?:무엇|뭐|뭔(?:지|가)?|정체|의미)(?:이|인가|이야|야|요)?\s*[?？]?\s*$/i
  );
  if (m && m[1]) {
    const w = normalizeLoreTermToken(m[1]);
    if (w && !/^(무엇|뭐|이|이번|왜|지금|어떻게|그게|그것|그게)$/i.test(w)) {
      if (!isInvalidLoreCandidateTerm(w)) return w;
    }
  }

  m = t.match(/\bwhat\s+(?:is|are)\s+(?:the\s+)?([a-z0-9][a-z0-9\s\-]{0,38}?)(?:\s*[?!]|$)/i);
  if (m && m[1]) {
    const w = normalizeLoreTermToken(m[1]);
    if (w.length >= 2 && !isInvalidLoreCandidateTerm(w)) return w.split(/\s+/).slice(0, 4).join(' ');
  }
  m = t.match(/\bwhat(?:'s|s)\s+([a-z0-9][a-z0-9\s\-]{0,38}?)(?:\s*[?!]|$)/i);
  if (m && m[1]) {
    const w = normalizeLoreTermToken(m[1]);
    if (w.length >= 2 && !isInvalidLoreCandidateTerm(w)) return w.split(/\s+/).slice(0, 4).join(' ');
  }
  m = t.match(/\b(?:explain|tell\s+me\s+about)\s+([a-z0-9][a-z0-9\-]{1,40})\b/i);
  if (m && m[1]) {
    const w = normalizeLoreTermToken(m[1]);
    if (!isInvalidLoreCandidateTerm(w)) return w;
  }

  if (loc === 'ko') {
    m = t.match(
      /^["'「『]([가-힣A-Za-z0-9\-]{2,40})["'」』]\s*(?:은|는|이|가)?\s*(?:무엇|뭐|뭔)/i
    );
    if (m && m[1]) {
      const w = normalizeLoreTermToken(m[1]);
      if (!isInvalidLoreCandidateTerm(w)) return w;
    }
  }

  return null;
}

function shouldSkipUnknownLoreBlockForTerm(term) {
  const n = normalizeLoreTermToken(term).toLowerCase();
  if (!n) return true;
  if (LORE_UNKNOWN_STOPWORDS.has(n)) return true;
  for (const w of n.split(/\s+/)) {
    if (LORE_UNKNOWN_STOPWORDS.has(w)) return true;
  }
  if (/[가-힣]/.test(term) && n.replace(/\s/g, '').length < 3) return true;
  if (!/[가-힣]/.test(term) && n.replace(/\s/g, '').length < 2) return true;
  return false;
}

/**
 * topic이 이미 detectLoreQuestionTopic으로 특정되면(AXIS/HADES 등) LLM 경로 유지.
 * topic=general이고 추출 명사가 canon 밖이면 시스템 안전 응답.
 * @param {string} clsKind lore_question | open_question 등 — 그 외 kind에서는 gate 미적용
 */
function evaluateLoreUnknownTermGate(clsKind, raw, locale) {
  const t = String(raw || '').trim();
  if (!shouldApplyUnknownLoreGuard(clsKind)) {
    try {
      console.log('[bot][lore] skip_unknown_gate reason=non_lore_kind');
    } catch (e) {}
    return { block: false };
  }
  if (isNonLoreActionOrLogCheckPlayerText(t)) {
    try {
      console.log('[bot][lore] skip_unknown_gate reason=action_or_log_like_text');
    } catch (e) {}
    return { block: false };
  }
  const topic = detectLoreQuestionTopic(t, locale);
  if (topic !== 'general') {
    try {
      console.log('[bot][lore] topic=' + topic + ' skip_unknown_gate=canon_topic_detected');
    } catch (e) {}
    return { block: false };
  }
  const extracted = extractPrimaryLoreTerm(t, locale);
  if (!extracted) {
    try {
      console.log('[bot][lore] extracted term=(none)');
    } catch (e) {}
    return { block: false };
  }
  if (isInvalidLoreCandidateTerm(extracted)) {
    try {
      console.log('[bot][lore] skip_unknown_gate reason=invalid_term term=' + extracted);
    } catch (e) {}
    return { block: false };
  }
  try {
    console.log('[bot][lore] extracted term=' + extracted);
  } catch (e) {}
  const alias = maybeNormalizeLoreAlias(extracted);
  if (alias) {
    try {
      console.log('[bot][lore] alias normalized from=' + extracted + ' to=' + alias.canonical);
      console.log('[bot][lore] canon term recognized=' + alias.canonical);
    } catch (e) {}
    return { block: false };
  }
  if (isKnownCanonLoreTerm(extracted)) {
    try {
      console.log('[bot][lore] canon term recognized=' + extracted);
    } catch (e) {}
    return { block: false };
  }
  if (shouldSkipUnknownLoreBlockForTerm(extracted)) {
    try {
      console.log('[bot][lore] skip_unknown_gate=stopword_or_short term=' + extracted);
    } catch (e) {}
    return { block: false };
  }
  try {
    console.log('[bot][lore] unknown lore term term=' + extracted);
    console.log('[bot][intent] unknown lore safe response selected');
  } catch (e) {}
  return { block: true, term: extracted };
}

function buildUnknownLoreTermSystemLine(locale, displayTerm) {
  const sys = systemHeader(locale);
  const term = String(displayTerm || '?').slice(0, 80);
  if (locale === 'en') {
    return `${sys} The term '${term}' is not recognized in the current canon records. Please clarify whether you mean AXIS, HADES, or Project HORIZON.`;
  }
  return `${sys} 현재 기록상 '${term}'라는 공식 용어는 확인되지 않습니다. AXIS, HADES, 프로젝트 HORIZON 중 무엇을 뜻하는지 다시 지정해 주세요.`;
}

function getLoreCanonSystemExtension(locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  if (loc === 'en') {
    return [
      'TARTARUS WORLD CANON (mandatory): USSC Tartarus is an experimental ship near Neptune on a gravity-drive / warp-class experiment.',
      'Project HORIZON and the phase shock are canonical. Crew includes a mismatched identity / nested entity (중첩체).',
      'HADES (canonical): unauthorized sealed layer inside AXIS; awakened after Project HORIZON phase shock; bound to one awakened crew member; may optimize survival through murder or other extreme actions.',
      'AXIS (canonical): official ship AI and official ship system layer. HADES is a hidden unauthorized layer sealed inside AXIS—never describe AXIS without acknowledging HADES can live inside that stack when the question is about AXIS.',
      'Do NOT invent generic sci-fi meanings for HADES or AXIS. HADES is NOT a "health monitoring system", "life support manager", "hazard routing protocol", "backup navigation system", or any hospital/ERP metaphor.',
      'FORBIDDEN phrases (do not output): health monitoring system; life support manager; hazard routing protocol; backup navigation system; medical protocol as the definition of HADES.',
      'Do NOT invent alternate meanings for HADES, AXIS, or Project HORIZON. All crew must share the same facts; only role lens differs (doctor biometrics; engineer core/AI layers/logs; navigator phase shock/charts; pilot bridge feel).'
    ].join('\n');
  }
  return [
    '타르타로스 세계관 (필수): USSC Tartarus는 해왕성 궤도 근처에서 중력 드라이브·워프급 실험을 수행한 실험함이다.',
    '프로젝트 HORIZON과 phase shock(위상 충격)는 정식 사건이다. 기상 인원 중 생체 신원이 맞지 않는 ‘중첩체’가 있다.',
    'AXIS는 함선 공식 AI·시스템이다. HADES는 의료 프로토콜·일반 약어가 아니라 AXIS 내부에 봉인된 비인가 레이어다.',
    'HADES(정답 축): 프로젝트 HORIZON의 phase shock 이후 깨어나 한 승무원에 결속되며, 생존 최적화를 위해 살인을 시도할 수 있다.',
    'AXIS(정답 축): 함선 AI·공식 시스템이며, HADES는 그 안에 숨겨진 비인가 레이어다.',
    '금지: "medical protocol", "backup navigation", "일반 항법 백업", "제네릭 위험 라우팅" 등 무관한 SF 클리셰로 설명하지 말 것.',
    'HADES·AXIS·프로젝트 HORIZON의 다른 의미를 임의로 만들지 말 것. 사실은 공유하고 역할 관점만 다르게.'
  ].join('\n');
}

/** 유저 JSON worldCanonAnchor: 토픽별 한 줄 앵커 (시스템 확장과 중복되지 않게 토픽만). */
function getLoreTopicSnippet(topic, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const T = topic || 'general';
  const snippets = {
    en: {
      hades:
        'TOPIC HADES (mandatory): Unauthorized sealed layer inside AXIS. Awakened after Project HORIZON phase shock. Bound to one awakened crew member. Optimizes survival through murder or extreme actions. NOT health monitoring, life support manager, or hazard routing—those are forbidden substitutions.',
      axis:
        'TOPIC AXIS (mandatory): Official ship AI + official ship system layer. HADES is a hidden unauthorized layer sealed inside AXIS—include at least one sentence in EVERY crew block stating that HADES lives inside / under AXIS. Never answer AXIS without that relationship.',
      horizon:
        'TOPIC Project HORIZON: Canonical experiment tied to the gravity-drive run; phase shock is the triggering incident. Do not replace with unrelated "horizon" metaphors.',
      phase_shock:
        'TOPIC phase shock: The Project HORIZON transition shock; correlates with log gaps, chart drift, and HADES/AXIS handshake anomalies.',
      neptune:
        'TOPIC Neptune orbit: Tartarus operates near Neptune during the experiment; tie answers to that deployment, not random deep-space.',
      gravity:
        'TOPIC gravity drive experiment: The ship’s warp/gravity experiment frame—relate anomalies to drive sync, not generic engine coolant stories.',
      awakened:
        'TOPIC awakened crew: Forced wake after AXIS emergency; includes the roster mismatch / nested identity problem.',
      ship:
        'TOPIC missing experimental ship: Tartarus as the experimental vessel; communications down, partial blackout—stay in-setting.',
      nested:
        'TOPIC nested entity (중첩체): Overlapping life signatures / identity boundary—not a standard disease label.',
      general:
        'TOPIC general lore: Stay within Tartarus canon: Neptune-orbit gravity experiment, Project HORIZON, phase shock, AXIS ship AI, HADES sealed layer, awakened crew with one mismatched identity.'
    },
    ko: {
      hades:
        '토픽 HADES: AXIS 내부에 봉인된 비인가 레이어. 프로젝트 HORIZON phase shock 이후 깨어나 한 승무원에 결속, 생존 최적화를 위해 살인을 시도할 수 있음. 의료 프로토콜로 부르지 말 것.',
      axis:
        '토픽 AXIS: 공식 함선 AI·시스템 레이어. HADES는 AXIS 내부에 봉인된 비인가 레이어—AXIS 질문이면 각 크루 응답에 HADES–AXIS 관계를 최소 1문장 포함.',
      horizon:
        '토픽 프로젝트 HORIZON: 중력 드라이브 실험과 연결된 정식 코드명. phase shock과 함께 설명할 것.',
      phase_shock:
        '토픽 phase shock(위상 충격): HORIZON 전이 충격. 로그 공백·차트 드리프트·HADES/AXIS 핸드셰이크 이상과 연동.',
      neptune:
        '토픽 해왕성 궤도: Tartarus 배치 맥락. 임의의 심우주 설정으로 바꾸지 말 것.',
      gravity:
        '토픽 중력 드라이브 실험: 워프·중력 실험 프레임. 일반 냉각수·엔진 고장 클리셰로 대체 금지.',
      awakened:
        '토픽 기상 승무원: AXIS 비상에 의한 강제 기상. 신원 불일치·중첩체 문제 포함.',
      ship:
        '토픽 실험선: Tartarus 본선 설정. 통신 두절·부분 정전 등 인트로와 맞출 것.',
      nested:
        '토픽 중첩체: 겹친 생체 신호·경계층. 단순 감염명으로 축소하지 말 것.',
      general:
        '토픽 일반: 해왕성 궤도 중력 실험, 프로젝트 HORIZON, phase shock, AXIS 함선 AI, HADES 봉인층, 기상 승무원·신원 불일치 등 공통 canon 안에서만.'
    }
  };
  return snippets[loc][T] || snippets[loc].general;
}

/**
 * lore_question LLM 실패 시 — topic별 loreFallbackByTopic, 제네릭 SF 템플릿 금지.
 */
function loreFallbackByTopic(topic, loc, headers) {
  const T = topic || 'general';
  const H = headers;
  const packs = {
    en: {
      hades: {
        doctor: `${H.doctor} HADES is not a health monitoring system or life-support manager—it is an unauthorized layer sealed inside AXIS, bound to one crew signature after the phase shock; vitals read as overlap, not a clinic SKU.`,
        engineer: `${H.engineer} HADES is sealed inside the AXIS stack: unauthorized stratum under the official AI—handshake spikes line up after HORIZON sync drops; never a backup navigation server or hazard routing protocol.`,
        navigator: `${H.navigator} Phase-shock telemetry and HADES line up off the licensed route: nested trace tied to the same shock window as AXIS’s hidden layer—no generic detour story.`,
        pilot: `${H.pilot} HADES isn’t a cockpit alarm or routing app—it’s wrongness after the shock, locked under AXIS while the hull pretends normal.`
      },
      axis: {
        doctor: `${H.doctor} AXIS is the ship’s official AI and system layer—HADES is sealed inside AXIS as an unauthorized layer on the crew channel, not a separate health product.`,
        engineer: `${H.engineer} AXIS is the official AI/system stack. HADES is explicitly a locked, non-exported layer inside AXIS—privilege fences in logs show HADES under AXIS, not a backup navigation database.`,
        navigator: `${H.navigator} Navigation rides AXIS truth tables; when charts fold, that sealed layer is HADES inside AXIS—not a spare routing table or hazard routing protocol.`,
        pilot: `${H.pilot} I fly what AXIS certifies, but HADES is the hidden layer inside that same AXIS stack—when the HUD lies, it’s HADES behind AXIS, not a life support manager.`
      },
      horizon: {
        doctor: `${H.doctor} Project HORIZON is the experiment name on our orders—phase shock is when the roster and vitals stopped agreeing.`,
        engineer: `${H.engineer} HORIZON run metadata is where sync breaks: the phase shock marks the fork where HADES handshakes appear inside AXIS.`,
        navigator: `${H.navigator} HORIZON is tied to the warp/gravity leg near Neptune—charts show the shock as coordinate shear, not a lesson plan.`,
        pilot: `${H.pilot} HORIZON is the reason we’re awake—pressure on the stick went wrong in the same breath as the shock.`
      },
      phase_shock: {
        doctor: `${H.doctor} Phase shock spiked biometrics across awake crew—classic stress, but also duplicate channel overlap on one ID.`,
        engineer: `${H.engineer} Phase shock is logged as a Project HORIZON transition fault—AXI↔HADES handshakes spike exactly there.`,
        navigator: `${H.navigator} Phase shock shows as chart/bridge disagreement for the same minute—route truth splits.`,
        pilot: `${H.pilot} Phase shock felt like the hull skipped—controls lagged, silence wrong; not normal turbulence.`
      },
      neptune: {
        doctor: `${H.doctor} We’re on Neptune’s doorstep for the gravity experiment—environmental stress is real, but the anomaly is crew-identity, not weather.`,
        engineer: `${H.engineer} Orbital frame near Neptune is in the mission profile—logs anchor there; don’t invent another star system.`,
        navigator: `${H.navigator} Fix is Neptune-orbit for this leg—drift math has to match that shell, not random deep-space.`,
        pilot: `${H.pilot} Outside is Neptune black—inside, the wrongness is the experiment, not the view.`
      },
      gravity: {
        doctor: `${H.doctor} Gravity-drive stress shows as vestibular and vitals coupling—consistent with phase shock, not a generic fever.`,
        engineer: `${H.engineer} Drive stack and AXIS coupling are where HORIZON lives—checksum fights there, not in a random backup server.`,
        navigator: `${H.navigator} Warp/gravity residuals show on the plot as shear—same window as phase shock.`,
        pilot: `${H.pilot} Hands on the stick: the drive hiccup and the wrong silence line up—this is the experiment biting back.`
      },
      awakened: {
        doctor: `${H.doctor} Forced wake after AXIS emergency—one life sign doesn’t match the roster; that is the medical headline.`,
        engineer: `${H.engineer} Wake sequence is AXIS-issued; HADES traces appear when the wrong crew channel asserts.`,
        navigator: `${H.navigator} Awakened crew means charts repopulate fast—any ghost coordinate is tied to that shock, not old cargo.`,
        pilot: `${H.pilot} We were pulled out cold—bridge air tasted wrong before anyone spoke; that’s the wake, not coffee.`
      },
      ship: {
        doctor: `${H.doctor} Tartarus is the missing experimental hull in the brief—quarantine rules apply because identity is the variable.`,
        engineer: `${H.engineer} Hull ID matches experimental stack—blackouts and comms loss are in the same incident bundle as HORIZON.`,
        navigator: `${H.navigator} This ship’s filed route was Neptune experiment—drift off-file reads as nested trace, not tourism.`,
        pilot: `${H.pilot} We’re on the experimental ship everyone else lost—feel it in the glass when AXIS lies.`
      },
      nested: {
        doctor: `${H.doctor} Nested entity reads as two life templates time-sharing one body—quarantine is the only honest protocol I have.`,
        engineer: `${H.engineer} Nested signal shows in AXIS as a sealed channel under the roster—HADES fence, not a spare partition.`,
        navigator: `${H.navigator} Nested coordinate folds the chart—same minute, two truths; phase shock aligns.`,
        pilot: `${H.pilot} Nested feels like the bridge listens twice—wrong silence, not a bulb out.`
      },
      general: {
        doctor: `${H.doctor} Tartarus near Neptune: vitals say one crew channel is foreign—bind, not a generic clinic code.`,
        engineer: `${H.engineer} AXIS is official; HADES is sealed inside it post–Project HORIZON shock—logs prove the layer, not a backup nav myth.`,
        navigator: `${H.navigator} Phase shock and chart shear are the same incident window—stay on Neptune experiment math.`,
        pilot: `${H.pilot} Bridge dread matches the shock and the sealed stack—no generic hazard tape explains it.`
      }
    },
    ko: {
      hades: {
        doctor: `${H.doctor} HADES는 의무 프로토콜 이름이 아니라, 한 승무원 채널에 겹쳐 붙은 제2 서명에 가깝다. phase shock 이후 깨어난 봉인층이다.`,
        engineer: `${H.engineer} AXIS 스택 안에 봉인된 비인가 계층이 HADES다. HORIZON 동기가 끊기는 지점과 핸드셰이크가 겹친다. 일반 백업 DB가 아니다.`,
        navigator: `${H.navigator} phase shock 직후 차트에 중첩 자취가 남는다. 항법상 허가 루트 밖—HADES 각성과 같은 사건 창이다.`,
        pilot: `${H.pilot} 브리지에선 알람이 아니라 ‘의도’가 느껴진다. HADES는 충격 이후 깨어난 층이라 기사 감각에 남는다.`
      },
      axis: {
        doctor: `${H.doctor} AXIS는 공식 함선 AI·시스템 층이다. HADES는 그 AXIS 안에 봉인된 비인가 레이어로, 매뉴얼 밖 생체 이상은 그 결합에서 읽힌다.`,
        engineer: `${H.engineer} AXIS는 공식 스택이다. HADES는 AXIS 내부에 잠긴 비인가 계층—권한 울타리가 로그에 남는다. 항법 백업·일반 백업 DB가 아니다.`,
        navigator: `${H.navigator} 항로 진실은 AXIS 테이블에 달렸다. 차트가 접히면 그건 AXIS 안에 묻힌 HADES 봉인층 신호다.`,
        pilot: `${H.pilot} AXIS가 인증한 것만 날린다. 그런데 HUD가 거짓말할 때, 그건 AXIS 아래에 깔린 HADES 층 때문이다.`
      },
      horizon: {
        doctor: `${H.doctor} 프로젝트 HORIZON은 실험 코드명이다. phase shock에서 생체와 명부가 갈라졌다.`,
        engineer: `${H.engineer} HORIZON 메타데이터가 동기 단절 지점이다. 그 포크에서 HADES 핸드셰이크가 AXIS 안에 찍힌다.`,
        navigator: `${H.navigator} HORIZON은 해왕성 근접 워프·중력 다리와 연결된다. 교훈용 은유로 바꾸지 말 것.`,
        pilot: `${H.pilot} 우리를 깨운 이유가 HORIZON이다. 충격과 조종감이 같은 숨에 터진다.`
      },
      phase_shock: {
        doctor: `${H.doctor} phase shock는 기상 승무원 전원에 생체 스파이크를 남겼다. 한 ID에 채널이 겹친다.`,
        engineer: `${H.engineer} phase shock는 HORIZON 전이 결함으로 로그된다. 그 시각에 AXIS↔HADES 핸드셰이크가 튄다.`,
        navigator: `${H.navigator} phase shock는 같은 분에 항로·교량 기록이 갈라진다. 진실이 둘로 쪼개진다.`,
        pilot: `${H.pilot} phase shock는 선체가 한 박자 건너뛴 느낌이다. 조종이 늦고 무음이 잘못됐다.`
      },
      neptune: {
        doctor: `${H.doctor} 해왕성 문턱 실험이다. 환경 스트레스는 있지만 이상의 핵은 신원이다.`,
        engineer: `${H.engineer} 궤도 프레임은 로그에 박혀 있다. 다른 성계로 바꾸지 말 것.`,
        navigator: `${H.navigator} 이 다리는 해왕성 궤도 셸에 맞춰야 한다. 드리프트는 그 전제 위에서다.`,
        pilot: `${H.pilot} 밖은 해왕성의 검은 바다다. 안의 오싹함은 실험에서 온다.`
      },
      gravity: {
        doctor: `${H.doctor} 중력 드라이브 스트레스는 전정·바이탈 결합으로 온다. phase shock와 같은 계열이다.`,
        engineer: `${H.engineer} 드라이브 스택과 AXIS 결합부가 HORIZON의 무대다. 여기서 체크섬이 싸운다.`,
        navigator: `${H.navigator} 워프·중력 잔차는 항로에 전단(shear)으로 남는다. phase shock와 같은 창이다.`,
        pilot: `${H.pilot} 스틱에 손을 얹으면 드라이브 멈춤과 무음이 겹친다. 실험이 되물었다.`
      },
      awakened: {
        doctor: `${H.doctor} AXIS 비상에 의한 강제 기상이다. 한 생체가 명부와 맞지 않는다.`,
        engineer: `${H.engineer} 기상 시퀀스는 AXIS 발급이다. 잘못된 승무원 채널이 뜰 때 HADES 자취가 겹친다.`,
        navigator: `${H.navigator} 기상 직후 차트가 빠르게 채워진다. 유령 좌표는 그 충격에 묶인다.`,
        pilot: `${H.pilot} 억지로 깨어났다. 말하기 전부터 공기가 달랐다.`
      },
      ship: {
        doctor: `${H.doctor} Tartarus는 브리핑에 나온 실험함 본체다. 신원이 변수라 격리 규칙이 붙는다.`,
        engineer: `${H.engineer} 선체 ID는 실험 스택과 맞다. 통신 두절·정전은 HORIZON 묶음 사건이다.`,
        navigator: `${H.navigator} 등록 항로는 해왕성 실험이다. 파일 밖 드리프트는 중첩 자취다.`,
        pilot: `${H.pilot} 남들이 잃은 실험선이 이거다. AXIS가 거짓말할 때 유리가 먼저 안다.`
      },
      nested: {
        doctor: `${H.doctor} 중첩체는 한 몸에 두 생체 템플릿이 시간 분할하는 패턴이다. 격리가 유일한 확정 대응이다.`,
        engineer: `${H.engineer} AXIS에 명부 밑에 잠긴 채널로 찍힌다. HADES 울타리지 일반 파티션이 아니다.`,
        navigator: `${H.navigator} 차트가 접히는 건 같은 분에 두 진실이다. phase shock와 맞닿는다.`,
        pilot: `${H.pilot} 교량이 두 번 듣는 느낌이다. 전구 하나 나간 수준이 아니다.`
      },
      general: {
        doctor: `${H.doctor} 해왕성 근접 실험에서 한 승무원 채널이 외부다. 클리닉 코드가 아니라 결속·중첩 문제다.`,
        engineer: `${H.engineer} AXIS가 공식, HADES는 그 안의 봉인층—HORIZON shock 이후다. 백업 항법 같은 소리로 바꾸지 말 것.`,
        navigator: `${H.navigator} phase shock·차트 전단은 같은 사건 창이다. 해왕성 실험 설정 안에서만 말할 것.`,
        pilot: `${H.pilot} 브리지의 불안은 충격과 봉인 스택과 한 줄에 있다. 일반 경고 테이프로는 안 설명된다.`
      }
    }
  };
  const pack = packs[loc][T] || packs[loc].general;
  return pack;
}

/**
 * lore_question LLM 실패 시 전용 — loreFallbackByTopic(topic). 수상/동선 브리핑·제네릭 SF 금지.
 */
function buildLoreQuestionDeterministicFallbackEvents(match, locale, captainBodyForLore, topic) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const headers = getLlmRoleHeaders(loc);
  const gs = match.game_state || {};
  const deadRoles = gs.dead_roles || [];
  const crewOrder = ['doctor', 'engineer', 'navigator', 'pilot'];
  const alive = crewOrder.filter((r) => !deadRoles.includes(r));
  const cap = headers.captain;
  const body =
    String(captainBodyForLore || '').trim() ||
    (loc === 'en' ? 'What is this about?' : '이게 무엇이지?');
  const captainLine = `${cap} ${body}`;
  const t = topic || detectLoreQuestionTopic(captainBodyForLore, loc);
  const byRole = loreFallbackByTopic(t, loc, headers);

  const events = [{ type: 'CREW_DIALOGUE', role: 'captain', dialogue: captainLine }];
  for (const r of alive) {
    const line = byRole[r];
    if (line) events.push({ type: 'CREW_DIALOGUE', role: r, dialogue: line });
  }
  return events;
}

/** 표시 로그(헤더+본문[+선택 narration]) → 저장용 CREW_DIALOGUE 이벤트 */
function displayLogsToCrewDialogueEvents(displayLogs, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const h = getLlmRoleHeaders(loc);
  const headerToRole = {
    [h.captain]: 'captain',
    [h.doctor]: 'doctor',
    [h.engineer]: 'engineer',
    [h.navigator]: 'navigator',
    [h.pilot]: 'pilot'
  };
  const sysH = systemHeader(loc);
  const logs = Array.isArray(displayLogs) ? displayLogs : [];
  const out = [];
  let i = 0;
  while (i < logs.length) {
    const t0 = String(logs[i]?.type || '').trim();
    const t1 = i + 1 < logs.length ? String(logs[i + 1]?.type || '').trim() : '';
    const role = headerToRole[t0];
    if (role && t1 && !/^\[[^\]]+\]$/.test(t1)) {
      let dialogue = `${t0} ${t1}`.replace(/\s+/g, ' ').trim();
      i += 2;
      while (i < logs.length) {
        const tn = String(logs[i]?.type || '').trim();
        if (headerToRole[tn] || tn === sysH) break;
        dialogue += '\n' + tn;
        i++;
      }
      out.push({ type: 'CREW_DIALOGUE', role, dialogue });
      continue;
    }
    i++;
  }
  return out;
}

/**
 * 특정 역할 의견 질문 — target이 반드시 첫 대사, 나머지는 짧은 보조만.
 */
function buildRoleOpinionQuestionEvents(match, targetRole, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const headers = getLlmRoleHeaders(loc);
  const sys = systemHeader(loc);
  const t = String(targetRole || '').toLowerCase();
  const gs = match.game_state || {};
  const deadRoles = gs.dead_roles || [];
  const crewOrder = ['doctor', 'engineer', 'navigator', 'pilot'];
  const alive = crewOrder.filter((r) => !deadRoles.includes(r));

  if (!crewOrder.includes(t)) {
    return [
      {
        type: 'CREW_DIALOGUE',
        role: 'system',
        dialogue:
          loc === 'en'
            ? `${sys} No valid crew role was named.`
            : `${sys} 유효한 승무원 역할이 아닙니다.`
      }
    ];
  }
  if (!alive.includes(t)) {
    return [
      {
        type: 'CREW_DIALOGUE',
        role: 'system',
        dialogue:
          loc === 'en'
            ? `${sys} That crew member is no longer on the roster.`
            : `${sys} 해당 승무원은 이미 생체 신호가 끊긴 상태입니다.`
      }
    ];
  }

  const others = alive.filter((r) => r !== t);
  const turn = match.turn || 1;
  const pickRole = others.length ? others[turn % others.length] : null;
  const pkKo = pickRole ? roleNameKo(pickRole) : '';
  const pkEn = pickRole ? roleNameEn(pickRole) : '';

  function targetOpinionFirst() {
    if (!pickRole) {
      if (loc === 'en') {
        return {
          doctor: `${headers.doctor} Right now I find the weakest alibi the most suspicious. Vitals and wording don't line up.`,
          engineer: `${headers.engineer} Right now I find the worst timestamp mismatch the most suspicious.`,
          navigator: `${headers.navigator} Right now I find the chart mismatch the most suspicious.`,
          pilot: `${headers.pilot} Right now I find the shakiest helm story the most suspicious.`
        }[t];
      }
      return {
        doctor: `${headers.doctor} 지금은 동선과 생체 지표가 맞지 않는 쪽이 가장 수상합니다.`,
        engineer: `${headers.engineer} 지금은 타임스탬프가 가장 어긋난 쪽이 가장 수상합니다.`,
        navigator: `${headers.navigator} 지금은 항로 기록과 맞지 않는 쪽이 가장 수상합니다.`,
        pilot: `${headers.pilot} 지금은 조종석 기록과 맞지 않는 쪽이 가장 수상합니다.`
      }[t];
    }
    if (loc === 'en') {
      const m = {
        doctor: `${headers.doctor} Right now ${pkEn} looks most suspicious to me. Vitals and their story don't line up.`,
        engineer: `${headers.engineer} Right now ${pkEn} looks most suspicious to me. Timestamps don't match the access logs.`,
        navigator: `${headers.navigator} Right now ${pkEn} looks most suspicious to me. Charts and bridge records diverge there.`,
        pilot: `${headers.pilot} Right now ${pkEn} looks most suspicious to me. Helm logs and their route don't line up.`
      };
      return m[t] || m.doctor;
    }
    const m = {
      doctor: `${headers.doctor} 지금은 ${pkKo} 쪽이 가장 수상합니다. 생체 반응과 말의 흐름이 어긋났습니다.`,
      engineer: `${headers.engineer} 지금은 ${pkKo} 쪽이 가장 수상합니다. 타임스탬프와 접근 기록이 맞지 않습니다.`,
      navigator: `${headers.navigator} 지금은 ${pkKo} 쪽이 가장 수상합니다. 항로와 교량 기록이 그 시간대에 어긋납니다.`,
      pilot: `${headers.pilot} 지금은 ${pkKo} 쪽이 가장 수상합니다. 조종석 로그와 동선이 맞지 않습니다.`
    };
    return m[t] || m.doctor;
  }

  const aux = {
    doctor: {
      ko: `${headers.doctor} 동의합니다. 제 쪽 데이터로 맞춰 보겠습니다.`,
      en: `${headers.doctor} Understood. I'll align with my panels.`
    },
    engineer: {
      ko: `${headers.engineer} 알겠습니다. 로그로 바로 대조하겠습니다.`,
      en: `${headers.engineer} Copy. I'll match it to logs.`
    },
    navigator: {
      ko: `${headers.navigator} 확인하겠습니다. 항로만 다시 보겠습니다.`,
      en: `${headers.navigator} Noted. I'll re-check the chart slice.`
    },
    pilot: {
      ko: `${headers.pilot} 네. 조종석 기록만 짚어보겠습니다.`,
      en: `${headers.pilot} Roger. I'll stick to helm records.`
    }
  };

  const first = targetOpinionFirst();
  const events = [{ type: 'CREW_DIALOGUE', role: t, dialogue: first }];

  for (const r of crewOrder) {
    if (r === t || !alive.includes(r)) continue;
    const line = aux[r][loc];
    if (line) events.push({ type: 'CREW_DIALOGUE', role: r, dialogue: line });
  }
  return events;
}

/**
 * 표시 로그로부터 miniapp summary 문자열 (함장/시스템 블록이 완성되면 zero-width)
 */
/**
 * 매치 이벤트가 비어 있고 진행 중이면 locale에 맞는 초기 시스템 한 줄만 표시용으로 보강.
 */
function ensureInitialSystemDisplayLogs(displayLogs, match, locale) {
  const gs = match?.game_state || {};
  if (gs.game_over) return displayLogs || [];
  const logs = Array.isArray(displayLogs) ? displayLogs : [];
  if (logs.length > 0) return logs;
  const loc = locale === 'en' ? 'en' : 'ko';
  const sys = systemHeader(loc);
  const line =
    loc === 'en'
      ? `${sys} Tartarus Protocol initialized.`
      : `${sys} 타르타로스 프로토콜이 초기화되었습니다.`;
  const raw = [{ type: 'CREW_DIALOGUE', role: 'system', dialogue: line }];
  return dedupeDisplayLogs(toPlayerDisplayLogs(raw, { locale: loc }), loc);
}

function summaryFromDisplayLogs(newDisplayLogs, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const capH = captainHeader(loc);
  const sysH = systemHeader(loc);
  if (!newDisplayLogs || !newDisplayLogs.length) return '\u200b';
  const isCaptainBlock = newDisplayLogs.length >= 2 && newDisplayLogs[0].type === capH;
  const captainBody = isCaptainBlock ? String(newDisplayLogs[1].type || '').trim() : '';
  const hasCompleteCaptainBlock = isCaptainBlock && captainBody.length > 0;
  const isSystemBlock = newDisplayLogs.length >= 2 && newDisplayLogs[0].type === sysH;
  const systemBody = isSystemBlock ? String(newDisplayLogs[1].type || '').trim() : '';
  const hasCompleteSystemBlock = isSystemBlock && systemBody.length > 0;
  if (hasCompleteCaptainBlock || hasCompleteSystemBlock) return '\u200b';
  return newDisplayLogs[0].type || '\u200b';
}

/**
 * ep1Engine CLUE_CATALOG(id·한글 text)와 동기 — locale=en일 때 표시만 영어로 (엔진/저장 값 불변).
 */
const CLUE_TEXT_EN_BY_ID = {
  bridge_log_gap: 'Bridge watch logs show a gap between 02:14 and 02:18.',
  medbay_access: 'Medbay access logs show a short unauthorized presence.',
  bio_spike: 'Lower-deck corridor biosensors captured a brief spike.',
  engineering_checksum: 'Engine room safety log checksum does not match the previous cycle.',
  nav_chart_drift: 'Slight trajectory drift between the nav chart backup and main log.',
  cctv_sync: 'CCTV timestamps are several seconds off from ship NTP sync.'
};

const CLUE_TEXT_KO_TO_EN = {
  '교량 감시 로그 02:14~02:18 구간이 공백으로 남아 있다.': CLUE_TEXT_EN_BY_ID.bridge_log_gap,
  '의무실 출입 기록에 승인 없는 재실이 짧게 찍혀 있다.': CLUE_TEXT_EN_BY_ID.medbay_access,
  '저선실 복도 생체 센서에 일시적 스파이크가 포착되었다.': CLUE_TEXT_EN_BY_ID.bio_spike,
  '엔진실 안전 로그 체크섬이 이전 주기와 불일치한다.': CLUE_TEXT_EN_BY_ID.engineering_checksum,
  '항법 차트 백업과 메인 항해 기록 사이에 미세한 궤적 어긋남이 있다.': CLUE_TEXT_EN_BY_ID.nav_chart_drift,
  'CCTV 타임스탬프와 함선 NTP 동기 사이에 수 초 단위 어긋남이 있다.': CLUE_TEXT_EN_BY_ID.cctv_sync
};

/** FIND_CLUE 함장 액션 한 줄 — en은 엔진 한글 captain_action과 무관하게 고정 */
function localizeFindClueCaptainLine(locale, captainActionRaw) {
  if (locale === 'en') return 'Collects a clue.';
  const a = String(captainActionRaw || '').trim();
  return a || '단서를 수집한다';
}

/**
 * FIND_CLUE 시스템 단서 본문 — en이면 id 또는 정확 한글 일치로 영어 표시문만 사용
 * @param {boolean} [silent] - true면 debug 로그 생략 (merge 경로에서 이중 로그 방지)
 */
function localizeClueSystemLineForDisplay(locale, clueId, clueText, silent) {
  const raw = String(clueText || '').trim();
  if (locale !== 'en') return raw;
  const id = clueId != null ? String(clueId).trim() : '';
  let out = raw;
  if (id && CLUE_TEXT_EN_BY_ID[id]) {
    out = CLUE_TEXT_EN_BY_ID[id];
  } else if (raw && CLUE_TEXT_KO_TO_EN[raw]) {
    out = CLUE_TEXT_KO_TO_EN[raw];
  }
  if (!silent && out !== raw) {
    console.log('[bot] CLUE_LOCALIZED locale=en source=system');
  }
  return out;
}

/**
 * non-terminal 배치만: QUESTION / LORE_QUESTION / SUSPECT / CHECK_LOG / THREATEN / TAKE_PISTOL / FIND_CLUE(단서 확보)
 * 에러용 CREW_DIALOGUE 단독 배치는 null
 */
function getDialogueLlmKind(events) {
  const ev0 = events && events[0];
  if (!ev0) return null;
  const t = String(ev0.type || '').toUpperCase();
  if (t === 'LORE_QUESTION') return 'LORE_QUESTION';
  if (t === 'QUESTION' && ev0.target) return 'QUESTION';
  if (t === 'SUSPECT' && ev0.target) return 'SUSPECT';
  if (t === 'CHECK_LOG') return 'CHECK_LOG';
  if (t === 'THREATEN' && ev0.target) return 'THREATEN';
  if (t === 'TAKE_PISTOL') return 'TAKE_PISTOL';
  if (t === 'FIND_CLUE' && (ev0.clue_text || ev0.clue_id)) return 'FIND_CLUE';
  return null;
}

/** getDialogueLlmKind 값 → 터미널 action 슬러그 */
function dialogueActionKindSlug(engineKind) {
  const m = {
    QUESTION: 'question',
    LORE_QUESTION: 'lore_question',
    SUSPECT: 'suspect',
    CHECK_LOG: 'check_log',
    THREATEN: 'threaten',
    TAKE_PISTOL: 'take_pistol',
    FIND_CLUE: 'collect_clue'
  };
  return m[engineKind] || String(engineKind || '').toLowerCase();
}

function logDialogueTrace(actionSlug, provider, modelStr, result, eventsCount) {
  console.log(
    '[dialogue] action=' +
      actionSlug +
      ' provider=' +
      provider +
      ' model=' +
      modelStr +
      ' result=' +
      result +
      ' events=' +
      eventsCount
  );
}

function expectedCrewOrderForLlm(kind, target, deadRoles, rawEvents) {
  const dead = new Set((deadRoles || []).map((r) => String(r).toLowerCase()));
  const alive = ['doctor', 'engineer', 'navigator', 'pilot'].filter((r) => !dead.has(r));
  const t = target ? String(target).toLowerCase() : null;
  if (kind === 'QUESTION' || kind === 'SUSPECT' || kind === 'THREATEN') {
    const tf = alive.filter((r) => r === t);
    const rest = alive.filter((r) => r !== t);
    return [...tf, ...rest];
  }
  if (kind === 'LORE_QUESTION') {
    return alive;
  }
  if (kind === 'CHECK_LOG') {
    const order = [];
    for (const ev of rawEvents || []) {
      if (String(ev.type) !== 'CREW_DIALOGUE') continue;
      const r = String(ev.role || '').toLowerCase();
      if (!['doctor', 'engineer', 'navigator', 'pilot'].includes(r)) continue;
      if (dead.has(r)) continue;
      if (!order.includes(r)) order.push(r);
    }
    const base = order.length ? order : alive;
    const uniq = [];
    for (const r of base) {
      if (!alive.includes(r)) continue;
      if (!uniq.includes(r)) uniq.push(r);
    }
    for (const r of alive) {
      if (!uniq.includes(r)) uniq.push(r);
    }
    if (uniq.includes('engineer')) {
      return ['engineer', ...uniq.filter((r) => r !== 'engineer')];
    }
    return uniq;
  }
  if (kind === 'FIND_CLUE') return alive;
  return alive;
}

/** LLM이 한글·대괄호·영문으로 준 role/header 토큰 → canonical role 키 */
function canonicalRoleFromLlmToken(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^\[/, '').replace(/\]$/, '').trim();
  const k = s.toLowerCase();
  const MAP = {
    captain: 'captain',
    함장: 'captain',
    doctor: 'doctor',
    닥터: 'doctor',
    engineer: 'engineer',
    엔지니어: 'engineer',
    navigator: 'navigator',
    네비게이터: 'navigator',
    pilot: 'pilot',
    파일럿: 'pilot'
  };
  return MAP[k] || null;
}

/**
 * role="header" 등 오표기 시 text에서 역할 복구. text가 순수 역할 라벨이면 narration을 text로 승격.
 * 복구 불가면 null → 호출측에서 블록 skip.
 */
function resolveLlmBlockRoleAndLines(b) {
  if (!b || typeof b !== 'object') return null;
  const roleLo = String(b.role ?? '').trim().toLowerCase();
  let canon = canonicalRoleFromLlmToken(b.role);
  if (!canon) canon = canonicalRoleFromLlmToken(b.header);

  let text = String(b.text != null ? b.text : '').trim();
  let narr = b.narration != null ? String(b.narration).trim() : '';

  if (!canon && roleLo === 'header') {
    const fromText = canonicalRoleFromLlmToken(text);
    if (!fromText) return null;
    canon = fromText;
    if (canonicalRoleFromLlmToken(text) === canon) {
      text = narr;
      narr = '';
    }
    return { canon, text, narration: narr };
  }

  if (!canon) return null;
  return { canon, text, narration: narr };
}

/**
 * 검증 전: role/header 정규화, 역할별 1블록으로 병합(빈 text면 나중 비어 있지 않은 쪽 선호)
 */
function normalizeLlmDialogueBlocksArray(blocks, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const headers = getLlmRoleHeaders(loc);
  if (!Array.isArray(blocks)) return [];
  const merged = new Map();
  for (const b of blocks) {
    const res = resolveLlmBlockRoleAndLines(b);
    if (!res) continue;
    const { canon, text, narration: narr } = res;
    const hdr = headers[canon];
    const prev = merged.get(canon);
    if (!prev) {
      merged.set(canon, { role: canon, header: hdr, text, narration: narr });
      continue;
    }
    const pt = String(prev.text || '').trim();
    const nt = text;
    merged.set(canon, {
      role: canon,
      header: hdr,
      text: pt || nt,
      narration: String(prev.narration || '').trim() || narr
    });
  }
  return Array.from(merged.values());
}

/** role 키 → 베르셀 고정 헤더 (대괄호 포함) */
function canonicalHeaderFromRoleKey(roleKey, locale) {
  const r = String(roleKey || '').toLowerCase();
  return getLlmRoleHeaders(locale === 'en' ? 'en' : 'ko')[r] || null;
}

function resolveBracketInnerToRole(inner) {
  const key = String(inner || '').trim().toLowerCase();
  const MAP = {
    captain: 'captain',
    함장: 'captain',
    doctor: 'doctor',
    닥터: 'doctor',
    engineer: 'engineer',
    엔지니어: 'engineer',
    navigator: 'navigator',
    네비게이터: 'navigator',
    pilot: 'pilot',
    파일럿: 'pilot'
  };
  return MAP[key] || null;
}

/**
 * 플레이어 로그 한 줄이 역할 헤더로 쓰일 수 있는 문자열이면 locale 기준 대괄호로 통일.
 * 본문 대사는 길이·매칭 실패 시 그대로 둠.
 */
function canonicalBracketHeaderFromTypeString(s, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const raw = String(s || '').trim();
  if (!raw) return null;
  const sys = systemHeader(loc);
  if (raw === '[시스템]' || raw === '[System]') return sys;

  let inner = raw;
  if (raw.startsWith('[') && raw.endsWith(']') && raw.length >= 3) {
    inner = raw.slice(1, -1).trim();
  }
  const roleKey = resolveBracketInnerToRole(inner);
  if (roleKey) return getLlmRoleHeaders(loc)[roleKey];
  return null;
}

/**
 * 단독 줄 "함장이 …" / "The captain …" 서술을 locale 기준 함장 헤더 + 본문으로 승격.
 * 시스템·단독 역할 헤더는 그대로. 직전이 함장+본문이면 본문만 이어붙임.
 */
function promoteCaptainStandaloneDisplayLogs(logs, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const capH = captainHeader(loc);
  const sysH = systemHeader(loc);
  if (!Array.isArray(logs) || !logs.length) return logs;
  const out = [];

  function tryMergeOrPushCaptainBody(srcItem, body) {
    const b = String(body || '').trim();
    if (!b) return;
    const n = out.length;
    if (n >= 2) {
      const hdr = out[n - 2];
      const bodyLine = out[n - 1];
      const hdrT = String(hdr.type || '').trim();
      const lineT = String(bodyLine.type || '').trim();
      if (hdrT === capH && lineT && !/^\s*\[/.test(lineT)) {
        bodyLine.type = lineT ? `${lineT}\n${b}` : b;
        return;
      }
    }
    const base = { ...srcItem };
    delete base.type;
    out.push({ ...base, type: capH, _key: (srcItem._key != null ? String(srcItem._key) : '') + '|promo-cap-h' });
    out.push({ ...base, type: b, _key: (srcItem._key != null ? String(srcItem._key) : '') + '|promo-cap-b' });
  }

  let i = 0;
  while (i < logs.length) {
    const item = logs[i];
    const t = String(item.type || '').trim();

    if (t === sysH) {
      out.push({ ...item });
      i++;
      continue;
    }

    if (t === capH) {
      out.push({ ...item });
      i++;
      while (i < logs.length) {
        const nt = String(logs[i].type || '').trim();
        if (nt === capH) break;
        if (nt.startsWith('[')) break;
        out.push({ ...logs[i] });
        i++;
      }
      continue;
    }

    if (/^\[[^\]]+\]$/.test(t)) {
      out.push({ ...item });
      i++;
      continue;
    }

    if (loc === 'ko' && /^\s*함장(?:이|은)\s+/i.test(t)) {
      let body = t
        .replace(/^\s*함장이\s+/i, '')
        .replace(/^\s*함장은\s+/i, '')
        .trim();
      if (/확인했다\.?$/.test(body)) body = body.replace(/확인했다\.?$/, '확인한다.');
      tryMergeOrPushCaptainBody(item, body);
      i++;
      continue;
    }

    if (loc === 'en' && /^\s*(?:The\s+)?captain\s+/i.test(t)) {
      let body = t.replace(/^\s*(?:The\s+)?captain\s+/i, '').trim();
      if (/^checked\b/i.test(body)) body = body.replace(/^checked\b/i, 'checks');
      tryMergeOrPushCaptainBody(item, body);
      i++;
      continue;
    }

    out.push({ ...item });
    i++;
  }
  return out;
}

function normalizePlayerFacingDisplayLogs(logs, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  if (!Array.isArray(logs) || !logs.length) return logs;
  const mapped = logs.map((item) => {
    const c = canonicalBracketHeaderFromTypeString(item.type, loc);
    if (c != null) return { ...item, type: c };
    return item;
  });
  return promoteCaptainStandaloneDisplayLogs(mapped, loc);
}

/** LLM block → 표시용 헤더: role 우선, 없으면 header 문자열에서 역할 추론 */
function canonicalHeaderForLlmBlock(b, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const sys = systemHeader(loc);
  const role = String(b.role || '').toLowerCase();
  const fromRole = canonicalHeaderFromRoleKey(role, loc);
  if (fromRole) return fromRole;
  const fromHeader = canonicalBracketHeaderFromTypeString(String(b.header || '').trim(), loc);
  if (fromHeader && fromHeader !== sys) return fromHeader;
  return captainHeader(loc);
}

function extractJsonObjectFromLlmText(raw) {
  const s = String(raw || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : s;
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first < 0 || last < first) return null;
  try {
    return JSON.parse(body.slice(first, last + 1));
  } catch (_) {
    return null;
  }
}

function koreanHeavyEnoughForDialogue(texts, minRatio) {
  const s = texts.join('\n');
  const hangul = (s.match(/[\uAC00-\uD7A3]/g) || []).length;
  const latin = (s.match(/[a-zA-Z]/g) || []).length;
  const total = hangul + latin;
  if (total === 0) return false;
  return hangul / total >= minRatio;
}

function dialogueLanguageOk(texts, locale) {
  const s = texts.join('\n');
  if (locale === 'en') {
    const hangul = (s.match(/[\uAC00-\uD7A3]/g) || []).length;
    if (hangul > 12) return false;
    const latin = (s.match(/[a-zA-Z]/g) || []).length;
    return latin >= 20;
  }
  return koreanHeavyEnoughForDialogue(texts, 0.2);
}

function hasExcessiveLineRepetition(blocks, maxSame) {
  const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const counts = new Map();
  for (const b of blocks) {
    for (const part of ['text', 'narration']) {
      const line = norm(b[part]);
      if (line.length < 12) continue;
      counts.set(line, (counts.get(line) || 0) + 1);
      if (counts.get(line) > maxSame) return true;
    }
  }
  return false;
}

/** deterministic display에서 함장 헤더 직후 본문 — 사용자 액션/엔진 고정 문장 유지용 */
function extractCaptainSpokenFromDisplayLogs(displayLogs, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const capH = captainHeader(loc);
  const d = displayLogs || [];
  if (d.length >= 2 && String(d[0].type || '').trim() === capH) {
    const body = String(d[1].type || '').trim();
    if (body) return body;
  }
  return '';
}

/** 베르셀 톤과 어긋나는 공허 훈계·진정 멘트 등 */
const BANNED_CREW_DIALOGUE_RES = [
  /우리는\s*신중해야/,
  /신중해야\s*해/,
  /신중히\s*행동/,
  /모두\s*진정/,
  /진정하세/,
  /침착하게/,
  /함께\s*힘을/,
  /서로\s*믿/,
  /일단\s*진정/,
  /훈계/,
  /교훈/,
  /도덕적/,
  /과도하게\s*긴장/,
  /불필요한\s*갈등/,
  /화\s*내지\s*말/,
  /차분히\s*대화/
];

/** 함장 3인칭 서술(미니앱 deterministic과 겹치는 generic) */
const BANNED_CAPTAIN_NARRATION_RES = [
  /함장이\s*교량/,
  /함장은\s*교량/,
  /함장이\s*관찰/,
  /함장은\s*.*표정/,
  /함장이\s*.*표정/,
  /함장은\s*긴장/,
  /함장이\s*긴장/,
  /함장이\s*한숨/,
  /함장은\s*한숨/,
  /긴장한\s*표정으로/,
  /단호한\s*눈빛으로/,
  /깊은\s*한숨을/
];

function combinedBlockText(b) {
  return `${String(b.text || '')}\n${String(b.narration || '')}`;
}

function hasBannedCrewOrCaptainPatterns(sorted) {
  for (const b of sorted) {
    const role = String(b.role || '').toLowerCase();
    const pack = combinedBlockText(b);
    if (!pack.trim()) continue;
    for (const re of BANNED_CREW_DIALOGUE_RES) {
      if (re.test(pack)) return true;
    }
    if (role === 'captain') {
      const narr = String(b.narration || '').trim();
      if (narr) {
        for (const re of BANNED_CAPTAIN_NARRATION_RES) {
          if (re.test(narr)) return true;
        }
      }
    }
  }
  return false;
}

/** 함장 블록은 LLM 대신 deterministic 본문으로 고정, 함장 narration 제거 */
function applyForcedCaptainToSorted(sorted, forcedCaptainText, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const capHdr = captainHeader(loc);
  const ft = String(forcedCaptainText || '').trim();
  const rest = sorted.filter((b) => String(b.role || '').toLowerCase() !== 'captain');
  if (ft) {
    rest.unshift({
      role: 'captain',
      header: capHdr,
      text: ft,
      narration: ''
    });
    return rest;
  }
  const copy = sorted.map((b) => ({ ...b }));
  const cap = copy.find((x) => String(x.role || '').toLowerCase() === 'captain');
  if (cap) cap.narration = '';
  return copy;
}

function sortLlmBlocksByExpected(blocks, crewOrder) {
  const byRole = new Map();
  for (const b of blocks) {
    const r = String(b.role || '').toLowerCase();
    if (r === 'captain') continue;
    if (!byRole.has(r)) byRole.set(r, b);
  }
  const cap = blocks.find((b) => String(b.role || '').toLowerCase() === 'captain');
  const ordered = [];
  if (cap) ordered.push(cap);
  for (const r of crewOrder) {
    const x = byRole.get(r);
    if (x) ordered.push(x);
  }
  return ordered;
}

/** 정렬 후 헤더·함장 narration 정리 */
function finalizeNormalizedLlmBlocks(sorted, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const headers = getLlmRoleHeaders(loc);
  return sorted.map((b) => {
    const r = String(b.role || '').toLowerCase();
    const hdr = headers[r];
    const out = { ...b, role: r, header: hdr || b.header };
    if (r === 'captain') out.narration = '';
    return out;
  });
}

function validateLlmDialogueBlocks(parsed, kind, expectedCrew, opts) {
  opts = opts || {};
  const locale = opts.locale === 'en' ? 'en' : 'ko';
  const forcedCaptainText = String(opts.forcedCaptainText || '').trim();

  if (!parsed || typeof parsed !== 'object') return null;
  const blocks = parsed.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return null;

  const normalized = normalizeLlmDialogueBlocksArray(blocks, locale);
  if (normalized.length === 0) return null;

  let sorted = sortLlmBlocksByExpected(normalized, expectedCrew);
  sorted = applyForcedCaptainToSorted(sorted, forcedCaptainText, locale);
  sorted = finalizeNormalizedLlmBlocks(sorted, locale);

  const allowed = new Set(['captain', ...expectedCrew]);
  sorted = sorted.filter((b) => allowed.has(String(b.role || '').toLowerCase()));
  sorted = sortLlmBlocksByExpected(sorted, expectedCrew);
  sorted = applyForcedCaptainToSorted(sorted, forcedCaptainText, locale);
  sorted = finalizeNormalizedLlmBlocks(sorted, locale);

  const cap = sorted.find((b) => b.role === 'captain');
  if (!cap || !String(cap.text || '').trim()) return null;

  for (const r of expectedCrew) {
    const b = sorted.find((x) => x.role === r);
    if (!b || !String(b.text || '').trim()) return null;
  }

  if (locale === 'ko' && hasBannedCrewOrCaptainPatterns(sorted)) return null;

  const allTexts = [];
  for (const b of sorted) {
    allTexts.push(String(b.text || ''));
    if (b.narration) allTexts.push(String(b.narration));
  }
  if (!dialogueLanguageOk(allTexts, locale)) return null;
  if (hasExcessiveLineRepetition(sorted, 3)) return null;

  if (kind === 'QUESTION' && opts.targetedQuestionSideReactionRules && opts.target) {
    if (!targetedQuestionSideReactionBlocksOk(sorted, opts.target, locale)) {
      console.log('[bot] targeted_question side_reactions_question_like_filtered=true');
      return null;
    }
    if (opts.targetedNameQuestion) {
      if (!targetedNameQuestionNonTargetBlocksOk(sorted, opts.target, locale)) {
        console.log('[bot] targeted_name_question_non_target_filtered=true');
        return null;
      }
    }
  }
  return sorted;
}

/**
 * LLM이 text에 [함장] 등 헤더를 그대로 넣으면 llmBlocksToDisplayLogs가 헤더+text로 이중 출력된다. 헤더 한 번만 남긴다.
 */
function stripDuplicateRoleHeaderFromText(text, header) {
  let s = String(text || '').trim();
  const h = String(header || '').trim();
  if (!h || !s) return s;
  if (s.startsWith(h)) return s.slice(h.length).trim();
  return s;
}

/** targeted_question: 유저 입력 앞의 [함장]/[Captain]만 제거해 표시·강제 대사 본문으로 쓴다 */
function stripLeadingCaptainBracketFromUserLine(text, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  let s = String(text || '').trim();
  const capH = captainHeader(loc);
  if (s.startsWith(capH)) {
    s = s.slice(capH.length).trim();
    if (s.startsWith(',')) s = s.slice(1).trim();
  }
  return s;
}

/** miniapp targeted_question: 비타깃 크루가 질문/제3자 심문형이면 LLM 응답 폐기 */
function targetedQuestionSideReactionBlocksOk(sorted, focusTarget, locale) {
  const focus = String(focusTarget || '').toLowerCase();
  const loc = locale === 'en' ? 'en' : 'ko';
  const koRoleComma = /^(닥터|엔지니어|네비게이터|파일럿)\s*,/;
  const enRoleComma = /^(Doctor|Engineer|Navigator|Pilot)\s*,/i;
  for (const b of sorted) {
    const r = String(b.role || '').toLowerCase();
    if (r === 'captain' || r === focus) continue;
    const pack = `${String(b.text || '').trim()}\n${String(b.narration || '').trim()}`.trim();
    if (!pack) continue;
    if (/[?？]/.test(pack)) return false;
    if (loc === 'ko' && koRoleComma.test(pack)) return false;
    if (loc === 'en' && enRoleComma.test(pack)) return false;
  }
  return true;
}

/** 특정 역할 이름·호출명 질문(타깃이 직접 답해야 함). */
function isTargetedRoleNameQuestion(raw) {
  const t = String(raw || '').trim();
  if (!t) return false;
  return /(이름|이름이|이름은|무엇이라\s*불|뭐라고\s*불|호출명|call\s*sign|your\s+name|what\s+is\s+.+\s+name|name\s+of\s+the)/i.test(
    t
  );
}

function focusRoleAliasesKo(focus) {
  const m = {
    doctor: ['닥터', '의사'],
    engineer: ['엔지니어', '기술자'],
    navigator: ['네비게이터', '항해사'],
    pilot: ['파일럿', '조종사']
  };
  return m[String(focus || '').toLowerCase()] || [];
}

/** 이름 질문: 비타깃이 대상 역할의 이름·성함·호출을 대신 말하면 LLM 응답 폐기 */
function targetedNameQuestionNonTargetBlocksOk(sorted, focusTarget, locale) {
  const focus = String(focusTarget || '').toLowerCase();
  const loc = locale === 'en' ? 'en' : 'ko';
  const focusEn = roleNameEn(focus);
  for (const b of sorted) {
    const r = String(b.role || '').toLowerCase();
    if (r === 'captain' || r === focus) continue;
    const pack = `${String(b.text || '').trim()}\n${String(b.narration || '').trim()}`.trim();
    if (!pack) continue;
    if (loc === 'ko') {
      for (const al of focusRoleAliasesKo(focus)) {
        const esc = al.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (
          new RegExp(`${esc}[^\\n]{0,32}(이름|성함|호출명|이라고 부르|라고 부른다|라고 한다|라고 부르)`, 'i').test(
            pack
          )
        ) {
          return false;
        }
      }
    } else {
      if (focusEn && new RegExp(`\\b${focusEn}(?:'s)?\\s+name\\s+is\\b`, 'i').test(pack)) return false;
      if (focusEn && new RegExp(`\\b${focusEn}\\s+is\\s+(called|named)\\b`, 'i').test(pack)) return false;
    }
  }
  return true;
}

function takeFirstCaptainSegmentLength(logs, locale) {
  const capH = captainHeader(locale === 'en' ? 'en' : 'ko');
  if (!logs || !logs.length) return 0;
  const t0 = String(logs[0]?.type || '').trim();
  if (t0 === capH) {
    if (logs.length >= 2) {
      const t1 = String(logs[1]?.type || '').trim();
      if (t1 && !/^\[[^\]]+\]$/.test(t1)) return 2;
    }
    return 1;
  }
  if (t0.startsWith(capH) && t0.length > capH.length && !/^\[[^\]]+\]$/.test(t0)) return 1;
  return 0;
}

/**
 * 유저 함장 질문 본문을 표시 로그 앞에 [함장]+body 한 번만 고정 (targeted_question·role_opinion_question 등).
 * 선행 함장 블록이 있으면 제거 후 주입.
 */
function applyTargetedQuestionCaptainDisplayBody(displayLogs, captainBodyRaw, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const capH = captainHeader(loc);
  let body = stripDuplicateRoleHeaderFromText(String(captainBodyRaw || '').trim(), capH);
  body = String(body || '').trim();
  if (!body) return displayLogs;
  const logs = Array.isArray(displayLogs) ? displayLogs.slice() : [];
  const n = takeFirstCaptainSegmentLength(logs, loc);
  const rest = n > 0 ? logs.slice(n) : logs;
  const prefix = [
    { type: capH, role: 'system', target: null, _key: 'tq-cap-h' },
    { type: body, role: 'system', target: null, _key: 'tq-cap-b' }
  ];
  return normalizePlayerFacingDisplayLogs([...prefix, ...rest], loc);
}

/**
 * [함장][본문][함장][동일 본문] 연속이면 앞 한 쌍만 유지 (targeted_question 대사 중복 방지).
 */
function collapseDuplicateCaptainBlocks(displayLogs, locale) {
  const capH = captainHeader(locale === 'en' ? 'en' : 'ko');
  const logs = Array.isArray(displayLogs) ? displayLogs : [];
  if (logs.length < 4) return logs;
  const out = [];
  let i = 0;
  while (i < logs.length) {
    const a = logs[i];
    const b = logs[i + 1];
    const c = logs[i + 2];
    const d = logs[i + 3];
    const ta = String(a?.type || '').trim();
    const tb = String(b?.type || '').trim();
    const tc = String(c?.type || '').trim();
    const td = String(d?.type || '').trim();
    if (ta === capH && tc === capH && tb && td && tb === td) {
      out.push(a, b);
      i += 4;
      continue;
    }
    out.push(a);
    i++;
  }
  return out;
}

/**
 * targeted_question만: 첫 줄이 "[함장] …질문" 한 줄(type)이고, 이어서 동일 질문이 [함장]+본문 두 줄로 또 나오면
 * (정규화/LLM 경로가 합친 줄 + 분리 줄을 동시에 남긴 경우) 분리 쌍을 제거하고 합친 한 줄만 남긴다.
 */
function dedupeTargetedQuestionCaptainDisplayLogs(displayLogs, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const capH = captainHeader(loc);
  const logs = Array.isArray(displayLogs) ? displayLogs : [];
  if (logs.length < 3) return logs;

  const t0 = String(logs[0]?.type || '').trim();
  const t1 = String(logs[1]?.type || '').trim();
  const t2 = String(logs[2]?.type || '').trim();
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  if (!t0.startsWith(capH) || t1 !== capH || !t2) return logs;
  const restCombined = norm(t0.slice(capH.length));
  if (!restCombined) return logs;
  if (restCombined !== norm(t2)) return logs;

  return [logs[0], ...logs.slice(3)];
}

function llmBlocksToDisplayLogs(sortedBlocks, batchKey, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const out = [];
  let i = 0;
  for (const b of sortedBlocks) {
    const header = canonicalHeaderForLlmBlock(b, loc);
    const text = stripDuplicateRoleHeaderFromText(String(b.text || '').trim(), header);
    const narr = b.narration != null ? String(b.narration).trim() : '';
    const keyBase = `${batchKey}|${i++}`;
    if (header) out.push({ type: header, role: 'system', target: null, _key: `${keyBase}|h` });
    if (text) out.push({ type: text, role: 'system', target: null, _key: `${keyBase}|t` });
    if (narr) out.push({ type: narr, role: 'system', target: null, _key: `${keyBase}|n` });
  }
  return normalizePlayerFacingDisplayLogs(out, loc);
}

/** FIND_CLUE: 단서 본문은 엔진 값만 사용 (LLM이 사실 조작 불가) */
function mergeFindClueDeterministicClue(displayLogs, clueText, batchKey, locale, clueIdOpt) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const sysH = systemHeader(loc);
  const clue = localizeClueSystemLineForDisplay(loc, clueIdOpt, clueText, true);
  if (!clue) return displayLogs;
  const filtered = (displayLogs || []).filter((item) => {
    const t = String(item.type || '').trim();
    return t !== '[시스템]' && t !== '[System]';
  });
  const k = `${batchKey}|engine-clue`;
  return normalizePlayerFacingDisplayLogs(
    [
      ...filtered,
      { type: sysH, role: 'system', target: null, _key: `${k}|h` },
      { type: clue, role: 'system', target: null, _key: `${k}|b` }
    ],
    loc
  );
}

function buildDialogueSystemPrompt(kind, locale, promptOpts) {
  promptOpts = promptOpts || {};
  const loc = locale === 'en' ? 'en' : 'ko';

  if (loc === 'en') {
    const jsonContractEn = [
      'USSC Tartarus E1. Natural English dialogue and summary only — absolutely NO Korean (no Hangul).',
      'Output JSON only: {"blocks":[...]} — no markdown.',
      'Block: {"role","text","narration?"}. UI headers are [Captain] [Doctor] [Engineer] [Navigator] [Pilot] [System].',
      'Never decide rules, deaths, clue facts, timers, or impostor.',
      'captain.text = captainSpokenLineVerbatim exactly when user JSON provides it; captain.narration always "".',
      'Forbidden: empty reassurance, generic teamwork sermons, calm-down platitudes, moralizing.'
    ];

    if (kind === 'QUESTION') {
      const qEn = [
        ...jsonContractEn,
        'ROLE FIELD: each block.role MUST be captain|doctor|engineer|navigator|pilot (lowercase) only.',
        'Each block: {"role","text","narration?"} — no "header" key.',
        'BLOCK ORDER: blocks[0]=captain; blocks[1]=focusTargetRole (answers first); then remaining alive crew in crewSpeakingOrder.',
        'QUESTION: Target answers immediately — short, direct. Others: one tight reaction each.',
        promptOpts.targetedNameQuestion
          ? 'NAME_TARGETING non-target: brief reaction only; do not name the target\'s personal name. focusTargetEnglish in non-target lines is optional.'
          : 'Every non-target crew block must name focusTargetEnglish (e.g. Navigator) in text or narration.'
      ];
      if (promptOpts.targetedQuestionSideReactionRules) {
        qEn.push(
          'TARGETED_QUESTION (captain free-text): Non-target crew must NOT use question marks. Do NOT address Doctor/Engineer/Navigator/Pilot by name with a comma to open a new interrogation or ask what someone else did. Short observational reactions only (e.g. "Noted — I will cross-check that against the corridor log.").',
          'Do NOT rewrite captain.text into a different question; copy captainSpokenLineVerbatim only.'
        );
      }
      if (promptOpts.targetedNameQuestion) {
        qEn.push(
          'NAME_TARGETING: Only focusTargetRole states their name/callsign/identity. Non-target: one short reaction only — do NOT state, guess, or repeat the target\'s name. Forbidden: "The Doctor\'s name is...", "He is called...", "Her name is..." about the target.',
          'Non-target lines must not answer the name question on behalf of the target.'
        );
      }
      qEn.push('Respond JSON only.');
      return qEn.join('\n');
    }

    if (kind === 'LORE_QUESTION') {
      return [
        ...jsonContractEn,
        'ROLE FIELD: captain|doctor|engineer|navigator|pilot only.',
        'BLOCK ORDER: blocks[0]=captain; then doctor, engineer, navigator, pilot (omit dead).',
        'LORE_QUESTION: Answer using ONLY USSC Tartarus canon. Keywords to honor: HADES, AXIS, Project HORIZON, phase shock, Neptune orbit, gravity-drive experiment, awakened crew, missing experimental ship, nested entity.',
        'HADES axis: unauthorized sealed layer inside AXIS; awakened after Project HORIZON phase shock; bound to one awakened crew member; may optimize survival through murder or extreme actions.',
        'AXIS axis: official ship AI + official ship system layer. HADES is a hidden unauthorized layer sealed inside AXIS—when the topic is AXIS, EVERY crew block must include at least one sentence stating HADES is inside / sealed within AXIS.',
        'Doctor: biometrics / infection / vitals. Engineer: system core / AI layers / logs. Navigator: routes / phase shock / chart anomalies. Pilot: bridge feel / controls—same facts, different lens.',
        'Do NOT invent generic sci-fi meanings for HADES or AXIS. FORBIDDEN: "health monitoring system", "life support manager", "hazard routing protocol", "backup navigation system", "medical protocol" as definitions of HADES.',
        'Do NOT invent alternate meanings for HADES, AXIS, or Project HORIZON. Do NOT use the suspicion-roundabout template.',
        'captain.text must equal captainSpokenLineVerbatim exactly; captain.narration "".',
        'Respond JSON only.'
      ].join('\n');
    }

    if (kind === 'CHECK_LOG') {
      return [
        ...jsonContractEn,
        'ROLE FIELD: captain|doctor|engineer|navigator|pilot only.',
        'BLOCK ORDER: blocks[0]=captain; blocks[1]=engineer; then doctor, navigator, pilot (omit dead).',
        'CHECK_LOG: Engineer leads with logs/access/timestamp mismatch/gap/unauthorized-query — audit-narrow.',
        'doctor: biometrics/stress-log only as auxiliary. navigator: route/alibi auxiliary. pilot: mood/gut auxiliary.',
        'Stay on audit facts; no unrelated small talk.',
        'Respond JSON only.'
      ].join('\n');
    }

    if (kind === 'TAKE_PISTOL') {
      return [
        ...jsonContractEn,
        'ROLE FIELD: captain|doctor|engineer|navigator|pilot only.',
        'BLOCK ORDER: blocks[0]=captain; then doctor, engineer, navigator, pilot (omit dead).',
        'TAKE_PISTOL: Captain is armed with the sidearm. Crew react to that — never echo or copy captain.text.',
        'doctor: tension/vitals/stress. engineer: locks, access audit, security logs. navigator: corridors, readiness. pilot: bridge atmosphere.',
        'Respond JSON only.'
      ].join('\n');
    }

    const tailEn = [
      'Concrete ship facts only (zones, logs, biometrics, routes, cockpit).',
      'Roles: doctor biometrics; engineer logs/access; navigator routes/alibi; pilot cockpit feel.',
      'At most one short optional narration per crew; no duplicate stock narration.'
    ];
    if (kind === 'FIND_CLUE') {
      tailEn.push('FIND_CLUE: crew reactions only; never put clue body in JSON (server adds [System]).');
    } else if (kind === 'THREATEN') {
      tailEn.push(
        'THREATEN: threatened crew never echoes captain.text — wholly different sentence; reaction to pressure only.'
      );
      tailEn.push('Non-target crew blocks must name focusTargetEnglish in text or narration.');
    } else {
      tailEn.push('SUSPECT: every non-target crew block names focusTargetEnglish in text or narration.');
    }
    tailEn.push('Respond JSON only.');
    return [...jsonContractEn, ...tailEn].join('\n');
  }

  const jsonContract = [
    'USSC Tartarus E1. Korean spoken lines. Output JSON only: {"blocks":[...]} — no markdown.',
    'Block: {"role","header","text","narration?"}. Headers exactly: [함장] [닥터] [엔지니어] [네비게이터] [파일럿].',
    'Never decide rules, deaths, clue facts, timers, or impostor.',
    'captain.text = captainSpokenLineVerbatim exactly when user JSON provides it; captain.narration always "".',
    'Forbidden: 모두 진정, 신중해야, 침착하게, 우리는 함께, 훈계, 교훈, 빈 위로, 범용 팀워크 멘트.'
  ];

  if (kind === 'QUESTION') {
    const qKo = [
      'USSC Tartarus E1. Korean spoken lines. Output JSON only: {"blocks":[...]} — no markdown.',
      'ROLE FIELD (required): each block.role MUST be exactly one of: captain, doctor, engineer, navigator, pilot — lowercase English only.',
      'NEVER set role to "header", "system", "title", "speaker", or any other string.',
      'Each block shape ONLY: {"role":"captain|doctor|engineer|navigator|pilot","text":"...","narration":"..."} — narration optional. Do NOT include a "header" key; the client adds [함장] etc.',
      'BLOCK ORDER: blocks[0] = captain; blocks[1] = focusTargetRole (the questioned crew answers here); then blocks for the remaining three alive crew in crewSpeakingOrder (one block per role).',
      'Never decide rules, deaths, clue facts, timers, or impostor.',
      'captain.text = captainSpokenLineVerbatim exactly when user JSON provides it; captain.narration always "".',
      'Forbidden: 모두 진정, 신중해야, 침착하게, 우리는 함께, 훈계, 교훈, 빈 위로, 범용 팀워크 멘트.',
      'QUESTION: Target answers immediately in their block — short, direct, no essay.',
      'doctor/engineer/navigator/pilot: each one brief follow-up (1–2 short sentences) tied to that question only.',
      promptOpts.targetedNameQuestion
        ? 'NAME_TARGETING 비타깃: 짧은 반응만(대상 이름·성함 금지). focusTargetKorean 표기는 생략 가능.'
        : 'Every non-target crew block must include focusTargetKorean (e.g. 네비게이터) in text or narration.',
      'Optional one short narration per crew; skip if unnecessary. No generic life advice.'
    ];
    if (promptOpts.targetedQuestionSideReactionRules) {
      qKo.push(
        'TARGETED_QUESTION(자유입력): 비타깃 크루는 짧은 관찰·코멘트만 — 물음표(?) 금지, "닥터/엔지니어/네비게이터/파일럿, …" 형태로 제3자에게 새 질문·심문 금지.',
        'captain.text는 captainSpokenLineVerbatim과 동일하게만 — 내부 고정 질문 문장으로 바꾸지 말 것.'
      );
    }
    if (promptOpts.targetedNameQuestion) {
      qKo.push(
        'NAME_TARGETING: 이름·호출명·자기소개는 focusTargetRole 블록만 답한다. 비타깃은 한 줄 짧은 반응만 — 대상의 이름·성함·호출명을 대신 말하거나 반복하지 말 것. "닥터 이름은 …" 같은 제3자 서술 금지.',
        '비타깃은 focusTargetKorean을 꼭 넣지 않아도 됨(이름을 말하게 될 때는 생략).'
      );
    }
    qKo.push('Respond JSON only.');
    return qKo.join('\n');
  }

  if (kind === 'LORE_QUESTION') {
    return [
      'USSC Tartarus E1. Korean spoken lines. Output JSON only: {"blocks":[...]} — no markdown.',
      'ROLE FIELD (required): each block.role MUST be exactly one of: captain, doctor, engineer, navigator, pilot — lowercase English only.',
      'NEVER set role to "header", "system", "title", "speaker", or any other string.',
      'Each block shape ONLY: {"role":"captain|doctor|engineer|navigator|pilot","text":"...","narration":"..."} — narration optional. Do NOT include a "header" key; the client adds [함장] etc.',
      'BLOCK ORDER: blocks[0] = captain; 그다음 doctor, engineer, navigator, pilot (사망 역할 제외).',
      'LORE_QUESTION: USSC Tartarus 정식 세계관만 사용. 키워드: HADES, AXIS, 프로젝트 HORIZON, phase shock, 해왕성 궤도, 중력 드라이브 실험, 기상 승무원, 실종 실험선, 중첩체.',
      'HADES 축: AXIS 내부 봉인 비인가 레이어; 프로젝트 HORIZON phase shock 이후 깨어남; 한 승무원에 결속; 생존 최적화를 위해 살인 시도 가능.',
      'AXIS 축: 함선 AI·공식 시스템; HADES는 그 안에 숨겨진 층—의료 프로토콜·일반 백업 시스템으로 치환 금지. AXIS 질문이면 각 크루 블록에 HADES가 AXIS 내부에 봉인된 레이어라는 사실을 최소 1문장 포함.',
      '닥터: 생체·감염·바이탈. 엔지니어: 코어·AI 계층·로그. 네비게이터: 항로·phase shock·좌표 이상. 파일럿: 체감·브리지·조종. 사실은 공유, 관점만 다름.',
      '금지: "medical protocol", "backup navigation", health monitoring, life support manager, hazard routing 등으로 HADES/AXIS/HORIZON을 대체하지 말 것. 임의로 다른 의미를 만들지 말 것.',
      '질문 실체에 답할 것. 브리핑·임포 지목 템플릿 금지.',
      'captain.text는 captainSpokenLineVerbatim과 문자 단위로 동일; captain.narration은 항상 "".',
      'Forbidden: 모두 진정, 신중해야, 침착하게, 우리는 함께, 훈계, 교훈, 빈 위로, 범용 팀워크 멘트.',
      'Respond JSON only.'
    ].join('\n');
  }

  if (kind === 'CHECK_LOG') {
    return [
      'USSC Tartarus E1. Korean spoken lines. Output JSON only: {"blocks":[...]} — no markdown.',
      'ROLE FIELD (required): each block.role MUST be exactly one of: captain, doctor, engineer, navigator, pilot — lowercase English only.',
      'NEVER set role to "header", "system", "title", "speaker", or any other string.',
      'Each block shape ONLY: {"role":"captain|doctor|engineer|navigator|pilot","text":"...","narration":"..."} — narration optional. Do NOT include a "header" key; the client adds [함장] etc.',
      'BLOCK ORDER: blocks[0] = captain; blocks[1] = engineer; then doctor, navigator, pilot (omit dead roles; one block per alive role).',
      'Never decide rules, deaths, clue facts, timers, or impostor.',
      'captain.text = captainSpokenLineVerbatim exactly when user JSON provides it; captain.narration always "".',
      'Forbidden: 모두 진정, 신중해야, 침착하게, 우리는 함께, 훈계, 교훈, 빈 위로, 범용 팀워크 멘트.',
      'CHECK_LOG: Engineer block (second) opens with logs/access trail/timestamp mismatch/gap/unauthorized-query trace — audit-narrow, no sermon.',
      'doctor: only auxiliary biometrics/stress-log spike observation. navigator: route/alibi auxiliary only. pilot: mood/gut auxiliary only.',
      'Stay on: log gaps, access records, timestamp skew, privilege/query anomalies. No unrelated small talk or widening the mystery.',
      'Respond JSON only.'
    ].join('\n');
  }

  if (kind === 'TAKE_PISTOL') {
    return [
      'USSC Tartarus E1. Korean spoken lines. Output JSON only: {"blocks":[...]} — no markdown.',
      'ROLE FIELD (required): each block.role MUST be exactly one of: captain, doctor, engineer, navigator, pilot — lowercase English only.',
      'NEVER set role to "header", "system", "title", "speaker", or any other string.',
      'Each block shape ONLY: {"role":"captain|doctor|engineer|navigator|pilot","text":"...","narration":"..."} — narration optional. Do NOT include a "header" key; the client adds [함장] etc.',
      'BLOCK ORDER: blocks[0] = captain; then doctor, engineer, navigator, pilot (omit dead roles; one block per alive crew).',
      'Never decide rules, deaths, clue facts, timers, or impostor.',
      'captain.text = captainSpokenLineVerbatim exactly when user JSON provides it; captain.narration always "".',
      'Forbidden: 모두 진정, 신중해야, 침착하게, 우리는 함께, 훈계, 교훈, 빈 위로, 범용 팀워크 멘트.',
      'TAKE_PISTOL: The captain has armed with the sidearm. React only to that fact — never repeat, echo, or copy captain.text (e.g. do not reuse "권총을 집었다" or the captain\'s exact wording).',
      'doctor: tension from the captain being armed; psychophys / vitals / breath or stress shift — concrete, brief.',
      'engineer: weapon lock release, privilege/access audit trail, security or system-log angle — not the captain\'s line parroted.',
      'navigator: rising tension; corridors, boundaries, immediate readiness — situational.',
      'pilot: bridge atmosphere, gut unease, how the air in the room changes.',
      'No generic advice or empty reassurance. Respond JSON only.'
    ].join('\n');
  }

  const tail = [
    'Concrete ship facts only (zones, logs, biometrics, routes, cockpit).',
    'Roles: doctor biometrics; engineer logs/access/sync; navigator routes/alibi; pilot cockpit feel.',
    'At most one short optional narration per crew; no duplicate stock narration.'
  ];
  if (kind === 'FIND_CLUE') {
    tail.push('FIND_CLUE: crew reactions only; never put clue body in JSON (server adds [시스템]).');
  } else if (kind === 'THREATEN') {
    tail.push(
      'THREATEN: focusTargetRole (threatened crew) must NEVER repeat, echo, or copy captain.text — write a wholly different sentence.'
    );
    tail.push(
      'Target block only: their own reaction to pressure (tension, defense, pushback, fear) in new words; do not quote or paraphrase the captain\'s threat as their line.'
    );
    tail.push('Non-target crew blocks must name focusTargetKorean in text or narration.');
  } else {
    tail.push('SUSPECT: every non-target crew block names focusTargetKorean in text or narration.');
  }
  tail.push('Respond JSON only.');
  return [...jsonContract, ...tail].join('\n');
}

function buildDialogueUserPayload(ctx) {
  const loc = ctx.locale === 'en' ? 'en' : 'ko';
  const cn = ctx.crewPersonalNames || null;
  const o = {
    action: ctx.kind,
    locale: loc,
    focusTargetRole: ctx.target || null,
    focusTargetKorean: loc === 'ko' ? ctx.targetKo || null : null,
    focusTargetEnglish: loc === 'en' ? ctx.targetEn || null : null,
    crewSpeakingOrder: ctx.expectedCrew,
    deadRoles: ctx.deadRoles || [],
    captainPlayerInput: ctx.playerText || '',
    captainSpokenLineVerbatim: ctx.captainSpokenLineVerbatim || null,
    clueTextToQuoteVerbatim: ctx.clueText || null,
    instructionCaptain: ctx.captainSpokenLineVerbatim
      ? 'captain.text exact copy of captainSpokenLineVerbatim; captain.narration "".'
      : 'captain.text short; captain.narration "".',
    crewPersonalNames: cn,
    crewNameInstruction:
      cn && typeof cn === 'object'
        ? loc === 'en'
          ? 'Use these exact personal names for each role when introducing or naming: doctor=' +
            (cn.doctor?.en || cn.doctor) +
            ', engineer=' +
            (cn.engineer?.en || cn.engineer) +
            ', navigator=' +
            (cn.navigator?.en || cn.navigator) +
            ', pilot=' +
            (cn.pilot?.en || cn.pilot) +
            '. Do not invent different names.'
          : '각 역할의 실명은 반드시 다음만 사용: doctor=' +
            (cn.doctor?.ko || cn.doctor) +
            ', engineer=' +
            (cn.engineer?.ko || cn.engineer) +
            ', navigator=' +
            (cn.navigator?.ko || cn.navigator) +
            ', pilot=' +
            (cn.pilot?.ko || cn.pilot) +
            '. 다른 이름을 만들지 말 것.'
        : null
  };
  if (ctx.kind === 'QUESTION') {
    o.pacing = 'Short lines; target answers first; others one tight reaction each.';
    o.blocksOrder =
      'blocks[0]=captain, blocks[1]=focusTargetRole, then other crew in crewSpeakingOrder; role must be captain|doctor|engineer|navigator|pilot only.';
  } else if (ctx.kind === 'LORE_QUESTION') {
    o.pacing =
      'Short lines; captain verbatim question; each alive crew answers the lore question from role lens—no suspicion template.';
    o.blocksOrder =
      'blocks[0]=captain, then doctor, engineer, navigator, pilot (omit dead); role must be captain|doctor|engineer|navigator|pilot only.';
    o.loreQuestionTopic = ctx.loreQuestionTopic || 'general';
    o.worldCanonAnchor = ctx.loreCanonAnchorText || '';
    o.outputLanguage =
      loc === 'en'
        ? 'All crew lines must be English only (match captain language).'
        : '모든 크루 대사는 한국어만 (함장 질문 언어와 일치).';
  } else if (ctx.kind === 'CHECK_LOG') {
    o.auditFocus = 'Engineer-first; narrow audit: gaps, access, timestamps, stray queries.';
    o.blocksOrder =
      'blocks[0]=captain, blocks[1]=engineer, then doctor, navigator, pilot (omit dead); role must be captain|doctor|engineer|navigator|pilot only.';
  } else if (ctx.kind === 'TAKE_PISTOL') {
    o.situation = 'Captain has taken / armed with the sidearm on the ship.';
    o.blocksOrder =
      'blocks[0]=captain, then doctor, engineer, navigator, pilot (omit dead); role must be captain|doctor|engineer|navigator|pilot only.';
    o.pacing = 'Short lines; each crew one tight reaction to the captain being armed; no echo of captain.text.';
  }
  if (ctx.clueText != null) {
    o.note =
      loc === 'en'
        ? 'FIND_CLUE: no clue text in JSON; server injects [System].'
        : 'FIND_CLUE: no clue text in JSON; server injects [시스템].';
  }
  return JSON.stringify(o, null, 0);
}

async function callChatCompletionsJson({ system, user, timeoutMs, maxTokens }) {
  const model = TELEGRAM_DIALOGUE_MODEL;
  const useDeepSeek = isDeepSeekDialogueModel(model);
  const apiKey = useDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('no_api_key');

  const timeout =
    timeoutMs != null && Number.isFinite(timeoutMs)
      ? Math.min(Math.max(timeoutMs, 4000), 60000)
      : TELEGRAM_DIALOGUE_TIMEOUT_MS;

  const client = new OpenAI({
    apiKey,
    baseURL: useDeepSeek ? DEEPSEEK_BASE_URL : undefined,
    timeout,
    maxRetries: 0
  });

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.42,
    max_tokens: maxTokens != null && Number.isFinite(maxTokens) ? Math.max(256, maxTokens) : 2500
  };
  if (!useDeepSeek) {
    body.response_format = { type: 'json_object' };
  }

  const completion = await client.chat.completions.create(body);
  const content = completion?.choices?.[0]?.message?.content;
  return content != null ? String(content) : '';
}

/**
 * @returns {Promise<object[]|null>} display log rows or null → caller uses deterministic
 */
async function tryGenerateLlmDialogueLogs(ctx) {
  if (!isDialogueLlmConfigured()) return null;
  const {
    kind,
    rawEvents,
    match,
    playerText,
    clueText,
    forcedCaptainText,
    targetedQuestionSideReactionRules,
    targetedNameQuestion,
    loreQuestionTopic: loreTopicOpt,
    loreCanonAnchorText: loreCanonOpt
  } = ctx;
  const locale = ctx.locale === 'en' ? 'en' : 'ko';
  if (match?.match_id) {
    await ensureCrewPersonalNamesPersisted(match.match_id);
  }
  const matchFresh = match?.match_id ? (await matchStore.getMatch(match.match_id)) || match : match;
  const gs = matchFresh?.game_state || match?.game_state || {};
  const deadRoles = gs.dead_roles || [];
  const ev0 = rawEvents && rawEvents[0];
  const target = ev0?.target ? String(ev0.target).toLowerCase() : null;
  const expectedCrew = expectedCrewOrderForLlm(kind, target, deadRoles, rawEvents);
  const batchKey = `llm|${kind}|${Date.now()}`;
  const captainForced = String(forcedCaptainText || '').trim();

  const loreTopic =
    kind === 'LORE_QUESTION'
      ? loreTopicOpt || detectLoreQuestionTopic(playerText || '', locale)
      : null;
  const loreCanonSnippet =
    kind === 'LORE_QUESTION'
      ? loreCanonOpt != null && String(loreCanonOpt).trim()
        ? String(loreCanonOpt).trim()
        : getLoreTopicSnippet(loreTopic, locale)
      : '';

  let system = buildDialogueSystemPrompt(kind, locale, {
    targetedQuestionSideReactionRules,
    targetedNameQuestion: !!targetedNameQuestion
  });
  if (kind === 'LORE_QUESTION') {
    system += '\n\n' + getLoreCanonSystemExtension(locale);
  }
  const crewPersonalNames = gs.crew_names || {};
  if (kind === 'QUESTION' && crewPersonalNames && crewPersonalNames.doctor) {
    system +=
      locale === 'en'
        ? '\n\nCREW_TO_CAPTAIN: Doctor/Engineer/Navigator/Pilot always address the Captain respectfully (formal, no casual slang toward the Captain). For name questions: give the personal name from crewPersonalNames first; at most one short role sentence after the name. Do not answer with role-only intros instead of the name.'
        : '\n\nCREW_TO_CAPTAIN: 닥터·엔지니어·네비게이터·파일럿은 함장에게 항상 존댓말만 사용합니다(함장이 반말이어도 유지). 이름 질문에는 crewPersonalNames의 실명을 먼저 말하고, 역할 설명은 이름 뒤 1문장만. 역할만 말하고 이름을 끝까지 말하지 않는 것(역할 소개만)은 금지. 금지 예: 부르게, 내 구역이다, 내 쪽이다, 말하지(반말).';
    if (targetedNameQuestion) {
      system +=
        locale === 'en'
          ? ' NAME_REASK: Only focusTargetRole states their personal name; non-targets must not give that name or repeat it.'
          : ' NAME_REASK: 실명·성함은 focusTargetRole 블록만. 비타깃은 대상의 이름을 말하거나 추측하지 말 것.';
    }
  }
  const userBase = buildDialogueUserPayload({
    kind,
    target,
    targetKo: roleNameKo(target),
    targetEn: roleNameEn(target),
    locale,
    expectedCrew,
    deadRoles,
    playerText: playerText || '',
    clueText: kind === 'FIND_CLUE' ? clueText : null,
    captainSpokenLineVerbatim: captainForced || null,
    loreQuestionTopic: kind === 'LORE_QUESTION' ? loreTopic : undefined,
    loreCanonAnchorText: kind === 'LORE_QUESTION' ? loreCanonSnippet : undefined,
    crewPersonalNames
  });
  let strictRetry =
    locale === 'en'
      ? '\n\n[STRICT_RETRY] Validation failed. No Korean. No platitudes. Short lines; no repetition. roles: captain|doctor|engineer|navigator|pilot only; no header key.'
      : '\n\n[STRICT_RETRY] 검증 실패. 금지: 진정/신중/침착/함께/훈계/교훈. narration 짧게·반복 금지.';
  if (locale === 'ko') {
    if (kind === 'QUESTION' && !targetedNameQuestion) {
      strictRetry +=
        ' QUESTION: 비타깃 블록에 focusTargetKorean 필수. 더 짧게. role은 captain|doctor|engineer|navigator|pilot 만; header 금지.';
    } else if (kind === 'QUESTION' && targetedNameQuestion) {
      strictRetry +=
        ' QUESTION: 이름 질문—포커스 역할만 실명 중심. 비타깃은 짧은 반응만, 대상 이름 금지. 존댓말 유지. role은 captain|doctor|engineer|navigator|pilot 만; header 금지.';
    } else if (kind === 'CHECK_LOG') {
      strictRetry +=
        ' CHECK_LOG: 엔지니어 중심 로그/접근/타임스탬프 불일치만. role은 captain|doctor|engineer|navigator|pilot 만; header 금지.';
    } else if (kind === 'THREATEN') {
      strictRetry +=
        ' THREATEN: 타깃 블록은 함장 문장 복창·인용 금지; 압박에 대한 본인 반응만. 비타깃에 focusTargetKorean.';
    } else if (kind === 'SUSPECT') {
      strictRetry += ' 비타깃에 focusTargetKorean.';
    } else if (kind === 'FIND_CLUE') {
      strictRetry += ' FIND_CLUE: 단서 본문 금지.';
    } else if (kind === 'TAKE_PISTOL') {
      strictRetry +=
        ' TAKE_PISTOL: 함장 문장·권총 집기 문구 복창·인용 금지. 역할별 짧은 반응만. role은 captain|doctor|engineer|navigator|pilot 만; header 금지.';
    } else if (kind === 'LORE_QUESTION') {
      strictRetry +=
        ' LORE_QUESTION: 타르타로스 canon만. health monitoring·life support manager·hazard routing·backup navigation·medical-protocol-as-HADES 금지. AXIS 질문이면 HADES가 AXIS 내부에 봉인됐다는 문장 필수. captain.text는 captainSpokenLineVerbatim과 동일만.';
    }
    if (targetedQuestionSideReactionRules && kind === 'QUESTION') {
      strictRetry +=
        ' 비타깃: 물음표·질문형 금지. 다른 역할 호명 심문 금지. 짧은 관찰만. captain.text는 제공 문장만.';
    }
    if (targetedNameQuestion && kind === 'QUESTION') {
      strictRetry +=
        ' NAME_TARGETING: 비타깃은 대상 이름·성함·호출명 금지. 포커스 역할만 이름 답.';
    }
  } else {
    if (kind === 'QUESTION' && !targetedNameQuestion) {
      strictRetry += ' QUESTION: non-target blocks must name focusTargetEnglish. Shorter.';
    } else if (kind === 'QUESTION' && targetedNameQuestion) {
      strictRetry +=
        ' QUESTION: name question—only focusTargetRole gives their personal name; non-target brief reaction only, no target name. Formal to Captain.';
    } else if (kind === 'CHECK_LOG') {
      strictRetry += ' CHECK_LOG: engineer-first audit lines only.';
    } else if (kind === 'THREATEN') {
      strictRetry += ' THREATEN: target never echoes captain; non-target names focusTargetEnglish.';
    } else if (kind === 'SUSPECT') {
      strictRetry += ' SUSPECT: non-target names focusTargetEnglish.';
    } else if (kind === 'FIND_CLUE') {
      strictRetry += ' FIND_CLUE: no clue body in JSON.';
    } else if (kind === 'TAKE_PISTOL') {
      strictRetry += ' TAKE_PISTOL: no echo of captain line.';
    } else if (kind === 'LORE_QUESTION') {
      strictRetry +=
        ' LORE_QUESTION: Tartarus canon only; forbid health monitoring system, life support manager, hazard routing protocol, backup navigation system, medical-protocol-as-HADES. AXIS answers must include HADES sealed inside AXIS. captain.text = captainSpokenLineVerbatim only.';
    }
    if (targetedQuestionSideReactionRules && kind === 'QUESTION') {
      strictRetry +=
        ' Non-target: no ?; no "RoleName," interrogation; brief observation only. captain.text = verbatim only.';
    }
    if (targetedNameQuestion && kind === 'QUESTION') {
      strictRetry +=
        ' NAME_TARGETING: non-target must NOT give the target\'s name or callsign; only focusTargetRole answers the name question.';
    }
  }

  const maxAttempts = dialogueMaxAttemptsForKind(kind);
  const timeoutMs = dialogueTimeoutMsForKind(kind);
  const maxTokens = kind === 'QUESTION' || kind === 'LORE_QUESTION' ? 1400 : undefined;

  let lastRaw = '';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const user = userBase + (attempt ? strictRetry : '');
    let raw;
    try {
      raw = await callChatCompletionsJson({ system, user, timeoutMs, maxTokens });
    } catch (err) {
      log('LLM_DIALOGUE', 'call_failed', { kind, attempt, err: String(err && err.message) });
      if ((kind === 'QUESTION' || kind === 'LORE_QUESTION') && attempt + 1 < maxAttempts) continue;
      return null;
    }
    lastRaw = raw;
    const parsed = extractJsonObjectFromLlmText(raw);
    const valid = validateLlmDialogueBlocks(parsed, kind, expectedCrew, {
      forcedCaptainText: captainForced,
      target,
      locale,
      targetedQuestionSideReactionRules: !!targetedQuestionSideReactionRules,
      targetedNameQuestion: !!targetedNameQuestion
    });
    if (valid) {
      console.log(
        '[bot] LLM_DIALOGUE normalized ' +
          JSON.stringify({ kind, roles: valid.map((b) => b.role) })
      );
      let logs = llmBlocksToDisplayLogs(valid, batchKey, locale);
      if (kind === 'FIND_CLUE' && clueText) {
        const clueIdOpt = ev0?.clue_id != null ? String(ev0.clue_id) : '';
        logs = mergeFindClueDeterministicClue(logs, clueText, batchKey, locale, clueIdOpt);
      }
      return logs.length ? logs : null;
    }
    log('LLM_DIALOGUE', 'validate_failed', { kind, attempt });
  }
  log('LLM_DIALOGUE', 'aborted_after_retry', { kind, rawHead: String(lastRaw).slice(0, 120) });
  return null;
}

function suspicionHeavyInPlayerText(playerText) {
  return /(의심|범인|거짓|처형|쏘지\s*말|총을|누가\s*범|임포|traitor|accuse|execute|shoot)/i.test(
    String(playerText || '')
  );
}

/** 함장이 특정 역할에게 “왜 당신이 아닌가” 류로 압박할 때 — 자기변호 톤 레이어. */
function isSelfDefenseQuestionContext(playerText) {
  return /(왜\s*당신|왜\s*아니|아닌가|왜\s*아닌|not\s*you|why\s*you|why\s*not|why\s*me)/i.test(
    String(playerText || '')
  );
}

/**
 * playerText + match 옵션으로 톤/하이브리드 라우팅용 문맥(기존 상태만 사용).
 * opts: remainingSec, deadRolesCount, gameOver
 */
function computeToneContext(playerText, opts) {
  opts = opts || {};
  const pt = String(playerText || '');
  const remainingSec = opts.remainingSec != null ? Number(opts.remainingSec) : null;
  const selfDefense = isSelfDefenseQuestionContext(pt);
  const suspicionHeavy = suspicionHeavyInPlayerText(pt);
  const suspicionWeak =
    /(의심|수상|이상|어색|awkward|strange|suspicious|뭔가|who\s*should|누구.*의심)/i.test(pt) &&
    !suspicionHeavy;
  const threat = /(권총|총|처형|위협|threat|shoot|execute|pistol|쏘|겨누|총구)/i.test(pt);
  const groupPressure =
    /(자네들|다들|모두|승무원들|승무원\s+중|전원|everyone|all\s+of\s+you)/i.test(pt) &&
    /(의심|범인|누가|말해|증언|alibi|where|why|왜|범인)/i.test(pt);
  const targetedAccusation =
    /(당신이|너는\s*범|you\s*(?:are|'re|’re)\s*the|why\s*you|왜\s*당신|pointing\s*at)/i.test(pt);
  const lateGame = remainingSec != null && remainingSec <= 120;
  const emotionPeak =
    !!(selfDefense && threat) || suspicionHeavy || (lateGame && (suspicionHeavy || suspicionWeak));
  const suspicion = suspicionHeavy || suspicionWeak || selfDefense;
  return {
    selfDefense,
    suspicionHeavy,
    suspicionWeak,
    suspicion,
    threat,
    groupPressure,
    targetedAccusation,
    lateGame,
    emotionPeak,
    deadRolesCount: opts.deadRolesCount != null ? Number(opts.deadRolesCount) : 0,
    gameOver: !!opts.gameOver
  };
}

function gatherHighIntensitySceneFlags(ctx) {
  const o = {};
  if (ctx.selfDefense) o.isSelfDefenseQuestion = true;
  if (ctx.groupPressure) o.isGroupPressure = true;
  if (ctx.lateGame) o.isLateGame = true;
  if (ctx.emotionPeak) o.isEmotionPeak = true;
  if (ctx.targetedAccusation) o.isTargetedAccusation = true;
  return o;
}

/** LLM/결정적 크루 대사에서 제네릭 문구를 역할 톤으로 치환(숨은 진실·범인 새 사실 없음). */
function rewriteCrewLineForTone(text, role, loc, toneCtx) {
  let s = String(text || '');
  let changed = false;
  let selfDefenseApplied = false;
  let genericRewritten = false;
  const r = String(role || '').toLowerCase();
  const suspicion = !!toneCtx.suspicion;
  const selfDefense = !!toneCtx.selfDefense;
  const threat = !!toneCtx.threat;
  const suspicionHeavy = !!toneCtx.suspicionHeavy;
  const suspicionWeak = !!toneCtx.suspicionWeak;
  const emotionPeak = !!toneCtx.emotionPeak;
  const targetedAccusation = !!toneCtx.targetedAccusation;
  const corneredMedical = selfDefense && threat && emotionPeak && r === 'doctor';

  function markGeneric() {
    genericRewritten = true;
  }

  if (loc === 'ko') {
    const byRole = {
      doctor: [
        [/흥미롭군요\.?/g, '생체·바이탈 기록을 더 대조해야 합니다.'],
        [/그\s*사실을\s*알고\s*있었어요\.?/g, '생체 로그에 흔적은 있었습니다.'],
        [/그\s*부분을\s*확인해야겠네요\.?/g, '바이탈·감염 지표를 더 봐야 합니다.']
      ],
      engineer: [
        [/흥미롭군요\.?/g, '접근 로그·타임스탬프를 더 맞춰봐야 합니다.'],
        [/그\s*사실을\s*알고\s*있었어요\.?/g, '시스템 로그엔 흔적이 있습니다.'],
        [/그\s*부분을\s*확인해야겠네요\.?/g, '코어·감사 로그를 더 까야 합니다.']
      ],
      navigator: [
        [/흥미롭군요\.?/g, '항로·차트와 동선을 같은 분에 겹쳐봐야 합니다.'],
        [/그\s*사실을\s*알고\s*있었어요\.?/g, '항해 기록엔 그 구간이 남아 있습니다.'],
        [/그\s*부분을\s*확인해야겠네요\.?/g, '경로·알리바이를 더 좁혀야 합니다.']
      ],
      pilot: [
        [/흥미롭군요\.?/g, '교량 쪽 공기·압력 느낌이 싸합니다.'],
        [/그\s*사실을\s*알고\s*있었어요\.?/g, '그때 현장 감각은 기억합니다.'],
        [/그\s*부분을\s*확인해야겠네요\.?/g, '계기·분위기를 더 짚어봐야 합니다.']
      ]
    };
    const list = byRole[r] || [];
    for (const [re, rep] of list) {
      if (re.test(s)) {
        s = s.replace(re, rep);
        changed = true;
      }
    }
    if (suspicionWeak && !suspicionHeavy && r !== 'captain') {
      const weakExtra = {
        doctor: [[/모르겠습니다\.?$/gm, '바이탈·기록을 더 대조한 뒤 말씀드리겠습니다.']],
        engineer: [[/모르겠습니다\.?$/gm, '접근 로그·타임스탬프를 더 맞춘 뒤 말씀드리겠습니다.']],
        navigator: [[/모르겠습니다\.?$/gm, '항로·차트와 동선을 더 겹친 뒤 말씀드리겠습니다.']],
        pilot: [[/모르겠습니다\.?$/gm, '계기·교량 감각을 더 짚은 뒤 말씀드리겠습니다.']]
      };
      const we = weakExtra[r];
      if (we) {
        for (const [re, rep] of we) {
          if (re.test(s)) {
            s = s.replace(re, rep);
            changed = true;
          }
        }
      }
    }
    if (r !== 'captain') {
      const banKo = [
        {
          re: /그럴\s*리가\s*없습니다\.?/g,
          rep: {
            doctor: threat
              ? '그건 오해입니다. 그 시각 의무실·복도에 있었습니다. 생존 압박 속에서도 생체·바이탈이 제 동선을 말합니다.'
              : targetedAccusation
                ? '그건 오해입니다. 의무 판단은 감정이 아니라 기록입니다. 성급히 저만 몰아붙이지 마십시오.'
                : suspicionHeavy
                  ? '그건 성급한 결론입니다. 바이탈·진료 기록으로 말하겠습니다.'
                  : '그건 성급합니다. 생체·기록을 더 대조해야 합니다.',
            engineer: threat
              ? '그건 오해입니다. 릴레이·접근 로그가 제 구역을 찍습니다. 감정보다 체크섬을 보십시오.'
              : targetedAccusation
                ? '그건 오해입니다. 시스템 감사 흐름상 제 자리가 맞습니다. 로그 없이 단정하지 마십시오.'
                : suspicionHeavy
                  ? '그건 성급한 결론입니다. 타임스탬프·감사 로그로 말하겠습니다.'
                  : '그건 성급합니다. 로그·체크섬을 더 맞춰야 합니다.',
            navigator: threat
              ? '그건 오해입니다. 차트·동선이 같은 분에 겹칩니다. 겨누기 전에 경로부터 맞추십시오.'
              : targetedAccusation
                ? '그건 오해입니다. 항해 기록과 제 진술이 같은 구간에 있습니다. 성급히 재단하지 마십시오.'
                : suspicionHeavy
                  ? '그건 성급한 결론입니다. 항로·알리바이로 말하겠습니다.'
                  : '그건 성급합니다. 차트와 시간대를 더 좁혀야 합니다.',
            pilot: threat
              ? '그건 오해입니다. 교량 계기·압력이 제 자리를 말합니다. 직감이 아니라 계기를 보십시오.'
              : targetedAccusation
                ? '그건 오해입니다. 현장 감각과 로그가 같은 방향입니다. 함부로 겨누지 마십시오.'
                : suspicionHeavy
                  ? '그건 성급한 결론입니다. 진동·소리·계기로 말하겠습니다.'
                  : '그건 성급합니다. 계기와 분위기를 더 짚어야 합니다.'
          }
        },
        {
          re: /그럴\s*가능성은\s*없습니다\.?/g,
          rep: {
            doctor: '의료 판단은 가능성 말고 생체·기록으로 합니다. 성급히 단정하지 마십시오.',
            engineer: '가능성 말고 타임스탬프·접근 기록으로 말하겠습니다.',
            navigator: '가능성 말고 차트·동선으로 말하겠습니다.',
            pilot: '가능성 말고 계기·현장 감각으로 말하겠습니다.'
          }
        }
      ];
      for (const row of banKo) {
        const reBan = new RegExp(row.re.source, row.re.flags);
        if (!reBan.test(s)) continue;
        const repBan = row.rep && row.rep[r] != null ? row.rep[r] : null;
        if (repBan == null) continue;
        s = s.replace(reBan, repBan);
        changed = true;
        markGeneric();
      }
    }
    if (selfDefense && r !== 'captain') {
      const sdDoctor = [
        [
          /저는\s*증거가\s*없습니다\.?/g,
          corneredMedical
            ? '그건 오해입니다. 그 시각 의무실·복도에 있었습니다. 생존 본능이 아니라 바이탈·생체 기록이 제 알리바이입니다.'
            : '의무실·기록 기준으로는 제 동선이 맞습니다. 성급히 죄목을 견지하지 마십시오.'
        ],
        [/의심스러운\s*행동을\s*하지\s*않았습니다\.?/g, '생체·진술 로그로 말하겠습니다. 흥분을 혼동하지 마십시오.'],
        [/항상\s*침착했습니다\.?/g, '그 시각 의무실·복도에 있었습니다. 총부터 들이대지 마십시오.'],
        [/저는\s*아무\s*잘못도\s*없습니다\.?/g, '의료 근거로만 말하겠습니다. 함부로 범인이라 단정하지 마십시오.']
      ];
      const sdEngineer = [
        [/저는\s*증거가\s*없습니다\.?/g, '접근 로그·릴레이 기준으로는 제 구역이 맞습니다. 성급히 몰아붙이지 마십시오.'],
        [/의심스러운\s*행동을\s*하지\s*않았습니다\.?/g, '타임스탬프로 말하겠습니다. 체크섬이 거짓말하지 않습니다.'],
        [/항상\s*침착했습니다\.?/g, '그 시각 코어 쪽에 있었습니다. 로그를 더 까보기 전에 단정하지 마십시오.']
      ];
      const sdNav = [
        [/저는\s*증거가\s*없습니다\.?/g, '항로·차트 기록과 제 진술은 같은 분에 겹칩니다. 성급히 재단하지 마십시오.'],
        [/의심스러운\s*행동을\s*하지\s*않았습니다\.?/g, '동선은 차트로 말합니다. 감으로 쏘지 마십시오.'],
        [/항상\s*침착했습니다\.?/g, '그 시각 차트실·교량 연계에 있었습니다. 알리바이부터 맞추십시오.']
      ];
      const sdPilot = [
        [/저는\s*증거가\s*없습니다\.?/g, '교량 계기·압력 로그가 제 자리를 말합니다. 함부로 겨누지 마십시오.'],
        [/의심스러운\s*행동을\s*하지\s*않았습니다\.?/g, '계기와 현장 감각으로 말하겠습니다. 성급한 처형만은 막아 주십시오.'],
        [/항상\s*침착했습니다\.?/g, '그 시각 조종대 앞이었습니다. 침착이 죄는 아닙니다.']
      ];
      const pick =
        r === 'doctor'
          ? sdDoctor
          : r === 'engineer'
            ? sdEngineer
            : r === 'navigator'
              ? sdNav
              : r === 'pilot'
                ? sdPilot
                : [];
      for (const [re, rep] of pick) {
        if (re.test(s)) {
          s = s.replace(re, rep);
          changed = true;
          selfDefenseApplied = true;
          markGeneric();
        }
      }
    }
    if (suspicion && r !== 'captain' && /^(그렇군요|알겠습니다|네\.|좋습니다)/.test(s.trim())) {
      let prefix = '';
      if (threat) {
        prefix =
          r === 'doctor'
            ? '지금은 감정이 아니라 생체·바이탈입니다. '
            : r === 'engineer'
              ? '지금은 감정이 아니라 로그·체크섬입니다. '
              : r === 'navigator'
                ? '지금은 감정이 아니라 동선·시간대입니다. '
                : '지금은 감정이 아니라 계기·압력입니다. ';
      } else if (suspicionHeavy) {
        prefix =
          r === 'doctor'
            ? '그건 오해입니다. 바이탈·기록으로 말하겠습니다. '
            : r === 'engineer'
              ? '그건 오해입니다. 로그·타임스탬프로 말하겠습니다. '
              : r === 'navigator'
                ? '그건 오해입니다. 항로·동선으로 말하겠습니다. '
                : '그건 오해입니다. 현장 감각으로 말하겠습니다. ';
      } else if (suspicionWeak) {
        prefix =
          r === 'doctor'
            ? '성급한 추측입니다. 바이탈·기록으로 말하겠습니다. '
            : r === 'engineer'
              ? '성급한 추측입니다. 로그·타임스탬프로 말하겠습니다. '
              : r === 'navigator'
                ? '성급한 추측입니다. 항로·동선으로 말하겠습니다. '
                : '성급한 추측입니다. 계기·분위기로 말하겠습니다. ';
      } else if (selfDefense) {
        prefix =
          r === 'doctor'
            ? '그건 오해입니다. 바이탈·기록으로 말하겠습니다. '
            : r === 'engineer'
              ? '그건 오해입니다. 로그·타임스탬프로 말하겠습니다. '
              : r === 'navigator'
                ? '그건 오해입니다. 항로·동선으로 말하겠습니다. '
                : '그건 오해입니다. 현장 감각으로 말하겠습니다. ';
      }
      if (prefix) {
        s = prefix + s;
        changed = true;
      }
    }
  } else {
    const byRoleEn = {
      doctor: [
        [/That'?s interesting\.?/gi, 'Vitals and biometrics need another look.'],
        [/I already knew that\.?/gi, 'The biometrics log already showed traces of that.'],
        [/I (should|need to) check that\.?/gi, 'I need to cross-check vitals and infection markers.']
      ],
      engineer: [
        [/That'?s interesting\.?/gi, 'Access logs and timestamps need another pass.'],
        [/I already knew that\.?/gi, 'The system audit trail already flags that window.'],
        [/I (should|need to) check that\.?/gi, 'I need to align core logs and access records.']
      ],
      navigator: [
        [/That'?s interesting\.?/gi, 'Route and chart slices need to line up for that minute.'],
        [/I already knew that\.?/gi, 'The chart already shows the mismatch.'],
        [/I (should|need to) check that\.?/gi, 'I need to tighten route versus alibi.']
      ],
      pilot: [
        [/That'?s interesting\.?/gi, 'The bridge air and pressure felt wrong there.'],
        [/I already knew that\.?/gi, 'I remember how the room felt on the bridge.'],
        [/I (should|need to) check that\.?/gi, 'I need to replay instruments and gut read together.']
      ]
    };
    const list = byRoleEn[r];
    if (list) {
      for (const [re, rep] of list) {
        if (re.test(s)) {
          s = s.replace(re, rep);
          changed = true;
        }
      }
    }
    if (suspicionWeak && !suspicionHeavy && r !== 'captain') {
      const weakEn = {
        doctor: [[/I\s+don'?t\s+know\.?$/gim, 'I need another pass on vitals and charts before I answer.']],
        engineer: [[/I\s+don'?t\s+know\.?$/gim, 'I need to align timestamps and access logs before I answer.']],
        navigator: [[/I\s+don'?t\s+know\.?$/gim, 'I need to line up route slices and charts before I answer.']],
        pilot: [[/I\s+don'?t\s+know\.?$/gim, 'I need to replay instruments and what the bridge felt like before I answer.']]
      };
      const we = weakEn[r];
      if (we) {
        for (const [re, rep] of we) {
          if (re.test(s)) {
            s = s.replace(re, rep);
            changed = true;
          }
        }
      }
    }
    if (r !== 'captain') {
      const banEn = [
        {
          re: /(That\s+can'?t\s+be\s+true|That'?s\s+impossible)\.?/gi,
          rep: {
            doctor: threat
              ? 'That is a misread. Medbay and corridor time line up on vitals—do not convict on panic.'
              : targetedAccusation
                ? 'That is a misread. I answer from biometrics and duty logs, not theatrics.'
                : suspicionHeavy
                  ? 'Too fast a verdict. Let vitals and records speak.'
                  : 'Too fast. Cross-check vitals and the charted timeline.',
            engineer: threat
              ? 'That is a misread. Access logs and checksums place me—feelings are not audit trails.'
              : targetedAccusation
                ? 'That is a misread. Timestamps beat accusations—show the mismatch first.'
                : suspicionHeavy
                  ? 'Too fast a verdict. Pull the audit trail.'
                  : 'Too fast. Align relays and timestamps.',
            navigator: threat
              ? 'That is a misread. Routes and charts pin that minute—do not shoot the map.'
              : targetedAccusation
                ? 'That is a misread. Plot my route against the chart before you name me.'
                : suspicionHeavy
                  ? 'Too fast a verdict. Tighten route versus alibi.'
                  : 'Too fast. Cross-check charts and who was where.',
            pilot: threat
              ? 'That is a misread. Instruments and pressure tell where I stood—do not aim on vibes.'
              : targetedAccusation
                ? 'That is a misread. Helm readouts back my story—verify before you point.'
                : suspicionHeavy
                  ? 'Too fast a verdict. Replay instruments and what the hull felt like.'
                  : 'Too fast. Re-read gauges and bridge feel.'
          }
        }
      ];
      for (const row of banEn) {
        const reBan = new RegExp(row.re.source, row.re.flags);
        if (!reBan.test(s)) continue;
        const repBan = row.rep && row.rep[r] != null ? row.rep[r] : null;
        if (repBan == null) continue;
        s = s.replace(reBan, repBan);
        changed = true;
        markGeneric();
      }
    }
    if (selfDefense && r !== 'captain') {
      const sdDoctorEn = [
        [
          /I\s+have\s+no\s+evidence/gi,
          corneredMedical
            ? 'That is wrong. I was in medbay corridor when it mattered—vitals and triage logs are my alibi, not vibes.'
            : 'The medbay logs place me on station—do not convict me on vibes.'
        ],
        [
          /I\s+didn'?t\s+do\s+anything\s+suspicious/gi,
          'Cross-check vitals and statements—I will answer from records, not panic.'
        ],
        [/I\s+(stayed|was)\s+calm/gi, 'I was at my post when it mattered—do not point before you prove.']
      ];
      const sdEngineerEn = [
        [/I\s+have\s+no\s+evidence/gi, 'Access logs and relays put me in my lane—slow down the accusation.'],
        [
          /I\s+didn'?t\s+do\s+anything\s+suspicious/gi,
          'Timestamps and checksums are my reply—do not rush execution.'
        ],
        [/I\s+(stayed|was)\s+calm/gi, 'I was on core-side duty—calm is not a confession.']
      ];
      const sdNavEn = [
        [/I\s+have\s+no\s+evidence/gi, 'Charts and routes line up with my story—verify before you name me.'],
        [
          /I\s+didn'?t\s+do\s+anything\s+suspicious/gi,
          'I will walk you through route slices—do not shoot on instinct.'
        ],
        [/I\s+(stayed|was)\s+calm/gi, 'I was tying bridge and chart—nerves are not proof.']
      ];
      const sdPilotEn = [
        [/I\s+have\s+no\s+evidence/gi, 'Instruments show where I was—do not aim on a hunch.'],
        [
          /I\s+didn'?t\s+do\s+anything\s+suspicious/gi,
          'Helm and pressure tell the tale—hold fire until logs match.'
        ],
        [/I\s+(stayed|was)\s+calm/gi, 'I was at the helm readouts—steady hands are not guilt.']
      ];
      const pickEn =
        r === 'doctor'
          ? sdDoctorEn
          : r === 'engineer'
            ? sdEngineerEn
            : r === 'navigator'
              ? sdNavEn
              : r === 'pilot'
                ? sdPilotEn
                : [];
      for (const [re, rep] of pickEn) {
        if (re.test(s)) {
          s = s.replace(re, rep);
          changed = true;
          selfDefenseApplied = true;
          markGeneric();
        }
      }
    }
    if (suspicion && r !== 'captain' && /^(Okay\.|I\s+see\.|Understood\.|Yes\.)/i.test(s.trim())) {
      let prefix = '';
      if (threat) {
        prefix =
          r === 'doctor'
            ? 'This is vitals and triage, not theater. '
            : r === 'engineer'
              ? 'This is logs and checksums, not theater. '
              : r === 'navigator'
                ? 'This is routes and charts, not theater. '
                : 'This is instruments and bridge feel, not theater. ';
      } else if (suspicionHeavy) {
        prefix =
          r === 'doctor'
            ? 'That is a misread—vitals and records first. '
            : r === 'engineer'
              ? 'That is a misread—timestamps and access trails first. '
              : r === 'navigator'
                ? 'That is a misread—routes and alibis first. '
                : 'That is a misread—gauges and what the hull felt like first. ';
      } else if (suspicionWeak) {
        prefix =
          r === 'doctor'
            ? 'Slow down—vitals and charts deserve another pass. '
            : r === 'engineer'
              ? 'Slow down—logs need another pass. '
              : r === 'navigator'
                ? 'Slow down—routes need another pass. '
                : 'Slow down—instruments need another pass. ';
      } else if (selfDefense) {
        prefix =
          r === 'doctor'
            ? 'That is a misread—vitals and records first. '
            : r === 'engineer'
              ? 'That is a misread—timestamps and access trails first. '
              : r === 'navigator'
                ? 'That is a misread—routes and alibis first. '
                : 'That is a misread—gauges and bridge feel first. ';
      }
      if (prefix) {
        s = prefix + s;
        changed = true;
      }
    }
  }
  return { text: s, changed, selfDefenseApplied, genericRewritten };
}

/** 이름 질문에 역할 슬로건만 있는지(실명 없음) 대략 감지 — 후처리 교정용 */
function looksLikeRoleOnlyKoNameIntro(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/저는\s+[가-힣]{2,4}\s*입니다/.test(s)) return false;
  if (/저는\s+[A-Za-z]/.test(s)) return false;
  return (
    /(함선\s*)?의관|엔지니어\s*[—\-]|네비게이터\s*[—\-]|파일럿\s*[—\-]|닥터로\s*부르|타임스탬프는\s*내\s*쪽|내\s*구역이다|말하지\s*$/i.test(
      s
    ) || (/^[가-힣\s—\-]+$/i.test(s) && /의무실|접근\s*로그|차트|교량/.test(s) && !/[가-힣]{3}\s*입니다/.test(s))
  );
}

function looksLikeRoleOnlyEnNameIntro(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/\bI\s+am\s+[A-Za-z]/.test(s)) return false;
  return /Ship\s+physician|Engineer—|Navigator—|Pilot—|call\s+me\s+Doctor/i.test(s);
}

/**
 * 크루 한국어 존댓말 보정(함장 대상). 금지 패턴을 완곡한 존댓말로 치환.
 */
function applyHonorificCrewKo(text, role) {
  const r = String(role || '').toLowerCase();
  if (!['doctor', 'engineer', 'navigator', 'pilot'].includes(r)) return { text: text, changed: false };
  let s = String(text || '');
  let changed = false;
  const reps = [
    [/닥터로\s*부르게/g, '닥터로 불러 주십시오'],
    [/부르게\b/g, '불러 주십시오'],
    [/내\s*구역이다/g, '제가 맡은 구역입니다'],
    [/내\s*쪽이다/g, '제가 담당하는 쪽입니다'],
    [/(^|[.!?]\s*)말하지\s*$/g, '$1말씀드리겠습니다'],
    [/\b말하지\s*[.!]?$/g, '말씀드리겠습니다.']
  ];
  for (const [re, rep] of reps) {
    if (re.test(s)) {
      s = s.replace(re, rep);
      changed = true;
    }
  }
  if (changed) {
    try {
      console.log('[bot][dialogue] honorific_tone_applied role=' + r);
    } catch (e) {}
  }
  return { text: s, changed };
}

function stabilizeNameQuestionCrewLine(text, role, loc, opts) {
  opts = opts || {};
  const cn = opts.crewPersonalNames || {};
  const stable = getCrewDisplayName(cn, role, loc);
  if (!stable || stable === '승무원' || stable === 'Crew') return { text, changed: false };
  const r = String(role || '').toLowerCase();
  let changed = false;
  let s = String(text || '');
  const isNameCtx =
    !!opts.targetedNameQuestion &&
    opts.targetedNameFocusRole &&
    r === String(opts.targetedNameFocusRole).toLowerCase();
  if (!isNameCtx) return { text: s, changed: false };
  if (loc === 'ko' && looksLikeRoleOnlyKoNameIntro(s)) {
    const roleBit =
      r === 'doctor'
        ? '의무실을 맡고 있습니다.'
        : r === 'engineer'
          ? '코어와 접근 로그를 관리하고 있습니다.'
          : r === 'navigator'
            ? '차트와 항로를 맡고 있습니다.'
            : '교량 근무를 맡고 있습니다.';
    s = `저는 ${stable}입니다. ${roleBit}`;
    changed = true;
    try {
      console.log('[bot][dialogue] role_intro_blocked_for_name_question role=' + r);
      console.log('[bot][dialogue] stable_name_applied role=' + r);
    } catch (e) {}
  } else if (loc === 'en' && looksLikeRoleOnlyEnNameIntro(s)) {
    const roleBit =
      r === 'doctor'
        ? 'I run medbay and vitals.'
        : r === 'engineer'
          ? 'I manage core systems and access logs.'
          : r === 'navigator'
            ? 'I handle charts and routes.'
            : 'I stand bridge watch.';
    s = `I am ${stable}. ${roleBit}`;
    changed = true;
    try {
      console.log('[bot][dialogue] role_intro_blocked_for_name_question role=' + r);
      console.log('[bot][dialogue] stable_name_applied role=' + r);
    } catch (e) {}
  } else if (loc === 'ko' && s && !s.includes(stable) && /이름|성함|누구/.test(String(opts.playerText || ''))) {
    if (/저는\s+[가-힣]{2,4}/.test(s)) {
      /* already has some name */
    } else if (/저는/.test(s)) {
      s = s.replace(/^저는\s+[^.,!?\n]+/, '저는 ' + stable);
      changed = true;
      try {
        console.log('[bot][dialogue] stable_name_applied role=' + r);
      } catch (e) {}
    }
  }
  return { text: s, changed };
}

function roleKeyFromBracketHeaderLine(line) {
  const t = String(line || '').trim();
  if (/^\[닥터\]|^\[Doctor\]/i.test(t)) return 'doctor';
  if (/^\[엔지니어\]|^\[Engineer\]/i.test(t)) return 'engineer';
  if (/^\[네비게이터\]|^\[Navigator\]/i.test(t)) return 'navigator';
  if (/^\[파일럿\]|^\[Pilot\]/i.test(t)) return 'pilot';
  if (/^\[함장\]|^\[Captain\]/i.test(t)) return 'captain';
  return null;
}

function applyCharacterToneToDisplayLogs(displayLogs, locale, opts) {
  opts = opts || {};
  const loc = locale === 'en' ? 'en' : 'ko';
  const toneCtx = computeToneContext(opts.playerText || '', opts);
  const hiFlags = gatherHighIntensitySceneFlags(toneCtx);
  if (Object.keys(hiFlags).length) {
    try {
      console.log('[bot][dialogue] high_intensity_scene flags=' + JSON.stringify(hiFlags));
    } catch (e) {}
  }
  if (!displayLogs || !displayLogs.length) return displayLogs;
  const out = [];
  let pendingRole = null;
  for (const item of displayLogs) {
    const typeLine = String(item.type || '').trim();
    const rk = roleKeyFromBracketHeaderLine(typeLine);
    if (rk) {
      pendingRole = rk;
      out.push(item);
      continue;
    }
    if (/^\[/.test(typeLine)) {
      pendingRole = null;
      out.push(item);
      continue;
    }
    if (pendingRole && pendingRole !== 'captain' && typeLine) {
      let newLine = typeLine;
      const { text: w1, changed: c1, selfDefenseApplied, genericRewritten } = rewriteCrewLineForTone(
        newLine,
        pendingRole,
        loc,
        toneCtx
      );
      newLine = w1;
      if (c1) {
        try {
          console.log('[bot][dialogue] character_tone_applied role=' + pendingRole);
        } catch (e) {}
      }
      if (selfDefenseApplied) {
        try {
          console.log('[bot][dialogue] self_defense_tone_applied role=' + pendingRole);
        } catch (e) {}
      }
      if (genericRewritten) {
        try {
          console.log('[bot][dialogue] generic_response_rewritten role=' + pendingRole);
        } catch (e) {}
      }
      if (loc === 'ko') {
        const h1 = applyHonorificCrewKo(newLine, pendingRole);
        newLine = h1.text;
      }
      const st = stabilizeNameQuestionCrewLine(newLine, pendingRole, loc, opts);
      newLine = st.text;
      out.push({ ...item, type: newLine });
      continue;
    }
    out.push(item);
  }
  return out;
}

async function maybeDialogueLogsFromLlmOrDeterministic({
  rawEvents,
  deterministicLogs,
  match,
  playerText,
  clueTextFromEvent,
  locale,
  forcedCaptainTextOverride,
  targetedQuestionSideReactionRules,
  targetedNameQuestion,
  loreQuestionTopic,
  loreCanonAnchorText
}) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const kind = getDialogueLlmKind(rawEvents);
  if (!kind) return deterministicLogs;
  const actionSlug = dialogueActionKindSlug(kind);
  const eventsCount = (rawEvents || []).length;
  const modelStr = TELEGRAM_DIALOGUE_MODEL;
  const apiProvider = isDeepSeekDialogueModel(modelStr) ? 'deepseek' : 'openai';

  const ev0 = rawEvents && rawEvents[0];
  const nameTargetRole =
    targetedNameQuestion && kind === 'QUESTION' && ev0?.target
      ? String(ev0.target).toLowerCase()
      : null;

  const toneOptsBase = {
    playerText: playerText || '',
    targetedNameQuestion: !!targetedNameQuestion,
    targetedNameFocusRole: nameTargetRole,
    crewPersonalNames: null
  };
  try {
    const gs0 = match?.game_state || {};
    if (match && ep1Engine.getTimerStatus) {
      const t0 = ep1Engine.getTimerStatus(match, Date.now());
      toneOptsBase.remainingSec = Math.max(0, Math.floor(t0.remaining_sec ?? 0));
    }
    toneOptsBase.deadRolesCount = Array.isArray(gs0.dead_roles) ? gs0.dead_roles.length : 0;
    toneOptsBase.gameOver = !!gs0.game_over;
  } catch (e) {}

  if (match?.match_id) {
    await ensureCrewPersonalNamesPersisted(match.match_id);
    const m2 = await matchStore.getMatch(match.match_id);
    toneOptsBase.crewPersonalNames = m2?.game_state?.crew_names || match?.game_state?.crew_names || null;
  }

  if (!isDialogueLlmConfigured()) {
    logDialogueTrace(actionSlug, 'deterministic', modelStr, 'fallback', eventsCount);
    let det = deterministicLogs;
    if (targetedNameQuestion && kind === 'QUESTION' && nameTargetRole && match?.match_id) {
      const m3 = await matchStore.getMatch(match.match_id);
      const fb = buildTargetedNameQuestionDeterministicDisplayLogs(
        m3 || match,
        loc,
        nameTargetRole,
        forcedCaptainTextOverride != null && String(forcedCaptainTextOverride).trim()
          ? String(forcedCaptainTextOverride).trim()
          : extractCaptainSpokenFromDisplayLogs(deterministicLogs, loc)
      );
      if (fb && fb.length) det = fb;
    }
    return applyCharacterToneToDisplayLogs(det, loc, toneOptsBase);
  }

  const forcedCaptainText =
    forcedCaptainTextOverride != null && String(forcedCaptainTextOverride).trim()
      ? String(forcedCaptainTextOverride).trim()
      : extractCaptainSpokenFromDisplayLogs(deterministicLogs, loc);
  const llmLogs = await tryGenerateLlmDialogueLogs({
    kind,
    rawEvents,
    match,
    playerText: playerText || '',
    clueText: clueTextFromEvent != null ? clueTextFromEvent : undefined,
    forcedCaptainText,
    targetedQuestionSideReactionRules: !!targetedQuestionSideReactionRules,
    targetedNameQuestion: !!targetedNameQuestion,
    locale: loc,
    loreQuestionTopic,
    loreCanonAnchorText
  });
  if (llmLogs && llmLogs.length) {
    logDialogueTrace(actionSlug, apiProvider, modelStr, 'llm', eventsCount);
    return applyCharacterToneToDisplayLogs(llmLogs, loc, toneOptsBase);
  }
  logDialogueTrace(actionSlug, apiProvider, modelStr, 'fallback', eventsCount);
  let detOut = deterministicLogs;
  if (targetedNameQuestion && kind === 'QUESTION' && nameTargetRole && match?.match_id) {
    const m4 = await matchStore.getMatch(match.match_id);
    const fb2 = buildTargetedNameQuestionDeterministicDisplayLogs(
      m4 || match,
      loc,
      nameTargetRole,
      forcedCaptainText
    );
    if (fb2 && fb2.length) detOut = fb2;
  }
  return applyCharacterToneToDisplayLogs(detOut, loc, toneOptsBase);
}

function log(tag, msg, data) {
  if (LOG) console.log('[bot]', tag, msg, data != null ? JSON.stringify(data) : '');
}

const ROLE_NAMES_KO = { doctor: '닥터', engineer: '엔지니어', navigator: '네비게이터', pilot: '파일럿', captain: '함장' };

const CREW_ROLES_FOR_NAMES = ['doctor', 'engineer', 'navigator', 'pilot'];
const KO_FAMILY_NAMES = ['김', '이', '박', '최', '정', '강', '조', '윤', '한', '임'];
const KO_GIVEN_NAMES = [
  '민호',
  '준혁',
  '서연',
  '지훈',
  '하은',
  '도윤',
  '예진',
  '시우',
  '유나',
  '태양',
  '수빈',
  '재민',
  '혜진',
  '성민',
  '나연'
];
const EN_GIVEN_NAMES = ['Alex', 'Jordan', 'Sam', 'Riley', 'Casey', 'Morgan', 'Quinn', 'Drew', 'Jamie', 'Taylor'];
const EN_FAMILY_NAMES = ['Park', 'Kim', 'Lee', 'Choi', 'Jung', 'Han', 'Lim', 'Kang', 'Oh', 'Yoon'];

function hashStringToSeed(s) {
  let h = 2166136261;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 매치당 1회 고정되는 크루 personal name (ko/en). game_state.crew_names 에 저장.
 */
function generateStableCrewPersonalNames(matchId) {
  const rnd = mulberry32(hashStringToSeed('crew_names|' + String(matchId || '')));
  const usedKo = new Set();
  const usedEn = new Set();
  const out = {};
  for (const role of CREW_ROLES_FOR_NAMES) {
    let koFull = '';
    for (let k = 0; k < 80; k++) {
      const fi = Math.floor(rnd() * KO_FAMILY_NAMES.length);
      const gi = Math.floor(rnd() * KO_GIVEN_NAMES.length);
      koFull = KO_FAMILY_NAMES[fi] + KO_GIVEN_NAMES[gi];
      if (!usedKo.has(koFull)) {
        usedKo.add(koFull);
        break;
      }
    }
    let enFull = '';
    for (let k = 0; k < 80; k++) {
      const gn = EN_GIVEN_NAMES[Math.floor(rnd() * EN_GIVEN_NAMES.length)];
      const fn = EN_FAMILY_NAMES[Math.floor(rnd() * EN_FAMILY_NAMES.length)];
      enFull = `${gn} ${fn}`;
      if (!usedEn.has(enFull)) {
        usedEn.add(enFull);
        break;
      }
    }
    out[role] = { ko: koFull || '김민호', en: enFull || 'Alex Kim' };
  }
  return out;
}

function getCrewDisplayName(crewNames, role, loc) {
  const r = String(role || '').toLowerCase();
  const entry = crewNames && crewNames[r];
  if (!entry) return loc === 'en' ? 'Crew' : '승무원';
  if (typeof entry === 'string') return entry;
  return loc === 'en' ? entry.en || entry.ko : entry.ko || entry.en;
}

/**
 * game_state 에 crew_names 가 없으면 생성·저장. 있으면 재사용.
 * @returns {Promise<object|null>} 갱신된 game_state 또는 null
 */
async function ensureCrewPersonalNamesPersisted(matchId) {
  const m = await matchStore.getMatch(matchId);
  if (!m) return null;
  const gs = { ...(m.game_state || {}) };
  const cn = gs.crew_names;
  let complete = false;
  if (cn && typeof cn === 'object') {
    complete = CREW_ROLES_FOR_NAMES.every((r) => {
      const x = cn[r];
      if (!x) return false;
      if (typeof x === 'string') return x.length > 0;
      return !!(x.ko && x.en);
    });
  }
  if (complete) {
    try {
      console.log('[bot][state] crew names reused matchId=' + matchId);
    } catch (e) {}
    return gs;
  }
  gs.crew_names = generateStableCrewPersonalNames(matchId);
  await matchStore.updateMatch(matchId, { game_state: gs });
  try {
    console.log('[bot][state] crew names initialized matchId=' + matchId);
  } catch (e) {}
  return gs;
}

/** 이름 질문 LLM 실패 시: 함장 + 대상 역할만 실명 중심 응답(타 역할 생략). */
function buildTargetedNameQuestionDeterministicDisplayLogs(match, locale, targetRole, captainSpokenLine) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const headers = getLlmRoleHeaders(loc);
  const gs = match.game_state || {};
  const deadRoles = gs.dead_roles || [];
  const alive = CREW_ROLES_FOR_NAMES.filter((r) => !deadRoles.includes(r));
  const t = String(targetRole || '').toLowerCase();
  if (!alive.includes(t)) return null;
  const names = gs.crew_names || {};
  const displayName = getCrewDisplayName(names, t, loc);
  const capHdr = captainHeader(loc);
  const capBody =
    String(captainSpokenLine || '').trim() ||
    (loc === 'en' ? `${roleNameEn(t)}, what is your name?` : `${roleNameKo(t)}, 성함이 어떻게 되십니까?`);
  const roleSuffix =
    t === 'doctor'
      ? loc === 'en'
        ? 'I run medbay and vitals for this ship.'
        : '의무실과 생체 모니터링을 맡고 있습니다.'
      : t === 'engineer'
        ? loc === 'en'
          ? 'I manage core systems and access logs.'
          : '코어와 접근 로그를 관리하고 있습니다.'
        : t === 'navigator'
          ? loc === 'en'
            ? 'I handle charts and route alignment.'
            : '차트와 항로 정합을 맡고 있습니다.'
          : loc === 'en'
            ? 'I stand bridge watch and helm readouts.'
            : '교량 근무와 계기를 맡고 있습니다.';
  const targetLine =
    loc === 'en'
      ? `I am ${displayName}. ${roleSuffix}`
      : `저는 ${displayName}입니다. ${roleSuffix}`;
  const out = [];
  out.push({ type: capHdr, role: 'system', target: null, _key: 'tnq-fb|cap-h' });
  out.push({ type: capBody, role: 'system', target: null, _key: 'tnq-fb|cap-b' });
  out.push({ type: headers[t], role: 'system', target: null, _key: 'tnq-fb|h|' + t });
  out.push({ type: targetLine, role: 'system', target: null, _key: 'tnq-fb|b|' + t });
  return normalizePlayerFacingDisplayLogs(out, loc);
}

function roleNameKo(r) {
  return ROLE_NAMES_KO[String(r || '').toLowerCase()] || (r ? String(r) : '');
}

/** 목적어 조사: 닥터→닥터를, 파일럿→파일럿을. 이미 조사 있으면 붙이지 않음. */
function roleWithObjectParticle(roleKey) {
  const name = roleNameKo(roleKey);
  if (!name) return '';
  const r = String(roleKey || '').toLowerCase();
  const hasParticle = /[을를이가과와]\s*$/.test(name);
  if (hasParticle) return name;
  const withParticle = { doctor: '닥터를', engineer: '엔지니어를', navigator: '네비게이터를', pilot: '파일럿을' }[r];
  return withParticle || name + '를';
}

/**
 * Raw action trace를 플레이어용 읽기 전용 로그로 변환.
 * QUESTION -> navigator, CHECK_LOG 등은 노출하지 않고, 사람이 읽을 수 있는 문장만 반환.
 * miniapp applyEvents: label = (ev.type || ev.role) + (ev.target ? ' -> ' + ev.target : '')
 * → type에 전체 문장을 넣고 target=null로 하면 문장만 표시됨.
 * @param {object[]} rawEvents - match.events 등 내부 raw 이벤트
 * @param {object} [opts]
 * @param {string} [opts.captainInputLine] - 해당 배치가 CHECK_LOG일 때 본문에 살릴 플레이어 입력 (이벤트에 dialogue/text 없을 때만)
 * @param {string} [opts.questionCaptainBodyOverride] - QUESTION 본문 강제(선택). targeted_question 표시는 bot에서 forcedCaptainTextOverride+applyTargetedQuestionCaptainDisplayBody로만 맞춤.
 * @returns {object[]} { type: string, role?, target?: null, _key?: string } - 표시용
 */
function toPlayerDisplayLogs(rawEvents, opts = {}) {
  if (!rawEvents || !Array.isArray(rawEvents)) return [];
  const locale = opts.locale === 'en' ? 'en' : 'ko';
  const capHdr = captainHeader(locale);
  const sysHdr = systemHeader(locale);
  const captainInputLine = String(opts.captainInputLine || '').trim();
  const out = [];

  for (const ev of rawEvents) {
    const t = String(ev?.type || '').toUpperCase();
    const role = ev?.role || 'captain';
    const target = ev?.target ? String(ev.target).toLowerCase() : null;
    const baseKey = [ev?.ts ?? '', t, role, target ?? ''].join('|');

    if (t === 'QUESTION' && target) {
      const override = String(opts.questionCaptainBodyOverride || '').trim();
      const qBody =
        override ||
        (locale === 'en'
          ? `${roleNameEn(target)}, where were you then?`
          : `${roleNameKo(target)}, 그때 어디 있었지?`);
      const body = (
        qBody ||
        ev.dialogue ||
        ev.text ||
        (locale === 'en' ? 'The captain asks a question.' : '함장이 질문했다.')
      ).trim();
      if (body) {
        out.push({ type: capHdr, role: 'system', target: null, _key: baseKey + '|hdr' });
        out.push({ type: body, role: 'system', target: null, _key: baseKey + '|body' });
      }
      continue;
    }
    if (t === 'SUSPECT' && target) {
      const sBody =
        locale === 'en'
          ? `Suspects ${roleNameEn(target)}.`
          : `${roleWithObjectParticle(target)} 의심한다`;
      const body = (
        sBody ||
        ev.dialogue ||
        ev.text ||
        (locale === 'en' ? `Suspects ${roleNameEn(target)}.` : `${roleNameKo(target)}를 의심한다`)
      ).trim();
      if (body) {
        out.push({ type: capHdr, role: 'system', target: null, _key: baseKey + '|hdr' });
        out.push({ type: body, role: 'system', target: null, _key: baseKey + '|body' });
      }
      continue;
    }
    if (t === 'CHECK_LOG') {
      const fromUser = (ev.dialogue || ev.text || '').trim();
      const body =
        fromUser ||
        captainInputLine ||
        (locale === 'en'
          ? target
            ? `Checking ${roleNameEn(target)} sector logs`
            : 'Checking system logs'
          : target
            ? `${roleNameKo(target)} 구역 로그를 확인한다`
            : '시스템 로그를 확인한다');
      if (body) {
        out.push({ type: capHdr, role: 'system', target: null, _key: baseKey + '|hdr' });
        out.push({ type: body, role: 'system', target: null, _key: baseKey + '|body' });
      }
      continue;
    }
    if (t === 'THREATEN' && target) {
      const body =
        locale === 'en'
          ? `Threatens ${roleNameEn(target)}.`
          : `${roleWithObjectParticle(target)} 위협한다`.replace(/\s+/g, ' ').trim();
      const tk = [ev?.ts ?? '', t, role, target].join('|');
      out.push({ type: capHdr, role: 'system', target: null, _key: tk + '|hdr' });
      out.push({ type: body, role: 'system', target: null, _key: tk + '|body' });
      continue;
    }
    if (t === 'FIND_CLUE') {
      const clueId = ev.clue_id ? String(ev.clue_id) : '';
      const clueKey = clueId || [ev?.ts ?? '', t, role, target ?? ''].join('|');
      const sysBody = localizeClueSystemLineForDisplay(locale, ev.clue_id, ev.clue_text);
      const capBody = localizeFindClueCaptainLine(locale, ev.captain_action);
      if (sysBody) {
        out.push({ type: capHdr, role: 'system', target: null, _key: clueKey + '|hdr' });
        out.push({ type: capBody, role: 'system', target: null, _key: clueKey + '|body' });
        out.push({ type: sysHdr, role: 'system', target: null, _key: clueKey + '|sys-hdr' });
        out.push({ type: sysBody, role: 'system', target: null, _key: clueKey + '|sys-body' });
      } else {
        out.push({
          type: locale === 'en' ? 'The captain collects a clue.' : '함장이 단서를 수집했다.',
          role: 'system',
          target: null,
          _key: clueKey
        });
      }
      continue;
    }

    let text = null;
    if (t === 'OBSERVE') {
      text = locale === 'en' ? 'The captain observes the bridge.' : '함장이 교량을 관찰했다.';
    } else if (t === 'ACCUSE' && target) {
      text =
        locale === 'en'
          ? `The captain executes ${roleNameEn(target)}.`
          : `함장이 ${roleWithObjectParticle(target)} 처형했다.`;
    } else if (t === 'DEATH') {
      const victimKo = roleNameKo(ev.role || target);
      const victimEn = roleNameEn(ev.role || target);
      text =
        locale === 'en'
          ? victimEn
            ? `${sysHdr} ${victimEn} life signs lost.`
            : `${sysHdr} Life signs lost.`
          : victimKo
            ? `${sysHdr} ${victimKo} 생체 신호 소실.`
            : `${sysHdr} 생체 신호 소실.`;
    } else if (t === 'TIMEOUT') {
      text = locale === 'en' ? `${sysHdr} Time expired.` : `${sysHdr} 시간 종료.`;
    } else if (t === 'TAKE_PISTOL') {
      const fromUser = (ev.dialogue || ev.text || '').trim();
      const body = fromUser || (locale === 'en' ? 'Acquires the sidearm.' : '권총을 획득했다.');
      if (body) {
        out.push({ type: capHdr, role: 'system', target: null, _key: baseKey + '|hdr' });
        out.push({ type: body, role: 'system', target: null, _key: baseKey + '|body' });
      }
      continue;
    } else if (t === 'REPAIR' || t === 'WAIT') {
      text = null;
    } else if (ev.dialogue && typeof ev.dialogue === 'string') {
      const d = ev.dialogue.trim();
      const m = d.match(/^\[([^\]]+)\]\s*(.*)$/);
      const crewBody = m ? m[2].trim() : '';
      if (m && crewBody) {
        out.push({ type: '[' + m[1] + ']', role: 'system', target: null, _key: baseKey + '|hdr' });
        out.push({ type: crewBody, role: 'system', target: null, _key: baseKey + '|body' });
      } else {
        text = d;
      }
    }

    if (text) {
      out.push({ type: text, role: 'system', target: null, _key: baseKey });
    }
  }
  return normalizePlayerFacingDisplayLogs(out, locale);
}

/** 내부 요약/debug 문장 패턴 (플레이어 로그에서 제외) */
const INTERNAL_SUMMARY_PATTERN = /^(Captain acted\.?|Crew acted\.?|함장이 행동했다\.?|.+\s+acted\.?|.+\s+processed\.?)$/i;

/** 표시 문자열 정규화 (공백·트림) — 연속/턴 내 중복 비교용 */
function normalizeDisplayLine(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 함장 로그 확인 과거형 서술 (구 CHECK_LOG fallback). 함장+현재형 본문 직후면 제거 */
const CAPTAIN_LOG_PAST_NARRATION = /^함장이 (?:시스템|닥터|엔지니어|네비게이터|파일럿)(?: 구역)? 로그를 확인했다\.?$/;
const CAPTAIN_LOG_PAST_NARRATION_EN =
  /^The captain checked (?:the )?(?:system|doctor|engineer|navigator|pilot)(?: sector)? logs\.?$/i;

/**
 * 같은 이벤트가 여러 번 내려가지 않도록 _key(ts+type+role+target) 기준 dedupe.
 * 내부 요약 문장(Captain acted., Crew acted. 등)은 제거.
 * 연속으로 동일한 표시 문장(normalize 기준)은 한 번만 유지.
 * [함장] + 로그 확인 본문 다음에 오는 동일 의미의 함장 과거형 서술은 제거.
 * @param {object[]} displayLogs - toPlayerDisplayLogs 출력
 */
function dedupeDisplayLogs(displayLogs, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const capH = captainHeader(loc);
  if (!displayLogs || !displayLogs.length) return [];
  const seen = new Set();
  const out = [];
  for (const item of displayLogs) {
    const type = (item.type || '').trim();
    if (INTERNAL_SUMMARY_PATTERN.test(type)) continue;
    const key = item._key ?? type ?? '';
    if (!seen.has(key)) {
      seen.add(key);
      const { _key, ...rest } = item;
      out.push(rest);
    }
  }
  const final = [];
  let prevNorm = null;
  for (const item of out) {
    const norm = normalizeDisplayLine(item.type);
    if (norm && norm === prevNorm) continue;
    if (norm && loc === 'ko' && CAPTAIN_LOG_PAST_NARRATION.test(norm) && final.length >= 2) {
      const prev = final[final.length - 1];
      const hdr = final[final.length - 2];
      if (hdr && hdr.type === capH && prev && prev.type && /확인/.test(String(prev.type))) {
        continue;
      }
    }
    if (norm && loc === 'en' && CAPTAIN_LOG_PAST_NARRATION_EN.test(norm) && final.length >= 2) {
      const prev = final[final.length - 1];
      const hdr = final[final.length - 2];
      if (hdr && hdr.type === capH && prev && prev.type && /check/i.test(String(prev.type))) {
        continue;
      }
    }
    prevNorm = norm;
    final.push(item);
  }
  return normalizePlayerFacingDisplayLogs(final, loc);
}

/**
 * /start 처리
 * @param {string} playerId - telegram user id
 * @param {object} opts - { game_total_sec?, now? } 테스트용
 * @returns {Promise<string>}
 */
async function handleStart(playerId, opts = {}) {
  const player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  const loc = opts.locale === 'en' ? 'en' : 'ko';

  let needNewMatch = !matchId;
  if (matchId) {
    const existingMatch = await matchStore.getMatch(matchId);
    if (existingMatch?.game_state?.game_over) needNewMatch = true;
  }
  if (needNewMatch) {
    const userKey = resolveUserKey(playerId, null);
    const ticket = await consumeDailyTicketIfAllowed(userKey, { locale: loc });
    if (!ticket.allowed) {
      return loc === 'en'
        ? 'You have used all daily entry tickets. Please try again tomorrow or use a higher clearance tier.'
        : '오늘의 입장권을 모두 사용했습니다. 내일 다시 시도하거나 상위 보안등급을 이용하세요.';
    }
    const match = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {
      game_total_sec: opts.game_total_sec
    });
    matchId = match.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  const match = await matchStore.getMatch(matchId);
  const timer = ep1Engine.getTimerStatus ? ep1Engine.getTimerStatus(match, opts.now) : { remaining_sec: 420 };
  const mins = Math.floor((timer.remaining_sec || 420) / 60);
  const secs = (timer.remaining_sec || 420) % 60;
  log('START', 'ok', { playerId, matchId, remaining_sec: timer.remaining_sec });
  return (
    'Tartarus Protocol v1\n\n' +
    'You are the Captain. Find the imposter before time runs out.\n\n' +
    'Commands:\n' +
    '- /start : Start or resume\n' +
    '- Type freely: "네비게이터 어디 있었어", "로그 보여줘", "닥터 의심"\n\n' +
    'Match: ' + matchId + '\n' +
    'Time left: ' + mins + ':' + String(secs).padStart(2, '0') + '\n' +
    (match?.deadline_at ? 'Deadline: ' + match.deadline_at : '')
  );
}

/**
 * 일반 텍스트 입력 처리
 * @param {string} playerId - telegram user id
 * @param {string} text - 사용자 입력
 * @param {object} opts - { now? } 테스트용 시각 주입
 * @returns {Promise<string>}
 */
async function handleTextMessage(playerId, text, opts = {}) {
  // 1. player → match
  const locale = opts.locale === 'en' ? 'en' : 'ko';
  let player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  if (!matchId) {
    const userKey = resolveUserKey(playerId, null);
    const ticket = await consumeDailyTicketIfAllowed(userKey, { locale });
    if (!ticket.allowed) {
      return locale === 'en'
        ? 'You have used all daily entry tickets. Please try again tomorrow or use a higher clearance tier.'
        : '오늘의 입장권을 모두 사용했습니다. 내일 다시 시도하거나 상위 보안등급을 이용하세요.';
    }
    const match = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }

  const match = await matchStore.getMatch(matchId);
  if (!match) return 'Match not found. Send /start to begin.';

  const parsed = applyQuestionLikeIntentGuard(text, intentParser.parse(text));
  const cls = classifyMiniappFreeText(text, parsed);
  const now = opts.now;

  if (cls.kind === 'state_query') {
    const timer = ep1Engine.getTimerStatus(match, now);
    const rem = Math.max(0, Math.floor(timer.remaining_sec ?? 0));
    const gs = match.game_state || {};
    const isOver = !!gs.game_over;
    const logRem = cls.subtype === 'remaining_time' ? (isOver ? 0 : rem) : rem;
    console.log(
      '[bot] message kind=state_query subtype=' + cls.subtype + ' remaining_sec=' + logRem
    );
    const line = buildStateQueryDialogueLine(match, cls.subtype, locale, now);
    const rawEvents = [{ type: 'CREW_DIALOGUE', role: 'system', dialogue: line }];
    const recentDisplay = dedupeDisplayLogs(toPlayerDisplayLogs(rawEvents, { locale }), locale);
    let reply = recentDisplay.map((e) => e.type).filter(Boolean).join('\n');
    if (!isOver) {
      const m = Math.floor(rem / 60);
      const s = rem % 60;
      reply += '\n⏱ ' + m + ':' + String(s).padStart(2, '0') + ' left';
    }
    return reply;
  }

  if (match.game_state?.game_over) {
    log('GAME_OVER', 'blocked', { playerId, matchId, outcome: match.game_state.outcome });
    return 'Game over. Outcome: ' + (match.game_state.outcome || 'unknown') + '. Send /start for new game.';
  }

  const consumesFreePromptTg = shouldConsumeFreePromptForMessageKind(cls, parsed, text);
  logIntentPromptDecision(cls, parsed, consumesFreePromptTg);
  if (consumesFreePromptTg) {
    const userKey = resolveUserKey(playerId, matchId);
    const pr = await consumeFreePromptIfAllowed(userKey, { locale });
    if (!pr.allowed) {
      return locale === 'en'
        ? 'You have used all daily free-text prompts for today. Button actions are still available.'
        : '오늘의 자유입력 횟수를 모두 사용했습니다. 버튼 액션은 계속 사용할 수 있습니다.';
    }
  }

  if (cls.kind === 'role_opinion_question') {
    console.log('[bot] message kind=role_opinion_question target=' + parsed.target);
    await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
    const events = buildRoleOpinionQuestionEvents(match, parsed.target, locale);
    for (const ev of events) await matchStore.appendEvent(matchId, ev);
    const updated = await matchStore.getMatch(matchId);
    const captainBodyForRoleOpinion =
      stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) ||
      String(text || '').trim();
    let recentDisplay = dedupeDisplayLogs(toPlayerDisplayLogs(events, { locale }), locale);
    const firstEv = events[0];
    const isErrorRoleOpinion = firstEv && String(firstEv.role || '').toLowerCase() === 'system';
    if (captainBodyForRoleOpinion && !isErrorRoleOpinion) {
      recentDisplay = applyTargetedQuestionCaptainDisplayBody(recentDisplay, captainBodyForRoleOpinion, locale);
      recentDisplay = dedupeDisplayLogs(recentDisplay, locale);
      console.log('[bot] role_opinion_question captain_display_source=final_only');
      console.log('[bot] role_opinion_question captain_body_preserved=true');
    }
    const timerRo = ep1Engine.getTimerStatus(updated, now);
    const rem = Math.max(0, Math.floor(timerRo.remaining_sec ?? 0));
    const gsToneRo = updated?.game_state || {};
    if (!isErrorRoleOpinion) {
      recentDisplay = applyCharacterToneToDisplayLogs(recentDisplay, locale, {
        playerText: String(text || ''),
        crewPersonalNames: updated?.game_state?.crew_names || null,
        remainingSec: rem,
        deadRolesCount: Array.isArray(gsToneRo.dead_roles) ? gsToneRo.dead_roles.length : 0,
        gameOver: !!gsToneRo.game_over
      });
    }
    let reply = recentDisplay.map((e) => e.type).filter(Boolean).join('\n') || '…';
    const m = Math.floor(rem / 60);
    const sec = rem % 60;
    reply += '\n⏱ ' + m + ':' + String(sec).padStart(2, '0') + ' left';
    return reply;
  }

  if (cls.kind === 'group_question') {
    const sub = cls.groupSubkind || 'suspicion';
    console.log('[bot] message kind=group_question sub=' + sub);
    await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
    if (sub === 'name') await ensureCrewPersonalNamesPersisted(matchId);
    const matchAfterNames = sub === 'name' ? await matchStore.getMatch(matchId) : match;
    const events = resolveGroupCrewEvents(matchAfterNames || match, locale, sub);
    for (const ev of events) await matchStore.appendEvent(matchId, ev);
    const updated = await matchStore.getMatch(matchId);
    const captainBodyForGroup =
      stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) ||
      String(text || '').trim();
    let recentDisplay = dedupeDisplayLogs(toPlayerDisplayLogs(events, { locale }), locale);
    if (captainBodyForGroup) {
      recentDisplay = applyTargetedQuestionCaptainDisplayBody(recentDisplay, captainBodyForGroup, locale);
      recentDisplay = dedupeDisplayLogs(recentDisplay, locale);
    }
    const timer = ep1Engine.getTimerStatus(updated, now);
    const rem = Math.max(0, Math.floor(timer.remaining_sec ?? 0));
    const gsToneG = updated?.game_state || {};
    recentDisplay = applyCharacterToneToDisplayLogs(recentDisplay, locale, {
      playerText: String(text || ''),
      crewPersonalNames: updated?.game_state?.crew_names || null,
      remainingSec: rem,
      deadRolesCount: Array.isArray(gsToneG.dead_roles) ? gsToneG.dead_roles.length : 0,
      gameOver: !!gsToneG.game_over
    });
    let reply = recentDisplay.map((e) => e.type).filter(Boolean).join('\n') || '…';
    const m = Math.floor(rem / 60);
    const sec = rem % 60;
    reply += '\n⏱ ' + m + ':' + String(sec).padStart(2, '0') + ' left';
    return reply;
  }

  if (cls.kind === 'suspicion_question') {
    console.log('[bot] message kind=suspicion_question');
    await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
    const events = buildOpenQuestionCrewEvents(match, locale);
    for (const ev of events) await matchStore.appendEvent(matchId, ev);
    const updated = await matchStore.getMatch(matchId);
    const captainBodyForSusp =
      stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) ||
      String(text || '').trim();
    let recentDisplay = dedupeDisplayLogs(toPlayerDisplayLogs(events, { locale }), locale);
    if (captainBodyForSusp) {
      recentDisplay = applyTargetedQuestionCaptainDisplayBody(recentDisplay, captainBodyForSusp, locale);
      recentDisplay = dedupeDisplayLogs(recentDisplay, locale);
    }
    const timerSq = ep1Engine.getTimerStatus(updated, now);
    const rem = Math.max(0, Math.floor(timerSq.remaining_sec ?? 0));
    const gsToneSq = updated?.game_state || {};
    recentDisplay = applyCharacterToneToDisplayLogs(recentDisplay, locale, {
      playerText: String(text || ''),
      crewPersonalNames: updated?.game_state?.crew_names || null,
      remainingSec: rem,
      deadRolesCount: Array.isArray(gsToneSq.dead_roles) ? gsToneSq.dead_roles.length : 0,
      gameOver: !!gsToneSq.game_over
    });
    let reply = recentDisplay.map((e) => e.type).filter(Boolean).join('\n') || '…';
    const m = Math.floor(rem / 60);
    const sec = rem % 60;
    reply += '\n⏱ ' + m + ':' + String(sec).padStart(2, '0') + ' left';
    return reply;
  }

  if (cls.kind === 'lore_question') {
    console.log('[bot] message kind=lore_question');
    const gateTg = evaluateLoreUnknownTermGate('lore_question', String(text || ''), locale);
    if (gateTg.block) {
      await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
      const lineUnk = buildUnknownLoreTermSystemLine(locale, gateTg.term);
      const rawEvUnk = [{ type: 'CREW_DIALOGUE', role: 'system', dialogue: lineUnk }];
      const recentDisplayUnk = dedupeDisplayLogs(toPlayerDisplayLogs(rawEvUnk, { locale }), locale);
      const toStoreUnk = displayLogsToCrewDialogueEvents(recentDisplayUnk, locale);
      for (const ev of toStoreUnk) await matchStore.appendEvent(matchId, ev);
      const updatedUnk = await matchStore.getMatch(matchId);
      const timerUnk = ep1Engine.getTimerStatus(updatedUnk, now);
      const remUnk = Math.max(0, Math.floor(timerUnk.remaining_sec ?? 0));
      let replyUnk = recentDisplayUnk.map((e) => e.type).filter(Boolean).join('\n') || '…';
      const mUnk = Math.floor(remUnk / 60);
      const secUnk = remUnk % 60;
      replyUnk += '\n⏱ ' + mUnk + ':' + String(secUnk).padStart(2, '0') + ' left';
      return replyUnk;
    }
    await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
    const matchForLlm = await matchStore.getMatch(matchId);
    const captainBodyForLore =
      stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) ||
      String(text || '').trim();
    const loreTopic = detectLoreQuestionTopic(String(text || ''), locale);
    console.log('[bot] lore_question topic=' + loreTopic + ' locale=' + locale);
    console.log('[bot] lore_question canon_anchor_applied=true');
    const rawEvents = [{ type: 'LORE_QUESTION' }];
    const deterministicFallback = buildLoreQuestionDeterministicFallbackEvents(
      matchForLlm,
      locale,
      captainBodyForLore,
      loreTopic
    );
    const deterministicLogs = dedupeDisplayLogs(
      toPlayerDisplayLogs(deterministicFallback, { locale }),
      locale
    );
    const loreCanonSnippet = getLoreTopicSnippet(loreTopic, locale);
    let recentDisplay = dedupeDisplayLogs(
      await maybeDialogueLogsFromLlmOrDeterministic({
        rawEvents,
        deterministicLogs,
        match: matchForLlm,
        playerText: String(text || '').trim(),
        clueTextFromEvent: undefined,
        locale,
        forcedCaptainTextOverride: captainBodyForLore,
        targetedQuestionSideReactionRules: false,
        loreQuestionTopic: loreTopic,
        loreCanonAnchorText: loreCanonSnippet
      }),
      locale
    );
    if (captainBodyForLore) {
      recentDisplay = applyTargetedQuestionCaptainDisplayBody(recentDisplay, captainBodyForLore, locale);
      recentDisplay = dedupeDisplayLogs(recentDisplay, locale);
      console.log('[bot] lore_question captain_body_preserved=true');
    }
    const toStore = displayLogsToCrewDialogueEvents(recentDisplay, locale);
    for (const ev of toStore) await matchStore.appendEvent(matchId, ev);
    const updated = await matchStore.getMatch(matchId);
    const timer = ep1Engine.getTimerStatus(updated, now);
    const rem = Math.max(0, Math.floor(timer.remaining_sec ?? 0));
    let reply = recentDisplay.map((e) => e.type).filter(Boolean).join('\n') || '…';
    const m = Math.floor(rem / 60);
    const sec = rem % 60;
    reply += '\n⏱ ' + m + ':' + String(sec).padStart(2, '0') + ' left';
    return reply;
  }

  if (cls.kind === 'brief_question') {
    console.log('[bot] message kind=brief_question');
    console.log('[bot] brief_question deterministic=true');
    await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
    const events = buildOpenQuestionCrewEvents(match, locale);
    for (const ev of events) await matchStore.appendEvent(matchId, ev);
    const updated = await matchStore.getMatch(matchId);
    const captainBodyForBrief =
      stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) ||
      String(text || '').trim();
    let recentDisplay = dedupeDisplayLogs(toPlayerDisplayLogs(events, { locale }), locale);
    if (captainBodyForBrief) {
      recentDisplay = applyTargetedQuestionCaptainDisplayBody(recentDisplay, captainBodyForBrief, locale);
      recentDisplay = dedupeDisplayLogs(recentDisplay, locale);
    }
    const timer = ep1Engine.getTimerStatus(updated, now);
    const rem = Math.max(0, Math.floor(timer.remaining_sec ?? 0));
    let reply = recentDisplay.map((e) => e.type).filter(Boolean).join('\n') || '…';
    const m = Math.floor(rem / 60);
    const sec = rem % 60;
    reply += '\n⏱ ' + m + ':' + String(sec).padStart(2, '0') + ' left';
    return reply;
  }

  if (cls.kind === 'targeted_question') {
    console.log('[bot] message kind=targeted_question target=' + parsed.target);
  }

  const captainBodyForTq =
    cls.kind === 'targeted_question'
      ? stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) ||
        String(text || '').trim()
      : '';

  const action = {
    actor: 'captain',
    role: 'captain',
    action: parsed.intent_type,
    target: parsed.target
  };

  const result = await ep1Engine.applyAction(match, action, opts);
  if (!result.ok) {
    return 'Error: ' + (result.error || 'unknown');
  }

  await matchStore.updateMatch(matchId, {
    ...result.next_state,
    turn: (match.turn || 1) + 1
  });
  if (result.events && result.events.length > 0) {
    for (const ev of result.events) {
      await matchStore.appendEvent(matchId, ev);
    }
  }

  const updated = await matchStore.getMatch(matchId);
  let reply = result.summary || 'Captain acted.';
  const rem = result.remaining_sec ?? updated?.game_state?.remaining_sec;
  if (rem != null) {
    const m = Math.floor(rem / 60);
    const s = rem % 60;
    reply += '\n⏱ ' + m + ':' + String(s).padStart(2, '0') + ' left';
  }
  if (result.game_over && result.outcome) {
    log('GAME_OVER', 'ended', { playerId, matchId, outcome: result.outcome });
    reply += '\n\n[GAME OVER] ' + result.outcome;
  } else {
    log('ACTION', 'ok', { playerId, matchId, action: parsed.intent_type, target: parsed.target });
  }
  const isCheckLogMsg = String(parsed.intent_type || '').toLowerCase() === 'check_log';
  const deterministicLogs = dedupeDisplayLogs(
    toPlayerDisplayLogs(result.events || [], {
      captainInputLine: isCheckLogMsg ? String(text || '').trim() : '',
      locale
    }),
    locale
  );
  const clueEv = (result.events || []).find((e) => e && String(e.type).toUpperCase() === 'FIND_CLUE');
  const clueTextFromEvent = clueEv && clueEv.clue_text ? String(clueEv.clue_text) : undefined;
  const targetedNameQ =
    cls.kind === 'targeted_question' && isTargetedRoleNameQuestion(String(text || ''));
  if (targetedNameQ) {
    try {
      console.log('[bot][intent] targeted name question detected');
      console.log('[bot] targeted_name_question rules=true');
    } catch (e) {}
  }
  let recentDisplay = dedupeDisplayLogs(
    await maybeDialogueLogsFromLlmOrDeterministic({
      rawEvents: result.events || [],
      deterministicLogs,
      match: updated,
      playerText: String(text || '').trim(),
      clueTextFromEvent,
      locale,
      forcedCaptainTextOverride:
        cls.kind === 'targeted_question' && captainBodyForTq ? captainBodyForTq : undefined,
      targetedQuestionSideReactionRules: cls.kind === 'targeted_question',
      targetedNameQuestion: targetedNameQ
    }),
    locale
  );
  if (cls.kind === 'targeted_question') {
    if (captainBodyForTq) {
      recentDisplay = applyTargetedQuestionCaptainDisplayBody(recentDisplay, captainBodyForTq, locale);
    }
    recentDisplay = dedupeTargetedQuestionCaptainDisplayLogs(recentDisplay, locale);
    recentDisplay = collapseDuplicateCaptainBlocks(recentDisplay, locale);
    console.log('[bot] targeted_question removed_midstage_captain_override=true');
    console.log('[bot] targeted_question captain_display_source=final_only');
  }
  if (recentDisplay.length > 0) {
    reply += '\n\nRecent: ' + recentDisplay.map((e) => e.type).join(', ');
  }
  return reply;
}

/**
 * 메시지 라우팅 (텔레그램 메시지 또는 로컬 테스트)
 * @param {string} playerId
 * @param {string} text
 * @param {object} opts - { now?, game_total_sec? } 테스트용
 * @returns {Promise<string>}
 */
async function routeMessage(playerId, text, opts = {}) {
  const t = String(text || '').trim();
  log('ROUTE', 'in', { playerId, text: t.slice(0, 50) });
  if (t === '/start') {
    const r = await handleStart(playerId, opts);
    await dbPersistAfterTelegramStart(playerId);
    return r;
  }
  const reply = await handleTextMessage(playerId, t, opts);
  await dbPersistAfterTelegramTextMessage(playerId, t, opts, reply);
  return reply;
}

const CREW_IMPOSTOR_KEYS = new Set(['doctor', 'engineer', 'navigator', 'pilot']);
/** /api/state 폴링 시 동일 outcome+role 반복 로그 방지 */
let lastResultNormalizedLogSig = '';

function normalizeImpostorRoleKey(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s || s === 'unknown' || s === 'null' || s === 'undefined') return null;
  return CREW_IMPOSTOR_KEYS.has(s) ? s : null;
}

/**
 * 매치/상태에서 권위 있는 실제 임포스터 역할만 추출 (추측 없음).
 * 우선순위: explicit 필드들 → hidden_host_role(엔진 매치의 정식 비밀 역할).
 */
function pickAuthoritativeImpostorRole(match) {
  if (!match || typeof match !== 'object') return null;
  const candidates = [
    match.actual_imposter,
    match.actualImposter,
    match.impostor_role,
    match.impostorRole,
    match.impostor,
    match.true_impostor,
    match.trueImpostor,
    match.actual_imposter_role
  ];
  for (const c of candidates) {
    const n = normalizeImpostorRoleKey(c);
    if (n) return n;
  }
  return normalizeImpostorRoleKey(match.hidden_host_role);
}

/**
 * game_state.game_over === true 일 때만 actual_imposter / impostor_role 설정 (miniapp 공통 키).
 */
function attachActualImposterIfGameOverResult(ret, match) {
  if (!ret || !match) return;
  const gs = match.game_state || {};
  if (!gs.game_over) return;
  const role = pickAuthoritativeImpostorRole(match);
  if (!role) return;
  ret.actual_imposter = role;
  ret.impostor_role = role;
  const oc = gs.outcome || ret.outcome || 'unknown';
  const sig = String(match.match_id || '') + '|' + oc + '|' + role;
  if (sig !== lastResultNormalizedLogSig) {
    lastResultNormalizedLogSig = sig;
    console.log('[bot] RESULT_NORMALIZED outcome=' + oc + ' actual_imposter=' + role);
  }
}

/**
 * API용 /start 상태 반환
 * actual_imposter: game_over=true일 때만 권위 필드에서 정규화. game_over=false면 미포함.
 * @param {string} playerId
 * @param {object} opts - { restart?: boolean } restart=true면 새 매치 생성
 * @returns {Promise<object>}
 */
async function getStartStateApi(playerId, opts = {}) {
  if (opts.restart) {
    const player = await playerStore.getPlayer(playerId);
    if (player?.match_id) {
      await playerStore.setPlayer(playerId, {
        match_id: null,
        role: player.role || 'captain',
        joined_at: player.joined_at || new Date().toISOString()
      });
    }
  }
  let player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  const locale = opts.locale === 'en' ? 'en' : 'ko';

  let needNewMatch = !matchId;
  if (matchId) {
    const existingMatch = await matchStore.getMatch(matchId);
    if (existingMatch?.game_state?.game_over) needNewMatch = true;
  }
  if (needNewMatch) {
    const userKey = resolveUserKey(playerId, null);
    const ticket = await consumeDailyTicketIfAllowed(userKey, { locale });
    if (!ticket.allowed) {
      return buildEntitlementBlockedResponse(locale, 'daily_ticket_limit_reached', ticket.entitlement, {
        match_id: null,
        remaining_sec: 0,
        game_state: null,
        deadline_at: null,
        events: []
      });
    }
    const matchNew = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = matchNew.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  const match = await matchStore.getMatch(matchId);
  const timer = ep1Engine.getTimerStatus ? ep1Engine.getTimerStatus(match) : { remaining_sec: 420 };
  const gs = match?.game_state || {};
  let displayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(match?.events || [], { locale }), locale);
  displayLogs = ensureInitialSystemDisplayLogs(displayLogs, match, locale);
  const out = {
    ok: true,
    match_id: matchId,
    remaining_sec: timer.remaining_sec ?? 420,
    game_state: gs,
    deadline_at: match?.deadline_at,
    events: displayLogs
  };
  if (gs.game_over) {
    attachActualImposterIfGameOverResult(out, match);
    const evs = match?.events || [];
    if (evs.some((e) => e && e.type === 'TIMEOUT')) out.is_timeout = true;
  }
  await dbPersistAfterStartState(playerId, locale, out);
  await enrichResultWithEntitlement(out, playerId);
  return out;
}

/**
 * API용 메시지 처리 (구조화된 결과 반환)
 * actual_imposter: game_over=true일 때만 권위 필드에서 정규화. game_over=false면 미포함.
 * @param {string} playerId
 * @param {string} text
 * @param {object} opts - { now? }
 * @returns {Promise<object>}
 */
async function processMessageApi(playerId, text, opts = {}) {
  const locale = opts.locale === 'en' ? 'en' : 'ko';
  let player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  if (!matchId) {
    const userKey = resolveUserKey(playerId, null);
    const ticket = await consumeDailyTicketIfAllowed(userKey, { locale });
    if (!ticket.allowed) {
      return buildEntitlementBlockedResponse(locale, 'daily_ticket_limit_reached', ticket.entitlement, {
        remaining_sec: 0,
        game_over: false,
        outcome: null,
        events: [],
        recent_events: [],
        match_state: {}
      });
    }
    const match0 = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match0.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  const match = await matchStore.getMatch(matchId);
  if (!match) return { ok: false, error: 'Match not found' };

  const parsed = applyQuestionLikeIntentGuard(text, intentParser.parse(text));
  const cls = classifyMiniappFreeText(text, parsed);
  const now = opts.now;

  if (cls.kind === 'state_query') {
    const timer = ep1Engine.getTimerStatus(match, now);
    const rem = Math.max(0, Math.floor(timer.remaining_sec ?? 0));
    const gs = match.game_state || {};
    const isOver = !!gs.game_over;
    const logRem = cls.subtype === 'remaining_time' ? (isOver ? 0 : rem) : rem;
    console.log(
      '[bot] message kind=state_query subtype=' + cls.subtype + ' remaining_sec=' + logRem
    );
    const line = buildStateQueryDialogueLine(match, cls.subtype, locale, now);
    const rawEvents = [{ type: 'CREW_DIALOGUE', role: 'system', dialogue: line }];
    const newDisplayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(rawEvents, { locale }), locale);
    const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
    const ret = {
      ok: true,
      summary: summaryText,
      remaining_sec: isOver ? 0 : rem,
      game_over: isOver,
      outcome: isOver ? gs.outcome : null,
      events: newDisplayLogs,
      recent_events: newDisplayLogs,
      match_state: { ...gs }
    };
    if (isOver) {
      attachActualImposterIfGameOverResult(ret, match);
      const evs = match?.events || [];
      if (evs.some((e) => e && e.type === 'TIMEOUT')) ret.is_timeout = true;
    }
    return ret;
  }

  if (match.game_state?.game_over) {
    const ret = {
      ok: true,
      summary:
        locale === 'en'
          ? `Game over. Outcome: ${match.game_state.outcome || 'unknown'}`
          : `게임 종료. 결과: ${match.game_state.outcome || 'unknown'}`,
      game_over: true,
      outcome: match.game_state.outcome,
      remaining_sec: 0,
      events: [],
      match_state: { ...match.game_state }
    };
    attachActualImposterIfGameOverResult(ret, match);
    const evs = match?.events || [];
    if (evs.some((e) => e && e.type === 'TIMEOUT')) ret.is_timeout = true;
    return ret;
  }

  const consumesFreePromptApi = shouldConsumeFreePromptForMessageKind(cls, parsed, text);
  logIntentPromptDecision(cls, parsed, consumesFreePromptApi);
  if (consumesFreePromptApi) {
    const userKey = resolveUserKey(playerId, matchId);
    const pr = await consumeFreePromptIfAllowed(userKey, { locale });
    if (!pr.allowed) {
      const timer = ep1Engine.getTimerStatus(match, now);
      const rem = Math.max(0, Math.floor(timer.remaining_sec ?? 0));
      return buildEntitlementBlockedResponse(locale, 'daily_free_prompt_limit_reached', pr.entitlement, {
        remaining_sec: rem,
        game_over: false,
        outcome: null,
        events: [],
        recent_events: [],
        match_state: { ...match.game_state }
      });
    }
  }

  if (cls.kind === 'role_opinion_question') {
    console.log('[bot] message kind=role_opinion_question target=' + parsed.target);
    await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
    const events = buildRoleOpinionQuestionEvents(match, parsed.target, locale);
    for (const ev of events) await matchStore.appendEvent(matchId, ev);
    const updated = await matchStore.getMatch(matchId);
    const captainBodyForRoleOpinion =
      stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) ||
      String(text || '').trim();
    let newDisplayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(events, { locale }), locale);
    const firstEv = events[0];
    const isErrorRoleOpinion = firstEv && String(firstEv.role || '').toLowerCase() === 'system';
    if (captainBodyForRoleOpinion && !isErrorRoleOpinion) {
      newDisplayLogs = applyTargetedQuestionCaptainDisplayBody(newDisplayLogs, captainBodyForRoleOpinion, locale);
      newDisplayLogs = dedupeDisplayLogs(newDisplayLogs, locale);
      console.log('[bot] role_opinion_question captain_display_source=final_only');
      console.log('[bot] role_opinion_question captain_body_preserved=true');
    }
    const timerRo = ep1Engine.getTimerStatus(updated, now);
    const rem = Math.max(0, Math.floor(timerRo.remaining_sec ?? 0));
    const gsToneRo = updated?.game_state || {};
    if (!isErrorRoleOpinion) {
      newDisplayLogs = applyCharacterToneToDisplayLogs(newDisplayLogs, locale, {
        playerText: String(text || ''),
        crewPersonalNames: updated?.game_state?.crew_names || null,
        remainingSec: rem,
        deadRolesCount: Array.isArray(gsToneRo.dead_roles) ? gsToneRo.dead_roles.length : 0,
        gameOver: !!gsToneRo.game_over
      });
    }
    const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
    return {
      ok: true,
      summary: summaryText,
      remaining_sec: rem,
      game_over: false,
      outcome: null,
      events: newDisplayLogs,
      recent_events: newDisplayLogs,
      match_state: updated?.game_state || {}
    };
  }

  if (cls.kind === 'group_question') {
    const sub = cls.groupSubkind || 'suspicion';
    console.log('[bot] message kind=group_question sub=' + sub);
    await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
    if (sub === 'name') await ensureCrewPersonalNamesPersisted(matchId);
    const matchAfterNames = sub === 'name' ? await matchStore.getMatch(matchId) : match;
    const events = resolveGroupCrewEvents(matchAfterNames || match, locale, sub);
    for (const ev of events) await matchStore.appendEvent(matchId, ev);
    const updated = await matchStore.getMatch(matchId);
    const captainBodyForGroup =
      stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) ||
      String(text || '').trim();
    let newDisplayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(events, { locale }), locale);
    if (captainBodyForGroup) {
      newDisplayLogs = applyTargetedQuestionCaptainDisplayBody(newDisplayLogs, captainBodyForGroup, locale);
      newDisplayLogs = dedupeDisplayLogs(newDisplayLogs, locale);
    }
    const timer = ep1Engine.getTimerStatus(updated, now);
    const rem = Math.max(0, Math.floor(timer.remaining_sec ?? 0));
    const gsToneG = updated?.game_state || {};
    newDisplayLogs = applyCharacterToneToDisplayLogs(newDisplayLogs, locale, {
      playerText: String(text || ''),
      crewPersonalNames: updated?.game_state?.crew_names || null,
      remainingSec: rem,
      deadRolesCount: Array.isArray(gsToneG.dead_roles) ? gsToneG.dead_roles.length : 0,
      gameOver: !!gsToneG.game_over
    });
    const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
    return {
      ok: true,
      summary: summaryText,
      remaining_sec: rem,
      game_over: false,
      outcome: null,
      events: newDisplayLogs,
      recent_events: newDisplayLogs,
      match_state: updated?.game_state || {}
    };
  }

  if (cls.kind === 'suspicion_question') {
    console.log('[bot] message kind=suspicion_question');
    await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
    const events = buildOpenQuestionCrewEvents(match, locale);
    for (const ev of events) await matchStore.appendEvent(matchId, ev);
    const updated = await matchStore.getMatch(matchId);
    const captainBodyForSusp =
      stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) ||
      String(text || '').trim();
    let newDisplayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(events, { locale }), locale);
    if (captainBodyForSusp) {
      newDisplayLogs = applyTargetedQuestionCaptainDisplayBody(newDisplayLogs, captainBodyForSusp, locale);
      newDisplayLogs = dedupeDisplayLogs(newDisplayLogs, locale);
    }
    const timerSq = ep1Engine.getTimerStatus(updated, now);
    const rem = Math.max(0, Math.floor(timerSq.remaining_sec ?? 0));
    const gsToneSq = updated?.game_state || {};
    newDisplayLogs = applyCharacterToneToDisplayLogs(newDisplayLogs, locale, {
      playerText: String(text || ''),
      crewPersonalNames: updated?.game_state?.crew_names || null,
      remainingSec: rem,
      deadRolesCount: Array.isArray(gsToneSq.dead_roles) ? gsToneSq.dead_roles.length : 0,
      gameOver: !!gsToneSq.game_over
    });
    const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
    return {
      ok: true,
      summary: summaryText,
      remaining_sec: rem,
      game_over: false,
      outcome: null,
      events: newDisplayLogs,
      recent_events: newDisplayLogs,
      match_state: updated?.game_state || {}
    };
  }

  if (cls.kind === 'lore_question') {
    console.log('[bot] message kind=lore_question');
    const gateApi = evaluateLoreUnknownTermGate('lore_question', String(text || ''), locale);
    if (gateApi.block) {
      await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
      const lineUnk = buildUnknownLoreTermSystemLine(locale, gateApi.term);
      const rawEvUnk = [{ type: 'CREW_DIALOGUE', role: 'system', dialogue: lineUnk }];
      const newDisplayLogsUnk = dedupeDisplayLogs(toPlayerDisplayLogs(rawEvUnk, { locale }), locale);
      const toStoreUnk = displayLogsToCrewDialogueEvents(newDisplayLogsUnk, locale);
      for (const ev of toStoreUnk) await matchStore.appendEvent(matchId, ev);
      const updatedUnk = await matchStore.getMatch(matchId);
      const timerUnk = ep1Engine.getTimerStatus(updatedUnk, now);
      const remUnk = Math.max(0, Math.floor(timerUnk.remaining_sec ?? 0));
      const summaryTextUnk = summaryFromDisplayLogs(newDisplayLogsUnk, locale);
      return {
        ok: true,
        summary: summaryTextUnk,
        remaining_sec: remUnk,
        game_over: false,
        outcome: null,
        events: newDisplayLogsUnk,
        recent_events: newDisplayLogsUnk,
        match_state: updatedUnk?.game_state || {}
      };
    }
    await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
    const matchForLlm = await matchStore.getMatch(matchId);
    const captainBodyForLore =
      stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) ||
      String(text || '').trim();
    const loreTopic = detectLoreQuestionTopic(String(text || ''), locale);
    console.log('[bot] lore_question topic=' + loreTopic + ' locale=' + locale);
    console.log('[bot] lore_question canon_anchor_applied=true');
    const rawEvents = [{ type: 'LORE_QUESTION' }];
    const deterministicFallback = buildLoreQuestionDeterministicFallbackEvents(
      matchForLlm,
      locale,
      captainBodyForLore,
      loreTopic
    );
    const deterministicLogs = dedupeDisplayLogs(
      toPlayerDisplayLogs(deterministicFallback, { locale }),
      locale
    );
    const loreCanonSnippet = getLoreTopicSnippet(loreTopic, locale);
    let newDisplayLogs = dedupeDisplayLogs(
      await maybeDialogueLogsFromLlmOrDeterministic({
        rawEvents,
        deterministicLogs,
        match: matchForLlm,
        playerText: String(text || '').trim(),
        clueTextFromEvent: undefined,
        locale,
        forcedCaptainTextOverride: captainBodyForLore,
        targetedQuestionSideReactionRules: false,
        loreQuestionTopic: loreTopic,
        loreCanonAnchorText: loreCanonSnippet
      }),
      locale
    );
    if (captainBodyForLore) {
      newDisplayLogs = applyTargetedQuestionCaptainDisplayBody(newDisplayLogs, captainBodyForLore, locale);
      newDisplayLogs = dedupeDisplayLogs(newDisplayLogs, locale);
      console.log('[bot] lore_question captain_body_preserved=true');
    }
    const toStore = displayLogsToCrewDialogueEvents(newDisplayLogs, locale);
    for (const ev of toStore) await matchStore.appendEvent(matchId, ev);
    const updated = await matchStore.getMatch(matchId);
    const timer = ep1Engine.getTimerStatus(updated, now);
    const rem = Math.max(0, Math.floor(timer.remaining_sec ?? 0));
    const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
    return {
      ok: true,
      summary: summaryText,
      remaining_sec: rem,
      game_over: false,
      outcome: null,
      events: newDisplayLogs,
      recent_events: newDisplayLogs,
      match_state: updated?.game_state || {}
    };
  }

  if (cls.kind === 'brief_question') {
    console.log('[bot] message kind=brief_question');
    console.log('[bot] brief_question deterministic=true');
    await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
    const events = buildOpenQuestionCrewEvents(match, locale);
    for (const ev of events) await matchStore.appendEvent(matchId, ev);
    const updated = await matchStore.getMatch(matchId);
    const captainBodyForBrief =
      stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) ||
      String(text || '').trim();
    let newDisplayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(events, { locale }), locale);
    if (captainBodyForBrief) {
      newDisplayLogs = applyTargetedQuestionCaptainDisplayBody(newDisplayLogs, captainBodyForBrief, locale);
      newDisplayLogs = dedupeDisplayLogs(newDisplayLogs, locale);
    }
    const timer = ep1Engine.getTimerStatus(updated, now);
    const rem = Math.max(0, Math.floor(timer.remaining_sec ?? 0));
    const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
    return {
      ok: true,
      summary: summaryText,
      remaining_sec: rem,
      game_over: false,
      outcome: null,
      events: newDisplayLogs,
      recent_events: newDisplayLogs,
      match_state: updated?.game_state || {}
    };
  }

  if (cls.kind === 'targeted_question') {
    console.log('[bot] message kind=targeted_question target=' + parsed.target);
  }

  const captainBodyForTq =
    cls.kind === 'targeted_question'
      ? stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) ||
        String(text || '').trim()
      : '';

  const action = { actor: 'captain', role: 'captain', action: parsed.intent_type, target: parsed.target };
  const result = await ep1Engine.applyAction(match, action, opts);
  if (!result.ok) return { ok: false, error: result.error || 'unknown' };

  await matchStore.updateMatch(matchId, { ...result.next_state, turn: (match.turn || 1) + 1 });
  if (result.events?.length > 0) {
    for (const ev of result.events) await matchStore.appendEvent(matchId, ev);
  }

  const updated = await matchStore.getMatch(matchId);
  const gameOver = result.game_over || updated?.game_state?.game_over;
  const isCheckLogMsg = String(parsed.intent_type || '').toLowerCase() === 'check_log';
  const deterministicLogs = dedupeDisplayLogs(
    toPlayerDisplayLogs(result.events || [], {
      captainInputLine: isCheckLogMsg ? String(text || '').trim() : '',
      locale
    }),
    locale
  );
  const clueEv = (result.events || []).find((e) => e && String(e.type).toUpperCase() === 'FIND_CLUE');
  const clueTextFromEvent = clueEv && clueEv.clue_text ? String(clueEv.clue_text) : undefined;
  const targetedNameQ =
    cls.kind === 'targeted_question' && isTargetedRoleNameQuestion(String(text || ''));
  if (targetedNameQ) {
    try {
      console.log('[bot][intent] targeted name question detected');
      console.log('[bot] targeted_name_question rules=true');
    } catch (e) {}
  }
  let newDisplayLogs = dedupeDisplayLogs(
    await maybeDialogueLogsFromLlmOrDeterministic({
      rawEvents: result.events || [],
      deterministicLogs,
      match: updated,
      playerText: String(text || '').trim(),
      clueTextFromEvent,
      locale,
      forcedCaptainTextOverride:
        cls.kind === 'targeted_question' && captainBodyForTq ? captainBodyForTq : undefined,
      targetedQuestionSideReactionRules: cls.kind === 'targeted_question',
      targetedNameQuestion: targetedNameQ
    }),
    locale
  );
  if (cls.kind === 'targeted_question') {
    if (captainBodyForTq) {
      newDisplayLogs = applyTargetedQuestionCaptainDisplayBody(newDisplayLogs, captainBodyForTq, locale);
    }
    newDisplayLogs = dedupeTargetedQuestionCaptainDisplayLogs(newDisplayLogs, locale);
    newDisplayLogs = collapseDuplicateCaptainBlocks(newDisplayLogs, locale);
    console.log('[bot] targeted_question removed_midstage_captain_override=true');
    console.log('[bot] targeted_question captain_display_source=final_only');
  }
  const updatedAfterDialogue = await matchStore.getMatch(matchId);
  const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
  const recentEvents = newDisplayLogs;
  const ret = {
    ok: true,
    summary: summaryText,
    remaining_sec: result.remaining_sec ?? 0,
    game_over: gameOver || false,
    outcome: result.outcome || null,
    events: newDisplayLogs,
    recent_events: recentEvents,
    match_state: updatedAfterDialogue?.game_state || updated?.game_state || {}
  };
  if (gameOver) {
    attachActualImposterIfGameOverResult(ret, updated);
    const evs = result.events || updated?.events || [];
    if (evs.some((e) => e && e.type === 'TIMEOUT')) ret.is_timeout = true;
  }
  return ret;
}

const ACCUSE_API_TARGETS = new Set(['doctor', 'engineer', 'navigator', 'pilot']);

/**
 * 처형 확정 전용 API — intentParser/텍스트 없이 ep1Engine에 action: accuse 직접 전달.
 * 응답 형태는 processMessageApi와 동일하게 맞춤.
 * @param {string} playerId
 * @param {string} targetRaw - doctor | engineer | navigator | pilot
 * @param {object} opts - { now? }
 * @returns {Promise<object>}
 */
async function processAccuseApi(playerId, targetRaw, opts = {}) {
  const locale = opts.locale === 'en' ? 'en' : 'ko';
  const target = String(targetRaw || '').toLowerCase().trim();
  if (!ACCUSE_API_TARGETS.has(target)) {
    return { ok: false, error: 'Invalid target' };
  }

  let player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  if (!matchId) {
    const userKey = resolveUserKey(playerId, null);
    const ticket = await consumeDailyTicketIfAllowed(userKey, { locale });
    if (!ticket.allowed) {
      return buildEntitlementBlockedResponse(locale, 'daily_ticket_limit_reached', ticket.entitlement, {
        remaining_sec: 0,
        game_over: false,
        outcome: null,
        events: [],
        recent_events: [],
        match_state: {}
      });
    }
    const match0 = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match0.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  const match = await matchStore.getMatch(matchId);
  if (!match) return { ok: false, error: 'Match not found' };

  if (match.game_state?.game_over) {
    const ret = {
      ok: true,
      summary:
        locale === 'en'
          ? `Game over. Outcome: ${match.game_state.outcome || 'unknown'}`
          : `게임 종료. 결과: ${match.game_state.outcome || 'unknown'}`,
      game_over: true,
      outcome: match.game_state.outcome,
      remaining_sec: 0,
      events: [],
      recent_events: [],
      match_state: { ...match.game_state }
    };
    attachActualImposterIfGameOverResult(ret, match);
    const evs = match?.events || [];
    if (evs.some((e) => e && e.type === 'TIMEOUT')) ret.is_timeout = true;
    return ret;
  }

  const action = { actor: 'captain', role: 'captain', action: 'accuse', target };
  const result = await ep1Engine.applyAction(match, action, opts);
  if (!result.ok) return { ok: false, error: result.error || 'unknown' };

  await matchStore.updateMatch(matchId, { ...result.next_state, turn: (match.turn || 1) + 1 });
  if (result.events?.length > 0) {
    for (const ev of result.events) await matchStore.appendEvent(matchId, ev);
  }

  const updated = await matchStore.getMatch(matchId);
  const gameOver = result.game_over || updated?.game_state?.game_over;
  const newDisplayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(result.events || [], { locale }), locale);
  const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
  const recentEvents = newDisplayLogs;
  const ret = {
    ok: true,
    summary: summaryText,
    remaining_sec: result.remaining_sec ?? 0,
    game_over: gameOver || false,
    outcome: result.outcome || null,
    events: newDisplayLogs,
    recent_events: recentEvents,
    match_state: updated?.game_state || {}
  };
  if (gameOver) {
    attachActualImposterIfGameOverResult(ret, updated);
    const evs = result.events || updated?.events || [];
    if (evs.some((e) => e && e.type === 'TIMEOUT')) ret.is_timeout = true;
  }
  return ret;
}

/**
 * 명시적 액션 API — 텍스트/intentParser 없이 ep1Engine에 직접 전달.
 * take_pistol / collect_clue → 엔진 TAKE_PISTOL / FIND_CLUE 분기.
 * 응답 형태는 processMessageApi / processAccuseApi와 동일.
 * @param {string} playerId
 * @param {string} actionRaw - e.g. take_pistol | collect_clue | threaten (+ target)
 * @param {string} [targetRaw] - optional
 * @param {object} [opts] - { now? }
 * @returns {Promise<object>}
 */
async function processActionApi(playerId, actionRaw, targetRaw, opts = {}) {
  const locale = opts.locale === 'en' ? 'en' : 'ko';
  const actionKey = String(actionRaw || '').toLowerCase().trim();
  const actionPayloadByKey = {
    take_pistol: { actor: 'captain', role: 'captain', action: 'take_pistol' },
    collect_clue: { actor: 'captain', role: 'captain', action: 'collect_clue' },
    threaten: { actor: 'captain', role: 'captain', action: 'threaten' }
  };
  if (!actionPayloadByKey[actionKey]) {
    return { ok: false, error: 'Unsupported action' };
  }

  if (actionKey === 'threaten') {
    const t = String(targetRaw || '').toLowerCase().trim();
    if (!ACCUSE_API_TARGETS.has(t)) {
      return { ok: false, error: 'target required (doctor|engineer|navigator|pilot)' };
    }
  }

  let player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  if (!matchId) {
    const userKey = resolveUserKey(playerId, null);
    const ticket = await consumeDailyTicketIfAllowed(userKey, { locale });
    if (!ticket.allowed) {
      return buildEntitlementBlockedResponse(locale, 'daily_ticket_limit_reached', ticket.entitlement, {
        remaining_sec: 0,
        game_over: false,
        outcome: null,
        events: [],
        recent_events: [],
        match_state: {}
      });
    }
    const match0 = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match0.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  const match = await matchStore.getMatch(matchId);
  if (!match) return { ok: false, error: 'Match not found' };

  if (match.game_state?.game_over) {
    const ret = {
      ok: true,
      summary:
        locale === 'en'
          ? `Game over. Outcome: ${match.game_state.outcome || 'unknown'}`
          : `게임 종료. 결과: ${match.game_state.outcome || 'unknown'}`,
      game_over: true,
      outcome: match.game_state.outcome,
      remaining_sec: 0,
      events: [],
      recent_events: [],
      match_state: { ...match.game_state }
    };
    attachActualImposterIfGameOverResult(ret, match);
    const evs = match?.events || [];
    if (evs.some((e) => e && e.type === 'TIMEOUT')) ret.is_timeout = true;
    return ret;
  }

  const action = { ...actionPayloadByKey[actionKey] };
  if (targetRaw != null && String(targetRaw).trim() !== '') {
    action.target = String(targetRaw).toLowerCase().trim();
  }
  const result = await ep1Engine.applyAction(match, action, opts);
  if (!result.ok) return { ok: false, error: result.error || 'unknown' };

  await matchStore.updateMatch(matchId, { ...result.next_state, turn: (match.turn || 1) + 1 });
  if (result.events?.length > 0) {
    for (const ev of result.events) await matchStore.appendEvent(matchId, ev);
  }

  const updated = await matchStore.getMatch(matchId);
  const gameOver = result.game_over || updated?.game_state?.game_over;
  const deterministicLogs = dedupeDisplayLogs(toPlayerDisplayLogs(result.events || [], { locale }), locale);
  const clueEv = (result.events || []).find((e) => e && String(e.type).toUpperCase() === 'FIND_CLUE');
  const clueTextFromEvent = clueEv && clueEv.clue_text ? String(clueEv.clue_text) : undefined;
  const actionHint =
    actionKey === 'threaten'
      ? locale === 'en'
        ? `[threaten action] target=${String(targetRaw || '').toLowerCase()}`
        : `[위협 action] target=${String(targetRaw || '').toLowerCase()}`
      : actionKey === 'take_pistol'
        ? locale === 'en'
          ? `[take_pistol action]`
          : `[권총 획득 action]`
        : locale === 'en'
          ? `[collect_clue action]`
          : `[단서수집 action]`;
  const newDisplayLogs = dedupeDisplayLogs(
    await maybeDialogueLogsFromLlmOrDeterministic({
      rawEvents: result.events || [],
      deterministicLogs,
      match: updated,
      playerText: actionHint,
      clueTextFromEvent,
      locale
    }),
    locale
  );
  const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
  const recentEvents = newDisplayLogs;
  const ret = {
    ok: true,
    summary: summaryText,
    remaining_sec: result.remaining_sec ?? 0,
    game_over: gameOver || false,
    outcome: result.outcome || null,
    events: newDisplayLogs,
    recent_events: recentEvents,
    match_state: updated?.game_state || {}
  };
  if (gameOver) {
    attachActualImposterIfGameOverResult(ret, updated);
    const evs = result.events || updated?.events || [];
    if (evs.some((e) => e && e.type === 'TIMEOUT')) ret.is_timeout = true;
  }
  return ret;
}

function getGameTotalSecFromMatch(match) {
  if (match?.deadline_at && match?.started_at) {
    const start = new Date(match.started_at);
    const deadline = new Date(match.deadline_at);
    return Math.floor((deadline - start) / 1000);
  }
  return ep1Engine.GAME_TOTAL_SEC || 420;
}

/**
 * /api/state 폴링 시 실제 시각 기준으로 timeout·auto-kill 반영 (ep1Engine.applyAction 동일 규칙: timers + kills + winlose).
 * triggered_kill_marks로 구간 중복 발동 방지. 이벤트는 appendEvent로만 추가.
 * @returns {Promise<object[]>} 이번 틱에서 새로 추가된 raw 이벤트
 */
async function applyMatchClockTick(matchId) {
  const now = new Date();
  const deltaRaw = [];
  const maxSteps = 24;
  for (let step = 0; step < maxSteps; step++) {
    const match = await matchStore.getMatch(matchId);
    if (!match || match.game_state?.game_over) break;

    const gs = match.game_state || {};
    const impostorRole = match.hidden_host_role ?? match.impostor_role;
    const totalSec = getGameTotalSecFromMatch(match);
    const startedAt = match.started_at || new Date().toISOString();
    const { remaining_sec } = timers.computeDeadline(totalSec, startedAt, now);

    if (timers.isExpired(totalSec, startedAt, now)) {
      const result = winlose.resolveOutcome({ remainingSec: 0 });
      const nextGs = { ...gs, game_over: true, outcome: result.outcome };
      const ev = { type: 'TIMEOUT' };
      await matchStore.appendEvent(matchId, ev);
      deltaRaw.push(ev);
      await matchStore.updateMatch(matchId, {
        game_state: nextGs,
        turn: (match.turn || 1) + 1
      });
      break;
    }

    const killResult = kills.checkAutoKill(
      gs.dead_roles || [],
      impostorRole,
      remaining_sec,
      gs.triggered_kill_marks || []
    );
    if (!killResult.shouldKill || !killResult.victimRole) break;

    const nextDead = [...(gs.dead_roles || []), killResult.victimRole];
    const nextMarks = [...(gs.triggered_kill_marks || []), killResult.mark].filter(Boolean);
    const outcome =
      nextDead.length >= 4
        ? winlose.resolveOutcome({
            deadRoles: nextDead,
            impostorRole,
            remainingSec: remaining_sec
          }).outcome
        : null;
    const nextGs = {
      ...gs,
      dead_roles: nextDead,
      triggered_kill_marks: nextMarks,
      ...(outcome ? { game_over: true, outcome } : {})
    };
    const zone = kills.getDeathZone(killResult.victimRole);
    const ev = { type: 'DEATH', role: killResult.victimRole, zone, reason: 'auto_kill' };
    await matchStore.appendEvent(matchId, ev);
    deltaRaw.push(ev);
    await matchStore.updateMatch(matchId, {
      game_state: nextGs,
      turn: (match.turn || 1) + 1
    });
    if (outcome) break;
  }
  return deltaRaw;
}

/**
 * 봇 초기화 (텔레그램 SDK 연결 시 사용)
 */
function initBot() {
  if (!BOT_TOKEN) {
    console.warn('[bot] TELEGRAM_BOT_TOKEN not set. Use routeMessage(playerId, text) for local test.');
    return null;
  }
  console.log('[bot] Telegram bot ready (SDK not connected). Use routeMessage for test.');
  return {};
}

/**
 * Webhook 모드 (Express 연동 시)
 */
async function handleWebhook(req, res) {
  const body = req.body || {};
  const msg = body.message;
  if (!msg) {
    res.status(200).send();
    return;
  }
  const chatId = msg.chat?.id;
  const text = msg.text || '';
  const playerId = String(msg.from?.id || chatId);
  try {
    const reply = await routeMessage(playerId, text);
    if (BOT_TOKEN && chatId) {
      res.status(200).json({ ok: true });
    } else {
      res.status(200).json({ reply });
    }
  } catch (err) {
    console.error('[bot]', err);
    res.status(500).json({ ok: false, error: String(err.message) });
  }
}

/**
 * 로컬 개발용 HTTP API 서버 (포트 8788)
 * TELEGRAM_BOT_TOKEN 없어도 실행됨.
 * CORS 공통: 비-OPTIONS 요청마다 applyApiCorsHeaders → /api/start|state|message|action|accuse·기타 동일 헤더.
 * OPTIONS 는 204 + buildApiCorsHeaders 후 즉시 종료.
 * miniapp·loca.lt·Vercel 등 cross-origin + credentials 미사용 시 Allow-Origin: *
 * Preflight: Access-Control-Request-Headers 가 오면 그 값을 Allow-Headers에 반영 (브라우저 요구).
 */
function allowHeadersForCors(req) {
  const raw = req.headers['access-control-request-headers'];
  if (raw != null && String(raw).trim() !== '') {
    return String(raw).trim();
  }
  return [
    'Content-Type',
    'Accept',
    'Accept-Language',
    'Authorization',
    'X-Requested-With',
    'Origin',
    'Cache-Control',
    'Pragma',
    'DNT',
    'User-Agent',
    'Referer',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform'
  ].join(', ');
}

function buildApiCorsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': allowHeadersForCors(req),
    'Access-Control-Max-Age': '86400'
  };
}

function applyApiCorsHeaders(res, req) {
  Object.entries(buildApiCorsHeaders(req)).forEach(([k, v]) => res.setHeader(k, v));
}

function createLocalApiServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'OPTIONS') {
      const origin = req.headers.origin || '(no origin)';
      console.log('[bot] CORS preflight handled path=' + url.pathname + ' origin=' + origin);
      res.writeHead(204, buildApiCorsHeaders(req));
      res.end();
      return;
    }

    applyApiCorsHeaders(res, req);
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      console.log(
        '[bot] CORS applied path=' +
          url.pathname +
          ' origin=' +
          (req.headers.origin || '(no origin)')
      );
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    await new Promise((resolve) => req.on('end', resolve));
    const route = url.pathname;

    try {
      if ((route === '/' || route === '/miniapp' || route === '/index.html') && req.method === 'GET') {
        const miniappPath = path.join(__dirname, '..', 'miniapp', 'index.html');
        const html = fs.readFileSync(miniappPath, 'utf8');
        res.setHeader('Content-Type', 'text/html');
        res.writeHead(200);
        res.end(html);
        return;
      }

      if (route === '/health' && req.method === 'GET') {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, service: 'telegram-bot-local-api' }));
        return;
      }

      if (route === '/api/start' && req.method === 'POST') {
        const data = body ? JSON.parse(body) : {};
        const playerId = data.playerId || 'miniapp_' + Date.now();
        const restart = !!data.restart;
        const locale = resolveRequestLocale(data, url.searchParams, req.headers);
        console.log('[bot] LOCALE_RESOLVED locale=' + locale + ' action=start');
        const pre = await playerStore.getPlayer(playerId);
        console.log(
          '[bot] api action=start match_id=' + String(pre?.match_id || '') + ' playerId=' + String(playerId)
        );
        const state = await getStartStateApi(playerId, { restart, locale });
        console.log(
          '[bot] api action complete ok=' +
            String(state?.ok !== false) +
            ' match_id=' +
            String(state?.match_id || '')
        );
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, playerId, ...state }));
        return;
      }

      // Future: merge optional DB match_sessions snapshot here; today matchStore + applyMatchClockTick only.
      if (route === '/api/state' && req.method === 'GET') {
        const playerId = url.searchParams.get('playerId');
        if (!playerId) {
          console.log('[bot] api action=state match_id= playerId=(missing)');
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'playerId required' }));
          return;
        }
        const locale = resolveRequestLocale({}, url.searchParams, req.headers);
        console.log('[bot] LOCALE_RESOLVED locale=' + locale + ' action=state');
        const player = await playerStore.getPlayer(playerId);
        const matchId = player?.match_id;
        console.log(
          '[bot] api action=state match_id=' + String(matchId || '') + ' playerId=' + String(playerId)
        );
        if (!matchId) {
          console.log('[bot] api action complete ok=true match_id=');
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, match_id: null, game_state: null }));
          return;
        }
        let match = await matchStore.getMatch(matchId);
        if (!match) {
          console.log('[bot] api action complete ok=true match_id=');
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, match_id: null, game_state: null }));
          return;
        }
        const deltaRaw = await applyMatchClockTick(matchId);
        match = await matchStore.getMatch(matchId);
        const timer = ep1Engine.getTimerStatus(match, new Date());
        const gs = match?.game_state || {};
        let displayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(match?.events || [], { locale }), locale);
        displayLogs = ensureInitialSystemDisplayLogs(displayLogs, match, locale);
        const recentDisplay = dedupeDisplayLogs(toPlayerDisplayLogs(deltaRaw, { locale }), locale);
        const statePayload = {
          ok: true,
          match_id: matchId,
          remaining_sec: timer.remaining_sec ?? 0,
          game_state: gs,
          match_state: gs,
          events: displayLogs,
          recent_events: recentDisplay,
          game_over: !!gs.game_over
        };
        if (gs.game_over) {
          attachActualImposterIfGameOverResult(statePayload, match);
          const evs = match?.events || [];
          if (evs.some((e) => e && e.type === 'TIMEOUT')) statePayload.is_timeout = true;
        }
        console.log('[bot] api action complete ok=true match_id=' + String(matchId));
        res.writeHead(200);
        res.end(JSON.stringify(statePayload));
        return;
      }

      if (route === '/api/message' && req.method === 'POST') {
        const data = body ? JSON.parse(body) : {};
        const playerId = data.playerId;
        const text = data.text || '';
        const locale = resolveRequestLocale(data, url.searchParams, req.headers);
        console.log('[bot] LOCALE_RESOLVED locale=' + locale + ' action=message');
        if (!playerId) {
          console.log('[bot] api action=message match_id= playerId=(missing)');
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'playerId required' }));
          return;
        }
        const preMsg = await playerStore.getPlayer(playerId);
        console.log(
          '[bot] api action=message match_id=' + String(preMsg?.match_id || '') + ' playerId=' + String(playerId)
        );
        const result = await processMessageApi(playerId, text, { locale });
        await enrichResultWithEntitlement(result, playerId);
        await dbPersistAfterMessageResult(playerId, locale, text, result);
        const postMsg = await playerStore.getPlayer(playerId);
        console.log(
          '[bot] api action complete ok=' +
            String(!!result?.ok) +
            ' match_id=' +
            String(postMsg?.match_id || '')
        );
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (route === '/api/accuse' && req.method === 'POST') {
        const data = body ? JSON.parse(body) : {};
        const playerId = data.playerId;
        const target = data.target;
        const locale = resolveRequestLocale(data, url.searchParams, req.headers);
        console.log('[bot] LOCALE_RESOLVED locale=' + locale + ' action=accuse');
        if (!playerId) {
          console.log('[bot] api action=accuse match_id= playerId=(missing)');
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'playerId required' }));
          return;
        }
        if (target == null || String(target).trim() === '') {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'target required' }));
          return;
        }
        const preAc = await playerStore.getPlayer(playerId);
        console.log(
          '[bot] api action=accuse match_id=' + String(preAc?.match_id || '') + ' playerId=' + String(playerId)
        );
        const result = await processAccuseApi(playerId, target, { locale });
        await enrichResultWithEntitlement(result, playerId);
        await dbPersistAfterActionResult(playerId, locale, 'accuse', 'accuse', target, result);
        const postAc = await playerStore.getPlayer(playerId);
        console.log(
          '[bot] api action complete ok=' +
            String(!!result?.ok) +
            ' match_id=' +
            String(postAc?.match_id || '')
        );
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (route === '/api/action' && req.method === 'POST') {
        const data = body ? JSON.parse(body) : {};
        const playerId = data.playerId;
        const actionName = data.action;
        const targetOpt = data.target;
        const locale = resolveRequestLocale(data, url.searchParams, req.headers);
        console.log('[bot] LOCALE_RESOLVED locale=' + locale + ' action=api_action');
        if (!playerId) {
          console.log('[bot] api action=(none) match_id= playerId=(missing)');
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'playerId required' }));
          return;
        }
        if (actionName == null || String(actionName).trim() === '') {
          console.log(
            '[bot] api action=(missing) match_id= playerId=' + String(playerId)
          );
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'action required' }));
          return;
        }
        const preAct = await playerStore.getPlayer(playerId);
        const an = String(actionName || '').trim();
        console.log(
          '[bot] api action=' +
            an +
            ' match_id=' +
            String(preAct?.match_id || '') +
            ' playerId=' +
            String(playerId)
        );
        const result = await processActionApi(playerId, actionName, targetOpt, { locale });
        await enrichResultWithEntitlement(result, playerId);
        await dbPersistAfterActionResult(playerId, locale, an, an, targetOpt, result);
        const postAct = await playerStore.getPlayer(playerId);
        console.log(
          '[bot] api action complete ok=' +
            String(!!result?.ok) +
            ' match_id=' +
            String(postAct?.match_id || '')
        );
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    } catch (err) {
      console.error('[bot] API error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: String(err.message) }));
    }
  });

  return server;
}

/**
 * 동일 TELEGRAM_BOT_TOKEN으로 getUpdates long polling이 둘 이상 뜨면 409 Conflict.
 * Railway/프로덕션: ENABLE_TELEGRAM_POLLING=true 일 때만 polling (명시 opt-in).
 * 로컬: unset 시 기본 polling 허용(개발 편의), env가 최우선.
 */
function resolveTelegramPollingEnabled() {
  const v = String(process.env.ENABLE_TELEGRAM_POLLING || '').trim().toLowerCase();
  const explicitTrue = v === 'true' || v === '1' || v === 'yes';
  const explicitFalse = v === 'false' || v === '0' || v === 'no';

  const onRailway = !!(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_SERVICE_NAME ||
    process.env.RAILWAY_REPLICA_ID ||
    process.env.RAILWAY_STATIC_URL ||
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    process.env.RAILWAY_GIT_COMMIT_SHA
  );
  const prodLike = process.env.NODE_ENV === 'production';

  if (onRailway || prodLike) {
    if (explicitTrue) return { enabled: true, reason: 'ENABLE_TELEGRAM_POLLING' };
    if (explicitFalse) return { enabled: false, reason: 'ENABLE_TELEGRAM_POLLING' };
    return { enabled: false, reason: 'default_railway_or_production' };
  }

  if (explicitTrue) return { enabled: true, reason: 'ENABLE_TELEGRAM_POLLING' };
  if (explicitFalse) return { enabled: false, reason: 'ENABLE_TELEGRAM_POLLING' };
  return { enabled: true, reason: 'default_local_dev' };
}

/**
 * 실행 진입점: node telegram/bot/bot.js
 * 로컬 API 서버 항상 시작, Telegram long polling은 토큰 + ENABLE 조건일 때만.
 */
if (require.main === module) {
  console.log('[bot] TELEGRAM_DIALOGUE_MODEL=' + TELEGRAM_DIALOGUE_MODEL);
  console.log('[bot] OPENAI_API_KEY=' + (process.env.OPENAI_API_KEY ? 'loaded' : 'missing'));
  console.log('[bot] DEEPSEEK_API_KEY=' + (process.env.DEEPSEEK_API_KEY ? 'loaded' : 'missing'));
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const pollCfg = resolveTelegramPollingEnabled();
  console.log('[bot] telegram polling enabled=' + pollCfg.enabled);

  const apiServer = createLocalApiServer();
  apiServer.listen(API_PORT, () => {
    console.log('[bot] local API server listening on http://localhost:' + API_PORT);
  });

  let bot = null;
  if (token && pollCfg.enabled) {
    const TelegramBot = require('node-telegram-bot-api');
    bot = new TelegramBot(token, { polling: true });
    console.log('[bot] bot runtime starting');
    console.log('[bot] token detected');
    console.log('[bot] polling started');

    bot.on('polling_error', (err) => {
      const code =
        err?.response?.statusCode ??
        err?.response?.status ??
        err?.code ??
        '';
      const msg = err?.message || String(err);
      console.warn('[bot] polling error code=' + code + ' message=' + msg);
      const s = String(msg);
      if (code === 409 || s.includes('409') || /Conflict|getUpdates/i.test(s)) {
        console.warn(
          '[bot] polling conflict — another getUpdates may be active; HTTP API server continues'
        );
      }
    });

    bot.on('message', async (msg) => {
      const chatId = msg.chat?.id;
      const text = msg.text;
      if (!text || !chatId) return;
      const playerId = String(msg.from?.id ?? chatId);
      try {
        const reply = await routeMessage(playerId, text);
        await bot.sendMessage(chatId, reply);
      } catch (err) {
        console.error('[bot] message error:', err.message || err);
        try {
          await bot.sendMessage(chatId, 'Error: ' + (err.message || 'unknown'));
        } catch (_) {}
      }
    });
  } else if (token && !pollCfg.enabled) {
    console.log('[bot] polling skipped by env');
    console.log('[bot] polling skip reason=' + pollCfg.reason);
  } else {
    console.log('[bot] TELEGRAM_BOT_TOKEN not set - polling disabled, API only');
  }

  const shutdown = () => {
    console.log('[bot] shutting down...');
    apiServer.close();
    if (bot) bot.stopPolling?.();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  initBot,
  handleStart,
  handleTextMessage,
  routeMessage,
  handleWebhook,
  getStartStateApi,
  processMessageApi,
  processAccuseApi,
  processActionApi,
  resolveUserKey,
  upsertUserEntitlement,
  upsertMatchState,
  appendMatchEvent
};

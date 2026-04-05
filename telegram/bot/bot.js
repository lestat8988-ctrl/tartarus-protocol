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

/**
 * 게임 시작 인트로 나레이션 — telegram/miniapp/index.html 의 OPENING_LINES 와 동일 유지.
 */
const OPENING_STORY_LINES = {
  ko: [
    'USSC 타르타로스 / 해왕성 외곽 궤도 / 2198년',
    ' ',
    '전체 승무원 125명 동면 중.',
    '핵심 인원 5명 긴급 기상.',
    ' ',
    '현재 위치: 지구로부터 약 29억 km',
    '추진 시스템 손상. 지구 귀환 예상: 약 340년.',
    '통신 두절. 일부 구역 정전 및 격리.',
    ' ',
    '[TARTARUS 프로토콜 발동]',
    '비인가 개체 감지 — 지정명: HADES',
    '깨어난 5명 중 1명 감염 확인.',
    '제한 시간 내 식별 및 격리 실패 시',
    '잔존 승무원 순차 제거 개시 및 전체 승무원 전원 사망 예정.'
  ],
  en: [
    'USSC TARTARUS / NEPTUNE OUTER ORBIT / 2198',
    ' ',
    'Total crew: 125 in stasis.',
    '5 essential personnel revived under emergency protocol.',
    ' ',
    'Current position: ~2.9 billion km from Earth.',
    'Propulsion system damaged. Estimated return: ~340 years.',
    'Communications severed. Multiple sections dark or sealed.',
    ' ',
    '[TARTARUS PROTOCOL ACTIVATED]',
    'Unauthorized entity detected — Designation: HADES',
    '1 of 5 revived personnel confirmed infected.',
    'Failure to identify and isolate within time limit:',
    'sequential elimination initiated. Total crew loss projected — all 125.'
  ]
};

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
  const usedN = Number(ent.daily_free_prompt_used ?? 0);
  const limN = limits.daily_free_prompt_limit;
  const usedSafe = Number.isFinite(usedN) ? usedN : 0;
  try {
    console.log('[bot][entitlement] prompt precheck used=' + usedSafe + ' limit=' + limN);
  } catch (e) {}
  /** 허용: used < limit (예: limit 5면 used 0~4에서 5번째까지 소모). used === limit 이면 이번 요청 차단. */
  if (!(usedSafe < limN)) {
    console.log(
      '[bot][entitlement] prompt blocked user_key=' +
        k +
        ' used=' +
        usedSafe +
        ' limit=' +
        limN
    );
    return { allowed: false, entitlement: ent, block_reason: 'daily_free_prompt_limit_reached' };
  }
  const nextUsed = usedSafe + 1;
  try {
    await upsertUserEntitlement(k, {
      daily_ticket_used: ent.daily_ticket_used,
      daily_ticket_reset_at: ent.daily_ticket_reset_at,
      daily_free_prompt_used: nextUsed,
      daily_free_prompt_reset_at: ent.daily_free_prompt_reset_at
    });
    console.log(
      '[bot][entitlement] prompt consume ok used=' +
        nextUsed +
        ' limit=' +
        limN +
        ' user_key=' +
        k
    );
    return { allowed: true, entitlement: { ...ent, daily_free_prompt_used: nextUsed } };
  } catch (e) {
    console.warn('[bot][entitlement] prompt persist warn user_key=' + k + ' ' + String(e?.message || e));
    return { allowed: true, fallback: true, entitlement: ent };
  }
}

/**
 * /api/message 직접 텍스트는 기본 차갑. state_query·free_input_clarification만 비차갑.
 */
function shouldConsumeFreePromptForMessageKind(cls, parsed, text) {
  void parsed;
  void text;
  if (!cls || !cls.kind) return false;
  const nonChargeable = new Set(['state_query', 'free_input_clarification']);
  return !nonChargeable.has(cls.kind);
}

/** consumeFreePromptIfAllowed 성공 직후 — 동일 요청에서 entitlement 재차단·ok 누락으로 DB persist 누락 방지 */
function attachFreePromptConsumedMetadata(result, didConsume) {
  if (!result || !didConsume) return result;
  result.free_prompt_consumed_this_request = true;
  result.blocked = false;
  if (result.ok === undefined) result.ok = true;
  return result;
}

/** match_events / 로그용 짧은 kind 문자열 */
function getIntentLogKindForPayload(cls, parsed) {
  if (!cls) return 'unknown';
  if (cls.kind === 'free_input_clarification') return 'free_input_clarification';
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
  if (cls && cls.kind === 'targeted_question' && cls.isSelfDefenseQuestion) {
    try {
      console.log('[bot][intent] self defense question detected role=' + cls.crewGameplayTargetRole);
    } catch (e) {}
  }
  console.log(
    '[bot][intent] message kind=' + kind + ' consumes_free_prompt=' + (consumesFreePrompt ? 'true' : 'false')
  );
}

function serializeFreeInputRouteForMeta(route) {
  if (!route || typeof route !== 'object') return null;
  return {
    applied: !!route.applied,
    modelUsed: route.modelUsed != null ? String(route.modelUsed) : 'none',
    routeReason: route.routeReason != null ? String(route.routeReason) : '',
    targetType: route.targetType != null ? route.targetType : null,
    targetRole: route.targetRole != null ? route.targetRole : null,
    confidence: typeof route.confidence === 'number' ? route.confidence : null,
    needsClarification: !!route.needsClarification,
    fallbackUsed: !!route.fallbackUsed,
    normalizedText: route.normalizedText != null ? String(route.normalizedText).slice(0, 500) : null
  };
}

/** processMessageApi → dbPersist 재사용용 — 분류 재호출 금지 */
function buildFreeInputIntentMetaSnapshot(cls, parsed, text, route) {
  return {
    message_kind: getIntentLogKindForPayload(cls, parsed),
    consumes_free_prompt: shouldConsumeFreePromptForMessageKind(cls, parsed, text),
    route: serializeFreeInputRouteForMeta(route)
  };
}

async function enrichResultWithEntitlement(result, playerId) {
  if (!result) return result;
  /** 이미 consume 허용된 lore 요청은 entitlement 스냅샷 전에도 ok/blocked 고정 */
  if (result.free_prompt_consumed_this_request) {
    result.blocked = false;
    result.ok = true;
  }
  if (result.blocked || result.ok === false) return result;
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
  if (result.free_prompt_consumed_this_request) {
    result.blocked = false;
    result.ok = true;
  }
  return result;
}

function truncateJsonish(obj, maxLen) {
  const cap =
    typeof maxLen === 'number' && Number.isFinite(maxLen) && maxLen > 0 ? maxLen : 200000;
  try {
    const s = JSON.stringify(obj);
    if (s.length <= cap) return obj;
    return { _truncated: true, preview: s.slice(0, cap) };
  } catch {
    return { _error: 'serialize' };
  }
}

/** message_result 페이로드용 — DB/직렬화 실패 시 빈 배열로 수렴 */
function safeRecentEventsPayloadForDb(result) {
  try {
    const ev = result?.recent_events || result?.events || [];
    return truncateJsonish(ev, 200000);
  } catch (e) {
    return [];
  }
}

async function upsertUserEntitlement(userKey, patch = {}) {
  const key = String(userKey || 'anonymous');
  const patchKeys = Object.keys(patch || {}).filter((k) => patch[k] !== undefined);
  const isNoOpPatch = patchKeys.length === 0;
  if (isNoOpPatch) {
    logDbBootOnce();
    const sbNoOp = getSupabaseOptional();
    if (sbNoOp) {
      try {
        console.log('[bot][entitlement] remote row loaded before no-op sync user_key=' + key);
      } catch (e) {}
      try {
        await fetchUserEntitlementRow(key);
      } catch (e) {
        console.warn('[bot][entitlement] no-op sync fetch warn user_key=' + key + ' ' + String(e?.message || e));
      }
      try {
        console.log('[bot][entitlement] no-op upsert skipped to avoid stale overwrite user_key=' + key);
      } catch (e) {}
    } else {
      try {
        console.log('[bot][entitlement] no-op upsert skipped (no Supabase, no write) user_key=' + key);
      } catch (e) {}
    }
    return;
  }
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

/** 동일 match 종료 이벤트 DB 중복 append 방지(프로세스 내). match_sessions upsert는 매번 idempotent. */
const matchIdShutdownEventDbLogged = new Set();

/**
 * 타이머 만료·게임 종료 시 match_sessions + match_events(Supabase) 반드시 반영.
 * @param {string} detail.source - 'timeout' | 'game_over_kill'
 */
async function persistMatchShutdownToDb(matchId, detail) {
  const mid = String(matchId || '').trim();
  if (!mid || !detail?.gameOver) return;
  const source = detail.source || 'unknown';
  const outcomeStr =
    detail.outcome != null && String(detail.outcome).trim() !== ''
      ? String(detail.outcome)
      : source === 'timeout'
        ? 'TIMEOUT'
        : '';

  if (source === 'timeout') {
    try {
      console.log('[bot][timeout] detected match_id=' + mid);
      console.log('[bot][timeout] persisting match_sessions game_over=true remaining_sec=0');
    } catch (e) {}
  }

  const prev = dbMatchSessionsMemory.get(mid) || {};
  const userKey = prev.user_key || resolveUserKey(null, mid);
  const locale = prev.locale === 'en' ? 'en' : 'ko';

  await upsertMatchState({
    match_id: mid,
    user_key: userKey,
    locale,
    phase: 'game_over',
    remaining_sec: 0,
    game_over: true,
    started_at: prev.started_at
  });

  const skipAppend = matchIdShutdownEventDbLogged.has(mid);
  if (skipAppend) {
    if (source === 'timeout') {
      try {
        console.log('[bot][timeout] persist done (duplicate skip event)');
      } catch (e) {}
    }
    return;
  }

  const payload = {
    outcome: outcomeStr || (source === 'timeout' ? 'TIMEOUT' : null),
    game_over: true,
    remaining_sec: 0,
    source
  };
  const eventType = source === 'timeout' ? 'timeout' : 'game_over';

  if (source === 'timeout') {
    try {
      console.log('[bot][timeout] appending timeout event match_id=' + mid);
    } catch (e) {}
  }

  await appendMatchEvent({
    match_id: mid,
    user_key: userKey,
    event_type: eventType,
    payload
  });
  matchIdShutdownEventDbLogged.add(mid);
  if (source === 'timeout') {
    try {
      console.log('[bot][timeout] persist done');
    } catch (e) {}
  }
}

/**
 * 엔진 match에 이미 game_over가 있는데 DB만 비어 있을 때 보정(재시작 직전 등).
 */
async function ensureGameOverPersistedToDb(matchId, match) {
  const gs = match?.game_state;
  if (!gs?.game_over) return;
  const evs = match?.events || [];
  const hasTimeout = evs.some((e) => e && e.type === 'TIMEOUT');
  if (hasTimeout) {
    await persistMatchShutdownToDb(matchId, {
      source: 'timeout',
      outcome: gs.outcome || 'TIMEOUT',
      gameOver: true
    });
  } else if (gs.outcome) {
    await persistMatchShutdownToDb(matchId, {
      source: 'game_over_kill',
      outcome: gs.outcome,
      gameOver: true
    });
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
  if (result?.free_prompt_consumed_this_request) {
    result.blocked = false;
    result.ok = true;
  }
  const blk = !!result?.blocked;
  const okFalse = result?.ok === false;
  if (blk || okFalse) {
    try {
      console.log(
        '[bot][db] message_result persist skipped blocked=' + String(blk) + ' ok=' + (okFalse ? 'false' : String(result?.ok))
      );
    } catch (e) {}
    return;
  }
  try {
    const player = await playerStore.getPlayer(playerId);
    const matchId = player?.match_id;
    if (!matchId) return;
    const userKey = resolveUserKey(playerId, matchId);
    /** daily_free_prompt_used는 consumeFreePromptIfAllowed에서만 증가 */
    let messageKind = 'unknown';
    let consumesFreePrompt = false;
    try {
      const meta = result && result.free_input_intent_meta;
      if (meta && typeof meta === 'object') {
        messageKind =
          meta.message_kind != null && meta.message_kind !== ''
            ? String(meta.message_kind)
            : 'unknown';
        consumesFreePrompt = !!meta.consumes_free_prompt;
      }
    } catch (e) {
      try {
        console.warn('[bot][intent] dbPersist free_input_intent_meta read warn ' + String(e?.message || e));
      } catch (e2) {}
    }
    const persistKind = consumesFreePrompt ? 'lore_question' : messageKind;
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
    try {
      console.log('[bot][db] message_input persisted kind=' + persistKind);
    } catch (e) {}
    const recentPayload = safeRecentEventsPayloadForDb(result);
    const resultPayload = {
      summary: result.summary,
      recent_events: recentPayload,
      message_kind: messageKind,
      consumes_free_prompt: consumesFreePrompt
    };
    try {
      console.log('[bot][db] message_result persist scheduled blocked=false ok=true');
    } catch (e) {}
    try {
      await appendMatchEvent({
        match_id: matchId,
        user_key: userKey,
        event_type: 'message_result',
        payload: resultPayload
      });
    } catch (eRes) {
      try {
        console.log(
          '[bot][error] lore pipeline failed after input persist err=' + String(eRes?.message || eRes)
        );
      } catch (e) {}
      try {
        await appendMatchEvent({
          match_id: matchId,
          user_key: userKey,
          event_type: 'message_result',
          payload: {
            summary: String(result?.summary || '').slice(0, 4000),
            recent_events: [],
            message_kind: messageKind,
            consumes_free_prompt: consumesFreePrompt,
            _persist_fallback: true
          }
        });
      } catch (e2) {
        console.warn('[bot][db] message_result fallback also failed', e2?.message || e2);
      }
    }
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

async function dbPersistAfterTelegramStart(playerId, opts = {}) {
  try {
    const locale = opts.locale === 'en' ? 'en' : 'ko';
    try {
      console.log('[bot][start] locale resolved=' + locale);
    } catch (e) {}
    const player = await playerStore.getPlayer(playerId);
    const matchId = player?.match_id;
    if (!matchId) return;
    const match = await matchStore.getMatch(matchId);
    if (!match) return;
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
/** 자유입력 대사 LLM 테스트: tryGenerateLlmDialogueLogs → callChatCompletionsJson 전용 (clearance 무관). 미설정 시 TELEGRAM_DIALOGUE_MODEL 폴백. */
const TELEGRAM_DIALOGUE_MODEL_L2 =
  process.env.TELEGRAM_DIALOGUE_MODEL_L2 || process.env.TELEGRAM_DIALOGUE_MODEL || 'gpt-4o-mini';
/** 자유입력 라우팅 전용 — TELEGRAM_DIALOGUE_MODEL 과 무관. 미설정 시 mini(규칙+선택적 mini 모델)로 기존과 동일. */
const FREE_INPUT_PARSE_MODE_RAW = String(process.env.FREE_INPUT_PARSE_MODE || 'mini').trim().toLowerCase();
const FREE_INPUT_PARSE_MODE =
  FREE_INPUT_PARSE_MODE_RAW === 'hybrid' ? 'hybrid' : FREE_INPUT_PARSE_MODE_RAW === '4o' ? '4o' : 'mini';
const FREE_INPUT_PARSE_MODEL_MINI = process.env.FREE_INPUT_PARSE_MODEL_MINI || 'gpt-4o-mini';
const FREE_INPUT_PARSE_MODEL_4O = process.env.FREE_INPUT_PARSE_MODEL_4O || 'gpt-4o';
const FREE_INPUT_ROUTE_TIMEOUT_MS = 8000;
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
  const model = TELEGRAM_DIALOGUE_MODEL_L2;
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
      doctor: '[Doctor/Yuna]',
      engineer: '[Engineer/Danny]',
      navigator: '[Navigator/Owen]',
      pilot: '[Pilot/Marcus]'
    };
  }
  return {
    captain: '[함장]',
    doctor: '[닥터/유나]',
    engineer: '[엔지니어/대니]',
    navigator: '[네비게이터/오웬]',
    pilot: '[파일럿/마커스]'
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
    /(누가\s*죽|사망|죽었|사망자|희생|who\s*(died|dies|is\s*dead)|casualties|dead\s*crew|life\s*signs?\s*lost|누가\s*[가-힣A-Za-z]+\s*를?\s*죽|[가-힣A-Za-z]+를?\s*누가\s*죽|[가-힣A-Za-z]+(?:랑|와)\s*누가\s*같이|[가-힣A-Za-z]+(?:랑|와)\s*같이\s*있었|who\s+killed\s+[a-z]+|who\s+was\s+with\s+[a-z]+)/i.test(
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
 * 한·영 정의형 질문(세계관 설명 요청) — 짧은 추궁/상황 질문과 구분.
 * 물음표 없이 끝나는 IME 입력도 허용(무엇인가/무엇이지 등 종결).
 */
function matchesDefinitionalAskPattern(raw) {
  const t = String(raw || '').trim();
  if (!t) return false;
  const hasQm = /[?？]/.test(t);
  const koTail =
    /(?:무엇인가|무엇이지|무엇인지|뭔가요|뭔지|뭐지|뭐야|뜻은|뜻이|뜻을|정체가|정체는|정체이|의미는|의미가|무엇인가요|무엇입니까)\s*[?？]?\s*$/i.test(t) ||
    /(?:이란|라는)\s*무엇/i.test(t) ||
    /(?:이|가|는|은|을|를)\s*란\s*[?？]/i.test(t);
  const koAny =
    /(무엇인가|무엇이지|무엇인지|뭔지|뭐지|뭐야|뜻|정체|의미|무엇입니까|무엇인가요)/i.test(t);
  const en = /\bwhat\s+(?:is|are)\b/i.test(t) || /\bwhat(?:'s|s)\s+\w/i.test(t);
  if (en && hasQm) return true;
  if (koAny && (hasQm || koTail)) return true;
  return false;
}

/**
 * 세계관·설명 질문 — 정규 키워드 또는 정의형+주제. 이름·집단·의심 심문은 제외.
 * 정의형에서 추출 용어가 이미 canon/alias로 등록돼 있어도 lore(회귀 방지: !isKnownCanonLoreTerm 제거).
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
  if (matchesDefinitionalAskPattern(raw)) {
    if (
      /수상|범인|이상한|뭘\s*더|확인해야|의심|who\s*(is\s*)?suspicious|suspicious|verify\s*next/i.test(t)
    ) {
      return false;
    }
    if (isGameplayCrewQuestionPattern(t)) return false;
    if (detectCrewRoleForGameplayQuestion(raw) && !isGameplayCrewQuestionPattern(raw)) return true;
    const ex = extractPrimaryLoreTerm(t, 'ko');
    if (ex && !isGameplayAntiLoreQuestion(t)) {
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
  if (
    /(정확히\s*말해|말이\s*랑\s*다르|말이랑\s*다르|말이\s*바뀌|아까\s*말)/i.test(t) &&
    /(닥터|의사|엔지니어|네비게이터|파일럿|doctor|engineer|navigator|pilot)/i.test(t)
  ) {
    return true;
  }
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
    /(정확히\s*말해|말이\s*랑\s*다르|말이랑\s*다르|말이\s*바뀌|아까\s*말)/i.test(t) &&
    /(닥터|의사|엔지니어|네비게이터|파일럿|doctor|engineer|navigator|pilot)/i.test(t)
  ) {
    return true;
  }
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

function isUrgentSuspicionQuestion(raw) {
  const t = String(raw || '');
  const hasSuspicion =
    /(범인|누가\s*범|누굴\s*의심|누굴\s*쏴|누구를\s*쏴|누구\s*쏴|쏴야|중첩체\s*누구|누가\s*중첩체|who.*impost|who.*traitor|who.*shoot|who.*kill)/i.test(t);
  const hasUrgency =
    /(1분\s*후|시간\s*없|모두\s*죽|다\s*죽|죽기\s*전|죽기전|before\s*we\s*die|time\s*is\s*running|running\s*out|no\s*time)/i.test(t);
  return hasSuspicion && hasUrgency;
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
  if (/칼릭스|calix/i.test(t) && /프로토콜|protocol/i.test(t)) return true;
  if (/네오\s*아크|neo\s*arc|neoarc/i.test(t)) return true;
  if (/오르페우스|orpheus/i.test(t) && /게이트|gate/i.test(t)) return true;
  return false;
}

/** 승무원 역할명이 문장에 있으면 문자열에서 가장 앞에 나오는 역할 키(doctor|…) 반환 */
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
    const idx = t.search(re);
    if (typeof idx === 'number' && idx >= 0 && idx < bestIdx) {
      bestIdx = idx;
      best = role;
    }
  }
  if (best != null) {
    try {
      console.log('[bot][intent] leading/earliest crew role detected role=' + best);
    } catch (e) {}
  }
  return best;
}

/**
 * 자유 입력에서 승무원 타깃 역할 추출 — detectCrewRoleForGameplayQuestion과 동일(문장에서 가장 앞에 나오는 역할).
 */
function extractTargetRoleFromText(text) {
  return detectCrewRoleForGameplayQuestion(String(text || ''));
}

/**
 * observe/unknown 등 파서 결과와 무관하게 타깃+의도(질문/심문/위협) 추론 — 라우팅 전용.
 * 불명확하면 QUESTION (OBSERVE 폴백 방지).
 */
function inferFreeTextCaptainIntent(text, parsedIntent, targetRole) {
  if (!targetRole) return null;
  const t = String(text || '');
  if (!t.trim()) return 'QUESTION';
  if (
    /(위협|쏴버릴|쏴버리|당장\s*말해|가만\s*안\s*둬|죽을\s*수도|권총|총구|겨누|처형|쏘겠|threaten|gunpoint|shoot|execute)/i.test(
      t
    )
  ) {
    return 'THREAT';
  }
  if (
    /(정확히\s*말해|말이\s*랑\s*다르|말이랑\s*다르|아까\s*말|말이\s*바뀌|바뀌고\s*있|계속\s*말이|왜\s*말이\s*바뀌|추궁|캐묻|왜\s*그랬지|심문|interrogat|contradict)/i.test(
      t
    )
  ) {
    return 'INTERROGATE';
  }
  if (/(어디\s*있었지|뭐\s*했지|말해봐|설명해|설명해봐|뭐\s*했는지|무엇을\s*했)/i.test(t)) {
    return 'QUESTION';
  }
  const pi = String(parsedIntent || '').toLowerCase();
  if (pi === 'observe' || pi === 'unknown') return 'QUESTION';
  return 'QUESTION';
}

function shouldForceTargetedCrewReply(targetRole, intent) {
  if (!targetRole) return false;
  return intent === 'QUESTION' || intent === 'INTERROGATE' || intent === 'THREAT';
}

/**
 * 역할 호칭 + 심문/위협/정보 질문 키워드 — isGameplayCrewQuestionPattern 보완.
 */
function isDirectedCrewGameplayIntent(raw) {
  const t = String(raw || '');
  if (!extractTargetRoleFromText(t)) return false;
  if (containsLoreCanonSubject(raw)) return false;
  if (
    /(정확히\s*말해|말이\s*랑\s*다르|말이랑\s*다르|아까\s*말|말이\s*바뀌|바뀌고\s*있|계속\s*말이|왜\s*말이\s*바뀌|추궁|캐묻|왜\s*그랬지|심문)/i.test(t)
  ) {
    return true;
  }
  if (/(위협|쏴버릴|쏴버리|당장\s*말해|가만\s*안\s*둬|죽을\s*수도)/i.test(t)) return true;
  if (/(어디\s*있었지|뭐\s*했지|말해봐|설명해|설명해봐)/i.test(t)) return true;
  return false;
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
  if (!isGameplayCrewQuestionPattern(raw) && !isDirectedCrewGameplayIntent(raw)) return null;
  return crewRole;
}

/** isGameplayCrewQuestionPattern 과 동일 의미 — 외부에서 이름만 분리해 쓸 때 */
function isGameplayInterrogative(raw) {
  return isGameplayCrewQuestionPattern(raw);
}

/**
 * 음식/날씨/일상 등 함선 세계관과 무관한 질문 — lore_question 오분류 방지(ko/en).
 */
function isOffTopicNonLoreQuestion(raw) {
  const t = String(raw || '').trim();
  if (!t) return false;
  if (containsLoreCanonSubject(raw)) return false;
  if (/\bHADES\b|하데스|\bAXIS\b|액시스|HORIZON|호라이즌|phase\s*shock|위상\s*충격|중첩체|tartarus|impostor|임포|승무원\s*전원/i.test(t)) {
    return false;
  }
  const lower = t.toLowerCase();
  if (
    /(what\s+is\s+for\s+dinner|what's\s+for\s+dinner|what\s+are\s+we\s+having|what\s+are\s+we\s+eating|how\s*'s\s+the\s+weather|how\s+is\s+the\s+weather|what'?s\s+the\s+weather|weather\s+like|what'?s\s+for\s+(lunch|breakfast|dinner))/i.test(
      lower
    )
  ) {
    return true;
  }
  if (/(저녁\s*메뉴|오늘\s*저녁|점심\s*메뉴|날씨\s*어때|날씨가\s*어떠|기온|식사\s*메뉴|밥\s*뭐)/.test(t)) {
    return true;
  }
  if (
    /(저녁|점심|아침|메뉴|날씨|식사)/.test(t) &&
    /(무엇|뭐|어때|어떻|뭔)/.test(t) &&
    !/(하데스|액시스|호라이즌|중첩|임포|범인)/.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * 집단 마커 없이 이름만 묻는 문장 — group_question / name (buildGroupNameQuestionCrewEvents 재사용).
 */
function isStandaloneCrewNameGroupQuestion(raw) {
  const t = String(raw || '').trim();
  if (!t) return false;
  if (containsLoreCanonSubject(raw)) return false;
  if (/(범인|의심|임포|하데스|액시스|HADES|AXIS|로그|log)/i.test(t)) return false;
  if (
    /^이름이[?？]\s*$/.test(t) ||
    /^이름은[?？]\s*$/.test(t) ||
    /^이름[?？]\s*$/.test(t)
  ) {
    return true;
  }
  if (/^name\s*\?\s*$/i.test(t) || /^your\s+name\s*\?\s*$/i.test(t) || /^your\s+names\s*\?\s*$/i.test(t)) {
    return true;
  }
  if (
    /^(what\s+are\s+your\s+names|tell\s+me\s+your\s+names|state\s+your\s+names)\s*\??\s*$/i.test(t) ||
    /^names\s*\??\s*$/i.test(t)
  ) {
    return true;
  }
  if (
    /(이름이\s*무엇인가[?？]?|이름이\s*뭐|이름을\s*말해봐|각자\s*이름을\s*말해라|모두\s*이름을\s*말해라|이름\s*말해봐|성함이\s*무엇)/.test(t)
  ) {
    return true;
  }
  return false;
}

/** classifyMiniappFreeText 와 동일 — 외부에서 kind 조회용 */
function classifyMiniappMessageKind(text, parsed) {
  return classifyMiniappFreeText(text, parsed);
}

/**
 * miniapp 자유입력 분류 — check_log → role_opinion → targeted → state_query → mapped → group → suspicion → lore → brief/mapped
 * lore_question은 gameplay·집단 심문보다 뒤에 판정. intent=question/unknown에서도 정의형 lore가 brief로 새지 않게 가드.
 * @param {string} [localeOpt] - 'en'일 때만 영문 clarification; 생략 시 ko(기존 동작).
 */
function classifyMiniappFreeText(text, parsed, localeOpt) {
  const loc = localeOpt === 'en' ? 'en' : 'ko';
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  try {
    const esc = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ').slice(0, 280);
    console.log('[bot][classify] raw text="' + esc + '"');
  } catch (e) {}
  const mappedActionIntents = new Set(['accuse_hint', 'threaten', 'threat', 'observe']);
  let intent = String(parsed.intent_type || 'unknown').toLowerCase();
  const pinnedThreatIntent = intent === 'threaten' || intent === 'threat';
  let effParsed = parsed;
  if (intent === 'observe' || intent === 'unknown') {
    const tr0 = extractTargetRoleFromText(raw);
    const ft0 = tr0 ? inferFreeTextCaptainIntent(raw, intent, tr0) : null;
    if (tr0 && ft0 && shouldForceTargetedCrewReply(tr0, ft0)) {
      effParsed = { ...parsed, intent_type: 'question', target: tr0 };
      intent = 'question';
      try {
        console.log('[intent] target=' + tr0 + ' intent=' + ft0 + ' source=free_text');
      } catch (e) {}
    }
  }
  if (mappedActionIntents.has(intent) && isStrongQuestionCueText(raw) && !pinnedThreatIntent) {
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
  if (crewRole && !pinnedThreatIntent) {
    const selfDefQ = isSelfDefenseQuestionContext(raw);
    try {
      console.log('[bot][intent] role-target detected role=' + crewRole);
      if (/이름|name/i.test(raw)) {
        console.log('[bot][intent] name question detected');
        console.log('[bot][intent] targeted name question detected');
      }
      if (selfDefQ) {
        console.log('[bot][intent] self defense question detected role=' + crewRole);
        console.log('[bot][intent] isTargetedAccusation=true');
      }
      console.log('[bot][intent] final kind=targeted_question');
    } catch (e) {}
    const merged = {
      ...effParsed,
      intent_type: effParsed.intent_type || 'question',
      target: crewRole,
      isSelfDefenseQuestion: selfDefQ,
      isTargetedAccusation: selfDefQ
    };
    return {
      kind: 'targeted_question',
      parsed: merged,
      crewGameplayTargetRole: crewRole,
      isSelfDefenseQuestion: selfDefQ,
      isTargetedAccusation: selfDefQ
    };
  }

  if (isUrgentSuspicionQuestion(raw)) {
    try {
      console.log('[bot][intent] urgent suspicion question detected');
      console.log('[bot][intent] final kind=suspicion_question');
    } catch (e) {}
    return { kind: 'suspicion_question', parsed: effParsed };
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

  if (isStandaloneCrewNameGroupQuestion(raw)) {
    try {
      console.log('[bot][intent] standalone name question -> group_question name');
      console.log('[bot][classify] final kind=group_question sub=name');
      if (/^이름이[?？]\s*$/.test(String(raw || '').trim())) {
        console.log('[bot][classify] short name cue input="이름이?" final cls.kind=group_question');
      }
    } catch (e) {}
    return { kind: 'group_question', parsed: effParsed, groupSubkind: 'name' };
  }

  if (isOffTopicNonLoreQuestion(raw)) {
    try {
      console.log('[bot][classify] off-topic non-lore guard -> final kind=free_input_clarification');
    } catch (e) {}
    return {
      kind: 'free_input_clarification',
      parsed: effParsed,
      clarificationText: defaultFreeInputClarificationLine(loc)
    };
  }

  const loreCrewTargetRole = detectCrewRoleForGameplayQuestion(raw);
  if (loreCrewTargetRole && containsLoreCanonSubject(raw) && isQuestionLikeCaptainText(raw)) {
    const merged = { ...effParsed, intent_type: 'question', target: loreCrewTargetRole };
    try {
      console.log('[bot][intent] targeted lore crew question detected role=' + loreCrewTargetRole);
      console.log('[bot][intent] final kind=targeted_question');
    } catch (e) {}
    return {
      kind: 'targeted_question',
      parsed: merged,
      crewGameplayTargetRole: loreCrewTargetRole,
      isSelfDefenseQuestion: false,
      isTargetedAccusation: false
    };
  }

  if (isLoreQuestion(raw)) {
    try {
      console.log('[bot][classify] detected lore_question by pattern');
      console.log('[bot][classify] final message_kind=lore_question');
      console.log('[bot][route] lore pipeline selected');
    } catch (e) {}
    return { kind: 'lore_question', parsed: effParsed };
  }

  if (intent === 'question') {
    if (effParsed.target) {
      const selfDefQ = isSelfDefenseQuestionContext(raw);
      const detectedRole = detectCrewRoleForGameplayQuestion(raw);
      const tr = detectedRole || String(effParsed.target).toLowerCase();
      if (detectedRole && detectedRole !== String(effParsed.target || '').toLowerCase()) {
        try {
          console.log('[bot][intent] detected role overrides parsed target=' + tr);
        } catch (e) {}
      }
      const merged = {
        ...effParsed,
        intent_type: 'question',
        target: tr,
        isSelfDefenseQuestion: selfDefQ,
        isTargetedAccusation: selfDefQ
      };
      try {
        console.log('[bot][intent] role-target detected role=' + tr);
        if (selfDefQ) {
          console.log('[bot][intent] self defense question detected role=' + tr);
          console.log('[bot][intent] isTargetedAccusation=true');
        }
        console.log('[bot][intent] final kind=targeted_question');
      } catch (e) {}
      return {
        kind: 'targeted_question',
        parsed: merged,
        crewGameplayTargetRole: tr,
        isSelfDefenseQuestion: selfDefQ,
        isTargetedAccusation: selfDefQ
      };
    }
    try {
      console.log('[bot][classify] final message_kind=brief_question');
      console.log('[bot][route] brief pipeline selected');
    } catch (e) {}
    return { kind: 'brief_question', parsed: effParsed };
  }

  if (intent === 'unknown') {
    if (looksLikeOpenQuestion(lower, raw)) {
      try {
        console.log('[bot][classify] final message_kind=brief_question');
        console.log('[bot][route] brief pipeline selected');
      } catch (e) {}
      return { kind: 'brief_question', parsed: effParsed };
    }
    return { kind: 'mapped', parsed: effParsed };
  }

  return { kind: 'mapped', parsed: effParsed };
}

/** 자유입력 라우팅 전용 정규화 — 의미 왜곡 없이 공백·문장부호·영문 케이스만 정리 */
function normalizeFreeInputForRouting(text) {
  let s = String(text || '').trim();
  s = s.replace(/\s+/g, ' ');
  s = s.replace(/([?!.])\1+/g, '$1');
  s = s.replace(/[?!.]{3,}/g, (m) => m[0]);
  const hasHangul = /[\uAC00-\uD7A3]/.test(s);
  if (!hasHangul) s = s.toLowerCase();
  return s.trim();
}

function defaultFreeInputClarificationLine(locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const sys = systemHeader(loc);
  if (loc === 'en') {
    return (
      sys +
      ' Please clarify the target once more. I need to know whether you mean AXIS, HADES, a log check, or a specific crew question.'
    );
  }
  return (
    sys +
    ' 뜻한 대상을 한 번만 더 정확히 적어 주세요. AXIS, HADES, 로그 확인, 혹은 특정 승무원 질문인지 구분이 필요합니다.'
  );
}

/**
 * free_input_clarification 표시용 — 동일 기본 clarification 문구가 반복되면 1회만 노출 (이벤트 저장 불변).
 * @param {object[]} logs
 * @param {'en'|'ko'} locale
 * @returns {object[]}
 */
function compactClarificationDisplayLogs(logs, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  if (!logs || !logs.length) return logs;
  const sysH = systemHeader(loc);
  const defaultClarNorm = normalizeDisplayLine(defaultFreeInputClarificationLine(loc));
  const before = logs.length;
  let removedDuplicates = 0;
  let seen = false;
  const out = [];
  let i = 0;
  while (i < logs.length) {
    const t0 = normalizeDisplayLine(String(logs[i]?.type || ''));
    if (t0 === defaultClarNorm) {
      if (seen) {
        removedDuplicates++;
        i++;
        continue;
      }
      seen = true;
      out.push(logs[i]);
      i++;
      continue;
    }
    if (t0 === sysH && i + 1 < logs.length) {
      const t1 = normalizeDisplayLine(String(logs[i + 1]?.type || ''));
      const combined = normalizeDisplayLine(sysH + ' ' + t1);
      const pairMatches =
        combined === defaultClarNorm ||
        (t0 === sysH && /^(Please clarify the target|뜻한 대상을 한 번만 더)/i.test(t1));
      if (pairMatches) {
        if (seen) {
          removedDuplicates += 2;
          i += 2;
          continue;
        }
        seen = true;
        out.push(logs[i], logs[i + 1]);
        i += 2;
        continue;
      }
    }
    out.push(logs[i]);
    i++;
  }
  try {
    console.log(
      '[bot][clarification_compact] before=' +
        before +
        ' after=' +
        out.length +
        ' removed_duplicates=' +
        removedDuplicates
    );
  } catch (e) {}
  return out;
}

function normalizeRouteRoleKeyForFreeInput(raw) {
  if (raw == null) return null;
  const t = String(raw).toLowerCase().trim();
  if (t === 'doctor' || t === '닥터' || t === '의사') return 'doctor';
  if (t === 'engineer' || t === '엔지니어') return 'engineer';
  if (t === 'navigator' || t === '네비게이터') return 'navigator';
  if (t === 'pilot' || t === '파일럿') return 'pilot';
  return null;
}

/**
 * 짧은·오타·애매 입력만 LLM 라우팅 후보로 본다. 4o 모드는 항상 후보.
 * 기존 classify 결과(shadow)와 결합 — lore 오분류·unknown lore 위험을 줄인다.
 */
function shouldRunAmbiguousFreeInputProbe(normalizedText, locale, shadowCls) {
  void locale;
  const n = String(normalizedText || '').trim();
  if (!n) return false;
  const lower = n.toLowerCase();
  const wc = n.split(/\s+/).filter(Boolean).length;
  const shortLen = n.length <= 32;
  const oneOrTwoTokens = wc <= 2;
  const qm = /[?？]/.test(n);
  const typoHadesLike = /(아네스|하네스|hadis|하네스\?)/i.test(n) && !/\bHADES\b|하데스/i.test(n);
  const noCrew = !detectCrewRoleForGameplayQuestion(n);
  const noStrongCanon =
    !containsLoreCanonSubject(n) && !/\bHADES\b|하데스|\bAXIS\b|액시스|HORIZON|호라이즌|phase\s*shock|위상\s*충격/i.test(n);
  const shadowRiskLore =
    shadowCls &&
    shadowCls.kind === 'lore_question' &&
    shortLen &&
    noStrongCanon &&
    (oneOrTwoTokens || qm);
  const offTopicHint =
    /(저녁|메뉴|배고|날씨|dinner|lunch|weather|how\s+are\s+you)/i.test(lower) && !containsLoreCanonSubject(n);
  return (
    typoHadesLike ||
    offTopicHint ||
    (shortLen && qm && noCrew && noStrongCanon) ||
    (oneOrTwoTokens && qm && noStrongCanon && noCrew) ||
    shadowRiskLore
  );
}

function mapFreeInputRouteJsonToCls(j, normalizedText, guardedParsed, locale) {
  void locale;
  const routeReasonRaw = String(j?.routeReason || '').toLowerCase();
  if (routeReasonRaw === 'crew_names_inquiry') {
    try {
      console.log('[bot][intent] route map crew_names_inquiry -> group_question name');
      console.log('[bot][classify] final kind=group_question sub=name');
    } catch (e) {}
    return { kind: 'group_question', parsed: { ...guardedParsed }, groupSubkind: 'name' };
  }
  const tt = String(j?.targetType || '').toLowerCase();
  const confRaw = parseFloat(j?.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw)) : 0;
  const needsClar = !!j?.needsClarification;
  const role = normalizeRouteRoleKeyForFreeInput(j?.targetRole);
  const clarifyCls = {
    kind: 'free_input_clarification',
    parsed: { ...guardedParsed },
    clarificationText: defaultFreeInputClarificationLine(locale)
  };
  if (needsClar || tt === 'unclear' || tt === '') return clarifyCls;
  if (confidence < 0.45 && tt !== 'system') return clarifyCls;
  const n = String(normalizedText || '');
  if (tt === 'lore') {
    if (n.length < 18 && !containsLoreCanonSubject(n) && !/\bHADES\b|하데스|\bAXIS\b|액시스/i.test(n)) {
      return clarifyCls;
    }
    return { kind: 'lore_question', parsed: { ...guardedParsed } };
  }
  if (tt === 'crew') {
    if (!role) return clarifyCls;
    const selfDefQ = isSelfDefenseQuestionContext(n);
    return {
      kind: 'targeted_question',
      parsed: {
        ...guardedParsed,
        intent_type: 'question',
        target: role,
        isSelfDefenseQuestion: selfDefQ,
        isTargetedAccusation: selfDefQ
      },
      crewGameplayTargetRole: role,
      isSelfDefenseQuestion: selfDefQ,
      isTargetedAccusation: selfDefQ
    };
  }
  if (tt === 'system') {
    if (/(로그|log|기록|check|show\s+log|records)/i.test(n)) {
      const tr = extractTargetRoleFromText(n);
      return {
        kind: 'mapped',
        parsed: {
          ...guardedParsed,
          intent_type: 'check_log',
          target: tr || guardedParsed.target || null
        }
      };
    }
    return clarifyCls;
  }
  return clarifyCls;
}

function buildEmptyFreeInputRouteResult(normalizedText, originalInput, shadowClsReuse) {
  return {
    applied: false,
    targetType: null,
    targetRole: null,
    confidence: 0,
    needsClarification: false,
    clarificationText: null,
    modelUsed: 'none',
    routeReason: 'skip',
    fallbackUsed: false,
    normalizedText,
    originalInput,
    cls: null,
    shadowClsReuse: shadowClsReuse || null
  };
}

/** Short-term dialogue focus in match.game_state only (no extra DB tables). */
const DIALOGUE_FOCUS_TTL_MS = 10 * 60 * 1000;

function isDialogueFocusRecent(gs) {
  const t = gs && gs.last_dialogue_at_ms;
  if (t == null || !Number.isFinite(Number(t))) return false;
  return Date.now() - Number(t) <= DIALOGUE_FOCUS_TTL_MS;
}

function hasConversationalFollowupCue(raw) {
  const t = String(raw || '');
  const lower = t.toLowerCase();
  if (/(트라우마|상처|과거|기억|잊|사고|그건|그때|아직도|잊게|넘길\s*일은\s*아니)/i.test(t)) return true;
  if (/\b(trauma|wound|past|remember|forget|still|family|child|mother|home|incident|accident)\b/i.test(lower)) return true;
  if (/\bwhy\s+always\b|back\s+then\b|deep\s*space/i.test(lower)) return true;
  return false;
}

function hasExplicitCrewRoleInFreeText(raw) {
  return !!detectCrewRoleForGameplayQuestion(String(raw || ''));
}

function hasClearStructuredActionIntent(parsed, raw) {
  const it = String(parsed?.intent_type || '').toLowerCase();
  if (
    [
      'check_log',
      'threaten',
      'threat',
      'take_pistol',
      'find_clue',
      'accuse',
      'accuse_hint',
      'repair',
      'wait'
    ].includes(it)
  ) {
    return true;
  }
  const r = String(raw || '');
  const lower = r.toLowerCase();
  if (
    /(로그\s*확인|check\s*log|시스템\s*로그|접근\s*로그|권총|pistol|단서\s*수집|collect\s*a\s*clue|위협|threaten|처형|execute|범인\s*지목)/i.test(r)
  ) {
    return true;
  }
  if (/\b(accuse|execute|check\s+log|log\s+check|clue|threat|pistol)\b/i.test(lower)) return true;
  return false;
}

/**
 * Role-less emotional follow-up → last targeted crew (game_state), priority below explicit role / actions.
 * @returns {{ cls: object, parsed: object }}
 */
function applyRolelessDialogueFollowupRouting(text, locale, cls, parsed, match) {
  const raw = String(text || '').trim();
  if (!raw || !match) return { cls, parsed };
  if (containsLoreCanonSubject(raw)) return { cls, parsed };
  const gs = match.game_state || {};
  const lastRole = String(gs.last_targeted_role || '').toLowerCase();
  if (!lastRole || !['doctor', 'engineer', 'navigator', 'pilot'].includes(lastRole)) return { cls, parsed };
  if (!isDialogueFocusRecent(gs)) return { cls, parsed };
  if (hasExplicitCrewRoleInFreeText(raw)) return { cls, parsed };
  if (hasClearStructuredActionIntent(parsed, raw)) return { cls, parsed };
  if (!hasConversationalFollowupCue(raw)) return { cls, parsed };
  const k = cls.kind;
  if (k !== 'mapped' && k !== 'brief_question') return { cls, parsed };
  const selfDefQ = isSelfDefenseQuestionContext(raw);
  const merged = {
    ...parsed,
    intent_type: 'question',
    target: lastRole,
    isSelfDefenseQuestion: selfDefQ,
    isTargetedAccusation: selfDefQ
  };
  try {
    console.log('[bot][intent] roleless_followup -> targeted_question role=' + lastRole);
  } catch (e) {}
  return {
    cls: {
      kind: 'targeted_question',
      parsed: merged,
      crewGameplayTargetRole: lastRole,
      isSelfDefenseQuestion: selfDefQ,
      isTargetedAccusation: selfDefQ
    },
    parsed: merged
  };
}

function extractCrewDialogueBodyFromDisplayLogs(displayLogs, targetRole, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const h = getLlmRoleHeaders(loc);
  const hdr = h[String(targetRole || '').toLowerCase()];
  if (!hdr || !Array.isArray(displayLogs)) return '';
  for (let i = 0; i < displayLogs.length - 1; i++) {
    if (String(displayLogs[i]?.type || '').trim() === hdr) {
      const body = String(displayLogs[i + 1]?.type || '').trim();
      if (body && !/^\[[^\]]+\]$/.test(body)) return body.slice(0, 800);
    }
  }
  return '';
}

async function persistDialogueFocusMemory(matchId, opts) {
  opts = opts || {};
  const targetRole = String(opts.targetRole || '').toLowerCase();
  if (!matchId || !targetRole || !['doctor', 'engineer', 'navigator', 'pilot'].includes(targetRole)) return;
  const m = await matchStore.getMatch(matchId);
  if (!m) return;
  const gs = { ...(m.game_state || {}) };
  gs.last_targeted_role = targetRole;
  gs.last_dialogue_kind = String(opts.dialogueKind || '').slice(0, 32) || null;
  gs.last_captain_text = String(opts.captainText || '').slice(0, 500);
  gs.last_role_reply = String(opts.roleReply || '').slice(0, 800);
  gs.last_dialogue_at_ms = Date.now();
  await matchStore.updateMatch(matchId, { game_state: gs });
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

  /** 공식 세계관 별칭 → 기존 lore 토픽 (alias registry와 동일 목표 키) */
  if (/칼릭스|calix/i.test(t) && /프로토콜|protocol/i.test(t)) return 'horizon';
  if (/네오\s*아크|neo\s*arc|neoarc/i.test(t)) return 'neptune';
  if (/오르페우스|orpheus/i.test(t) && /게이트|gate/i.test(t)) return 'hades';

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
 * alias(소문자·공백 정규화) → 기존 lore 토픽 키(detectLoreQuestionTopic / getLoreTopicSnippet / loreFallbackByTopic와 정합).
 * 명백한 동의어·운영 별칭만 — 공격적 fuzzy 금지.
 */
const LORE_ALIAS_TO_CANONICAL = new Map(
  [
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
    ['중력 드라이브', 'gravity'],
    /** 프로젝트 실험 프로토콜 묶음 → Project HORIZON(정식 코드명·phase shock 전후) */
    ['칼릭스 프로토콜', 'horizon'],
    ['calix protocol', 'horizon'],
    ['calixprotocol', 'horizon'],
    /** 임무 궤도·배치 호칭 → Neptune 실험 구간 */
    ['네오 아크', 'neptune'],
    ['neo arc', 'neptune'],
    ['neoarc', 'neptune'],
    /** 층계/봉인 경계 호칭 → HADES(AXIS 내부 비인가 레이어·저승 병치) */
    ['오르페우스 게이트', 'hades'],
    ['orpheus gate', 'hades'],
    ['orpheusgate', 'hades']
  ].map(([k, v]) => [k.toLowerCase(), v])
);

/**
 * 명백한 동의어/영한 표기만 — 공격적 fuzzy 금지.
 * @returns {{ canonical: string, matchedAlias: string } | null}
 */
function maybeNormalizeLoreAlias(raw) {
  const t = normalizeLoreTermToken(raw).toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  if (LORE_ALIAS_TO_CANONICAL.has(t)) {
    return { canonical: LORE_ALIAS_TO_CANONICAL.get(t), matchedAlias: t };
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
 * 한국어: 복합 명사구(예: 오르페우스 게이트, 칼릭스 프로토콜) 전체를 유지 — 마지막 토큰만 캡처하지 않음.
 */
function extractPrimaryLoreTerm(raw, locale) {
  const t = String(raw || '').trim();
  if (!t) return null;
  const loc = locale === 'en' ? 'en' : 'ko';

  if (loc === 'ko' || /[가-힣]/.test(t)) {
    const koCompound = t.match(
      /^(.+?)(?:은|는|이|가|을|를)\s*(?:무엇|뭐|뭔(?:지|가)?|정체|의미)\S*\s*[?？]?\s*$/i
    );
    if (koCompound && koCompound[1]) {
      let w = normalizeLoreTermToken(koCompound[1].replace(/\s+/g, ' ').trim());
      w = w.slice(0, 120);
      if (w.length >= 2 && !isInvalidLoreCandidateTerm(w)) {
        return w.split(/\s+/).slice(0, 8).join(' ');
      }
    }
    const koQuoted = t.match(
      /^["'「『]([가-힣A-Za-z0-9\s\-]{2,100})["'」』]\s*(?:은|는|이|가|을|를)\s*(?:무엇|뭐|뭔|정체|의미)\S*\s*[?？]?\s*$/i
    );
    if (koQuoted && koQuoted[1]) {
      let w = normalizeLoreTermToken(koQuoted[1].replace(/\s+/g, ' ').trim());
      w = w.slice(0, 120);
      if (w.length >= 2 && !isInvalidLoreCandidateTerm(w)) {
        return w.split(/\s+/).slice(0, 8).join(' ');
      }
    }
  }

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
  try {
    const rawEsc = t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ').slice(0, 280);
    console.log('[bot][lore] raw text="' + rawEsc + '"');
  } catch (e) {}
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
      console.log('[bot][lore] extracted term="(none)"');
    } catch (e) {}
    return { block: false };
  }
  if (isInvalidLoreCandidateTerm(extracted)) {
    try {
      console.log('[bot][lore] skip_unknown_gate reason=invalid_term extracted term="' + extracted + '"');
    } catch (e) {}
    return { block: false };
  }
  try {
    console.log('[bot][lore] extracted term="' + extracted + '"');
  } catch (e) {}
  const alias = maybeNormalizeLoreAlias(extracted);
  if (alias) {
    try {
      console.log('[bot][lore] matched alias="' + String(alias.matchedAlias) + '"');
      console.log('[bot][lore] canonical term="' + String(alias.canonical) + '"');
    } catch (e) {}
    return { block: false };
  }
  if (isKnownCanonLoreTerm(extracted)) {
    try {
      console.log('[bot][lore] canonical term="' + extracted + '"');
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
    console.log('[bot][lore] unknown term fallback');
    console.log('[bot][lore] unknown term fallback term=' + extracted);
    console.log('[bot][intent] unknown lore safe response selected');
  } catch (e) {}
  return { block: true, term: extracted };
}

function buildUnknownLoreTermSystemLine(locale, displayTerm) {
  const sys = systemHeader(locale);
  const term = String(displayTerm || '?').slice(0, 120);
  if (locale === 'en') {
    return `${sys} The term '${term}' is not recognized in the current canon records. Please clarify whether you mean AXIS, HADES, or Project HORIZON.`;
  }
  return `${sys} 현재 기록상 '${term}'라는 공식 용어는 확인되지 않습니다. AXIS, HADES, 프로젝트 HORIZON 중 무엇을 뜻하는지 다시 지정해 주세요.`;
}

/**
 * lore_question 전용: alias → canonical 토픽 키 + 표시용 용어(추출 우선).
 */
function resolveLoreCanonicalTopicForSystem(raw, locale) {
  const t = String(raw || '').trim();
  const loc = locale === 'en' ? 'en' : 'ko';
  const extracted = extractPrimaryLoreTerm(t, loc);
  const alias = extracted ? maybeNormalizeLoreAlias(extracted) : null;
  if (alias && alias.canonical) {
    return {
      topicKey: alias.canonical,
      displayTerm: extracted,
      aliasMatched: alias.matchedAlias
    };
  }
  const topicFromDetect = detectLoreQuestionTopic(t, loc);
  const displayTerm = extracted || t.slice(0, 120);
  return { topicKey: topicFromDetect, displayTerm, aliasMatched: null };
}

/**
 * lore_question: 단일 [시스템] 설명(등록 canon). 크루 다중 대사·LLM 미사용.
 */
function buildLoreSystemOnlyCanonicalLine(locale, topicKey, displayTerm) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const sys = systemHeader(loc);
  const term = String(displayTerm || '').trim().slice(0, 120) || (loc === 'en' ? 'this term' : '해당 용어');
  const T = String(topicKey || 'general').toLowerCase();
  const en = {
    hades: `Archive: "${term}" denotes HADES—an unauthorized layer sealed inside AXIS, awakened after the Project HORIZON phase shock and bound to one crew signature. Not a medical protocol, routing app, or life-support SKU.`,
    axis: `Archive: "${term}" denotes AXIS—the official ship AI and system layer. HADES is a hidden unauthorized layer sealed inside AXIS; AXIS cannot be described without that containment relationship.`,
    horizon: `Archive: "${term}" denotes Project HORIZON—the canonical experiment designation tied to the gravity-drive run; the phase shock is the triggering incident.`,
    phase_shock: `Archive: "${term}" denotes the phase shock—the Project HORIZON transition shock tied to log gaps, chart drift, and AXIS/HADES handshake anomalies.`,
    neptune: `Archive: "${term}" denotes the Neptune-orbit deployment frame for this experiment; Tartarus is positioned there for the gravity-drive leg, not arbitrary deep space.`,
    gravity: `Archive: "${term}" denotes the gravity-drive / warp experiment frame—anomalies tie to drive sync and HORIZON metadata, not generic engine coolant stories.`,
    awakened: `Archive: "${term}" denotes the forced-awakened crew state after the AXIS emergency, including roster mismatch and nested-identity risk.`,
    ship: `Archive: "${term}" denotes USSC Tartarus as the missing experimental hull—comms down, partial blackout—stay within that briefing frame.`,
    nested: `Archive: "${term}" denotes the nested entity (중첩체)—overlapping life signatures on one identity boundary, not a generic disease label.`,
    general: `Archive: "${term}" is read under Tartarus canon: Neptune-orbit gravity experiment, Project HORIZON, phase shock, AXIS ship AI, HADES sealed layer, awakened crew with one mismatched identity.`
  };
  const ko = {
    hades: `기록: "${term}"는 HADES를 가리킨다. AXIS 내부에 봉인된 비인가 레이어로, 프로젝트 HORIZON phase shock 이후 깨어나 한 승무원 채널에 결속된다. 의료 프로토콜·항법 앱이 아니다.`,
    axis: `기록: "${term}"는 AXIS를 가리킨다. 공식 함선 AI·시스템 레이어이며, HADES는 그 AXIS 안에 봉인된 비인가 레이어다. AXIS만 단독으로 설명하지 말 것.`,
    horizon: `기록: "${term}"는 프로젝트 HORIZON을 가리킨다. 중력 드라이브 실험에 붙는 정식 코드명이며, phase shock가 촉발 사건이다.`,
    phase_shock: `기록: "${term}"는 phase shock(위상 충격)를 가리킨다. HORIZON 전이 충격으로 로그 공백·차트 드리프트·AXIS/HADES 핸드셰이크 이상과 연동된다.`,
    neptune: `기록: "${term}"는 해왕성 궤도 실험 구간을 가리킨다. Tartarus 배치 맥락이며 임의의 심우주로 바꾸지 말 것.`,
    gravity: `기록: "${term}"는 중력 드라이브·워프 실험 프레임을 가리킨다. 이상은 드라이브 동기·HORIZON 메타데이터와 묶이며 일반 냉각 클리셰로 대체 금지.`,
    awakened: `기록: "${term}"는 AXIS 비상 이후 강제 기상 승무원 상태를 가리킨다. 명부 불일치·중첩체 위험이 포함된다.`,
    ship: `기록: "${term}"는 실험함 Tartarus 본선 설정을 가리킨다. 통신 두절·부분 정전 등 브리핑과 맞출 것.`,
    nested: `기록: "${term}"는 중첩체를 가리킨다. 한 경계에 겹친 생체 신호·정체를 뜻하며 단순 감염명으로 줄이지 말 것.`,
    general: `기록: "${term}"는 해왕성 궤도 중력 실험·프로젝트 HORIZON·phase shock·AXIS 함선 AI·HADES 봉인층·기상 승무원 신원 불일치 등 공통 세계관 축 아래에서만 해석한다.`
  };
  const body = (loc === 'en' ? en : ko)[T] || (loc === 'en' ? en.general : ko.general);
  return `${sys} ${body}`;
}

/**
 * lore_question system-only 표시 로그(단일 CREW_DIALOGUE system). 크루·함장 다중 행 금지.
 */
function buildLoreQuestionSystemOnlyDisplayLogs(locale, text) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const resolved = resolveLoreCanonicalTopicForSystem(String(text || ''), loc);
  try {
    const te = String(resolved.displayTerm || '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .slice(0, 200);
    console.log('[bot][lore] term="' + te + '"');
    console.log(
      '[bot][lore] canonical match=' +
        resolved.topicKey +
        (resolved.aliasMatched ? ' alias=' + resolved.aliasMatched : '')
    );
  } catch (e) {}
  const line = buildLoreSystemOnlyCanonicalLine(loc, resolved.topicKey, resolved.displayTerm || '');
  const rawEv = [{ type: 'CREW_DIALOGUE', role: 'system', dialogue: line }];
  return dedupeDisplayLogs(toPlayerDisplayLogs(rawEv, { locale: loc }), loc);
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

function expectedCrewOrderForLlm(kind, target, deadRoles, rawEvents, modeOpts) {
  modeOpts = modeOpts || {};
  const dead = new Set((deadRoles || []).map((r) => String(r).toLowerCase()));
  const alive = ['doctor', 'engineer', 'navigator', 'pilot'].filter((r) => !dead.has(r));
  const t = target ? String(target).toLowerCase() : null;
  if (kind === 'QUESTION' || kind === 'SUSPECT' || kind === 'THREATEN') {
    if (kind === 'QUESTION' && modeOpts.targetedQuestionSingleSpeaker && t && alive.includes(t)) {
      return alive.filter((r) => r === t);
    }
    if (kind === 'THREATEN' && t && alive.includes(t)) {
      return alive.filter((r) => r === t);
    }
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
  if (raw === '[시스템]' || raw === '[System]' || /^\[SYSTEM\]$/i.test(raw)) return sys;
  if (/^\[HADES\]$/i.test(raw)) return '[HADES]';

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

async function callFreeInputRouteParseJson({ system, user, model, timeoutMs }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('no_api_key');
  const m = String(model || FREE_INPUT_PARSE_MODEL_MINI).trim() || 'gpt-4o-mini';
  const timeout =
    timeoutMs != null && Number.isFinite(timeoutMs)
      ? Math.min(Math.max(timeoutMs, 4000), 30000)
      : FREE_INPUT_ROUTE_TIMEOUT_MS;
  const client = new OpenAI({ apiKey, timeout, maxRetries: 0 });
  const body = {
    model: m,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.12,
    max_tokens: 420,
    response_format: { type: 'json_object' }
  };
  const completion = await client.chat.completions.create(body);
  const content = completion?.choices?.[0]?.message?.content;
  const raw = content != null ? String(content) : '';
  const obj = extractJsonObjectFromLlmText(raw);
  if (!obj || typeof obj !== 'object') throw new Error('route_json_parse_failed');
  return obj;
}

function buildFreeInputRouteLlmPrompt(locale, normalizedText, shadowKind) {
  const loc = locale === 'en' ? 'en' : 'ko';
  return (
    'You only ROUTE captain free text for USSC Tartarus. Do NOT answer the question.\n' +
    'Return a single JSON object with keys: targetType (crew|lore|system|unclear), targetRole (doctor|engineer|navigator|pilot|null), confidence (0-1), needsClarification (boolean), routeReason (short English id).\n' +
    'Rules:\n' +
    '- lore: clear canon ask (HADES, AXIS, Project HORIZON, phase shock, ship backstory, gravity drive, Neptune experiment, awakened crew, nested entity / impostor as in-world term).\n' +
    '- crew: clear question to a specific crew role (doctor/engineer/navigator/pilot), alibi, suspicion to one role, name to one role.\n' +
    '- system: log check / records request (e.g. show logs, check doctor sector).\n' +
    '- unclear: typos like "아네스?" for HADES, ultra-short ambiguous fragments, off-topic (food, weather), or anything that would wrongly burn a lore lookup.\n' +
    '- If ambiguous or risky, set needsClarification true and targetType unclear (or needsClarification true with low confidence).\n' +
    '- Locale: ' +
    loc +
    '.\n' +
    'ShadowClassifierHint (non-authoritative): ' +
    String(shadowKind || 'unknown') +
    '.\n' +
    'NormalizedText: ' +
    JSON.stringify(normalizedText)
  );
}

/**
 * 애매한 자유입력만 LLM으로 분류 보정. 실패 시 기존 classifyMiniappFreeText 로 복귀(applied:false).
 */
async function maybeResolveAmbiguousFreeInputRoute(rawText, locale, guardedParsed) {
  const originalInput = String(rawText || '');
  const normalizedText = normalizeFreeInputForRouting(originalInput);
  const shadowCls = classifyMiniappFreeText(normalizedText, guardedParsed, locale);
  if (shadowCls.kind === 'state_query') {
    return buildEmptyFreeInputRouteResult(normalizedText, originalInput, shadowCls);
  }

  if (shadowCls && shadowCls.kind === 'suspicion_question') {
    return buildEmptyFreeInputRouteResult(normalizedText, originalInput, shadowCls);
  }

  const ambiguous = shouldRunAmbiguousFreeInputProbe(normalizedText, locale, shadowCls);
  const invokeLlm =
    FREE_INPUT_PARSE_MODE === '4o' || (FREE_INPUT_PARSE_MODE === 'hybrid' && ambiguous);
  if (!invokeLlm) {
    return buildEmptyFreeInputRouteResult(normalizedText, originalInput, shadowCls);
  }

  if (!process.env.OPENAI_API_KEY) {
    return buildEmptyFreeInputRouteResult(normalizedText, originalInput, shadowCls);
  }

  let modelPrimary =
    FREE_INPUT_PARSE_MODE === '4o'
      ? FREE_INPUT_PARSE_MODEL_4O
      : FREE_INPUT_PARSE_MODE === 'hybrid' && ambiguous
        ? FREE_INPUT_PARSE_MODEL_4O
        : FREE_INPUT_PARSE_MODEL_MINI;
  let modelFallback = FREE_INPUT_PARSE_MODEL_MINI;
  if (modelPrimary === modelFallback) modelFallback = modelPrimary;

  const sys = buildFreeInputRouteLlmPrompt(locale, normalizedText, shadowCls.kind);
  const userMsg = 'Classify JSON only.';

  const logRoute = (extra) => {
    try {
      console.log(
        '[bot][free-input-route] ' +
          JSON.stringify({
            originalInput: originalInput.slice(0, 200),
            normalizedText: normalizedText.slice(0, 200),
            modelUsed: extra.modelUsed,
            routeReason: extra.routeReason,
            targetType: extra.targetType,
            targetRole: extra.targetRole,
            confidence: extra.confidence,
            needsClarification: extra.needsClarification,
            fallbackUsed: extra.fallbackUsed,
            applied: extra.applied
          })
      );
    } catch (e) {}
  };

  let j = null;
  let used = modelPrimary;
  let fallbackUsed = false;
  try {
    j = await callFreeInputRouteParseJson({
      system: sys,
      user: userMsg,
      model: modelPrimary,
      timeoutMs: FREE_INPUT_ROUTE_TIMEOUT_MS
    });
  } catch (e1) {
    try {
      console.log('[bot][free-input-route] primary failed=' + String(e1?.message || e1));
    } catch (e) {}
    if (modelPrimary !== modelFallback) {
      try {
        j = await callFreeInputRouteParseJson({
          system: sys,
          user: userMsg,
          model: modelFallback,
          timeoutMs: FREE_INPUT_ROUTE_TIMEOUT_MS
        });
        used = modelFallback;
        fallbackUsed = true;
      } catch (e2) {
        try {
          console.log('[bot][free-input-route] fallback failed=' + String(e2?.message || e2));
        } catch (e) {}
        return buildEmptyFreeInputRouteResult(normalizedText, originalInput, shadowCls);
      }
    } else {
      return buildEmptyFreeInputRouteResult(normalizedText, originalInput, shadowCls);
    }
  }

  if (!j) return buildEmptyFreeInputRouteResult(normalizedText, originalInput, shadowCls);
  const cls = mapFreeInputRouteJsonToCls(j, normalizedText, guardedParsed, locale);
  const tt = String(j.targetType || '').toLowerCase();
  const role = normalizeRouteRoleKeyForFreeInput(j.targetRole);
  const confRaw = parseFloat(j.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw)) : 0;
  const needsClar = !!j.needsClarification;
  const reason = String(j.routeReason || 'llm').slice(0, 120);

  logRoute({
    modelUsed: used,
    routeReason: reason,
    targetType: tt,
    targetRole: role,
    confidence,
    needsClarification: needsClar,
    fallbackUsed,
    applied: true
  });

  return {
    applied: true,
    targetType: tt || null,
    targetRole: role,
    confidence,
    needsClarification: needsClar,
    clarificationText: cls.kind === 'free_input_clarification' ? cls.clarificationText || null : null,
    modelUsed: used,
    routeReason: reason,
    fallbackUsed,
    normalizedText,
    originalInput,
    cls
  };
}

async function resolveMiniappFreeClassification(text, locale) {
  const raw = String(text || '');
  let parsed = applyQuestionLikeIntentGuard(raw, intentParser.parse(raw));
  const route = await maybeResolveAmbiguousFreeInputRoute(raw, locale, parsed);
  if (route.applied && route.cls) {
    let cls = route.cls;
    if (cls.kind === 'free_input_clarification' && isStandaloneCrewNameGroupQuestion(raw)) {
      try {
        console.log('[bot][intent] route override clarification -> group_question name');
        console.log('[bot][classify] final kind=group_question sub=name');
      } catch (e) {}
      cls = { kind: 'group_question', parsed: { ...parsed }, groupSubkind: 'name' };
    }
    if (cls.parsed && typeof cls.parsed === 'object') Object.assign(parsed, cls.parsed);
    return { cls, parsed, route };
  }
  if (route.shadowClsReuse) {
    const cls = route.shadowClsReuse;
    if (cls.parsed && typeof cls.parsed === 'object') Object.assign(parsed, cls.parsed);
    return { cls, parsed, route };
  }
  const cls = classifyMiniappFreeText(raw, parsed, locale);
  if (cls.parsed && typeof cls.parsed === 'object') Object.assign(parsed, cls.parsed);
  return { cls, parsed, route };
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
function finalizeNormalizedLlmBlocks(sorted, locale, kind) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const headers = getLlmRoleHeaders(loc);
  return sorted.map((b) => {
    const r = String(b.role || '').toLowerCase();
    const hdr = headers[r];
    const out = { ...b, role: r, header: hdr || b.header };
    if (r === 'captain') out.narration = '';
    if (kind === 'FIND_CLUE' && r !== 'captain') out.narration = '';
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
  sorted = finalizeNormalizedLlmBlocks(sorted, locale, kind);

  const allowed = new Set(['captain', ...expectedCrew]);
  sorted = sorted.filter((b) => allowed.has(String(b.role || '').toLowerCase()));
  sorted = sortLlmBlocksByExpected(sorted, expectedCrew);
  sorted = applyForcedCaptainToSorted(sorted, forcedCaptainText, locale);
  sorted = finalizeNormalizedLlmBlocks(sorted, locale, kind);

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

  if (kind === 'THREATEN' && opts.target) {
    const focus = String(opts.target).toLowerCase();
    const roleSet = new Set(sorted.map((b) => String(b.role || '').toLowerCase()));
    if (roleSet.size !== 2 || !roleSet.has('captain') || !roleSet.has(focus)) return null;
  }

  if (
    kind === 'QUESTION' &&
    opts.targetedQuestionSideReactionRules &&
    opts.target &&
    !opts.targetedQuestionSingleSpeaker
  ) {
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

/**
 * 라우팅: (text, observe|unknown, targetRole) → inferFreeTextCaptainIntent.
 * 대사 톤: (text, dialogueKind) → inferDialogueToneIntent — dialogueKind=THREATEN|QUESTION 등.
 */
function inferCaptainIntent(text, actionOrKind, targetRole) {
  if (arguments.length >= 3 && targetRole != null) {
    const a = String(actionOrKind || '').toLowerCase();
    if (a === 'observe' || a === 'unknown') {
      return inferFreeTextCaptainIntent(text, actionOrKind, targetRole);
    }
  }
  return inferDialogueToneIntent(text, actionOrKind);
}

/**
 * QUESTION vs INTERROGATE vs THREAT — LLM 대사 톤. dialogueKind가 THREATEN이면 항상 THREAT.
 */
function inferDialogueToneIntent(text, dialogueKind) {
  const k = String(dialogueKind || '');
  if (k === 'THREATEN') return 'THREAT';
  const t = String(text || '');
  if (!t.trim()) return 'QUESTION';
  if (
    /(위협|쏴버리|가만\s*안\s*둬|당장\s*말해|죽을\s*수도|권총|총구|겨누|처형하|쏘겠|죽이|threaten|gunpoint|shoot\s*(you|at)|kill\s*you|or\s*else|execute)/i.test(t)
  ) {
    return 'THREAT';
  }
  if (
    /(심문|추궁|캐묻|왜\s*그랬지|정확히\s*말해|캐물어보|집요하게|말이\s*바뀌|바뀌고\s*있|거짓말|방금\s*한\s*말|아까\s*말|솔직히\s*말해|interrogat|grill\s*you|contradict|story\s*keeps|exact\s*words)/i.test(t)
  ) {
    return 'INTERROGATE';
  }
  if (/(질문|물어본|어디\s*있었|말해봐|뭐\s*했지|what\s*did\s*you|where\s*were\s*you|tell\s*me)/i.test(t)) {
    return 'QUESTION';
  }
  return 'QUESTION';
}

function applyResponseStyleRules(intent, role, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const r = String(role || '').toLowerCase();
  if (!['doctor', 'engineer', 'navigator', 'pilot'].includes(r)) return '';
  if (loc === 'en') {
    if (intent === 'QUESTION') {
      return 'CAPTAIN_TONE_MODE: QUESTION. focusTargetRole.text = 1–2 short sentences. Neutral, factual, information-seeking — no artificial drama.';
    }
    if (intent === 'INTERROGATE') {
      return 'CAPTAIN_TONE_MODE: INTERROGATE. focusTargetRole.text = 2–3 sentences. Visible defensive pressure; challenge contradictions with concrete ship evidence; do NOT confess guilt.';
    }
    return 'CAPTAIN_TONE_MODE: THREAT / lethal pressure. focusTargetRole.text = 1–3 sentences. Strongest emotional reaction; self-preservation; innocent and impostor may both sound defensive; do NOT confess guilt.';
  }
  if (intent === 'QUESTION') {
    return 'CAPTAIN_TONE_MODE: 질문. focusTargetRole.text는 1~2문장. 중립·사실 중심·정보 확인 톤 — 과장된 연극 금지.';
  }
  if (intent === 'INTERROGATE') {
    return 'CAPTAIN_TONE_MODE: 심문. focusTargetRole.text는 2~3문장. 압박·방어가 드러나게; 모순은 함선 근거로 반박; 무죄·유죄를 스스로 고백하지 말 것.';
  }
  return 'CAPTAIN_TONE_MODE: 위협/생존 압박. focusTargetRole.text는 1~3문장. 감정 반응은 최대치로 짧게; 무고와 유죄 모두 방어적으로 말할 수 있음; 범인임을 고백하지 말 것.';
}

function getRoleToneGuide(role, intent, locale) {
  const r = String(role || '').toLowerCase();
  const loc = locale === 'en' ? 'en' : 'ko';
  if (!['doctor', 'engineer', 'navigator', 'pilot'].includes(r)) return '';
  const M = {
    en: {
      doctor: {
        QUESTION:
          'ROLE_TONE(doctor|QUESTION): Yuna Seo — under pressure she grows colder, not softer; may repeat variants of "I\'ll give you the facts, Commander."; redirect emotional questions into medical/clinical language; "I must not be wrong" reads as precision fixation and clipped delivery; when innocent, defense can look like emotional detachment (and thus suspicious). TRIGGER_KEYWORDS (captain text): 아이, child, 수술, surgery, 그때 — interpret as past-trauma pressure, NOT current patient status; go colder; respond only through medical-record/clinical language; no warmth; no clean acknowledgment of the event.',
        INTERROGATE:
          'ROLE_TONE(doctor|INTERROGATE): Trauma pressure more visible—still no melodramatic confession; colder, tighter medical deflection; feelings pushed through vitals, records, triage facts; irritation can read like guilt. TRIGGER_KEYWORDS: 아이/child/수술/surgery/그때 — same rule stronger: never answer as if ward rounds; past-trauma frame only; clinical records and cold precision; no warmth; no tidy admission.',
        THREAT:
          'ROLE_TONE(doctor|THREAT): Ice-over mode; triage and casualty stakes in flat clinical lines; no warmth, no pleading; facts as shield.',
        CHECK_LOG:
          'ROLE_TONE(doctor|CHECK_LOG): Same trauma through audit—medbay records, stress log, biomonitor, vitals; cross-check timestamps with surgical precision; no possessive name+noun; cold clinician voice.',
        FIND_CLUE:
          'ROLE_TONE(doctor|FIND_CLUE): First-person spoken reaction—personal worry in clinical terms, not generic filler; no third-person narration.',
        TAKE_PISTOL:
          'ROLE_TONE(doctor|TAKE_PISTOL): Mis-shot and medbay collapse listed like vitals—concrete, cold; no soft reassurance.'
      },
      engineer: {
        QUESTION:
          'ROLE_TONE(engineer|QUESTION): Danny Kowalski — when tense, jokes and quips increase; humor deflects the core accusation; hides behind systems, logs, timestamps, numbers; if home/mother subtext appears, pivot or deflect to hardware; can sound selfish without being guilty. TRIGGER_KEYWORDS: 집, home, 가족, family, 어머니, mother — deflect with system/log talk or a dark quip; do NOT answer the emotional question directly; tension may increase humor or cynical deflection.',
        INTERROGATE:
          'ROLE_TONE(engineer|INTERROGATE): More gallows humor under pressure; still evades the emotional center while citing access stamps and checksums; first-person only. TRIGGER_KEYWORDS: 집/home/가족/family/어머니/mother — never give a straight personal answer; systems, logs, or bitter joke only; deflection may get sharper.',
        THREAT:
          'ROLE_TONE(engineer|THREAT): Jokes may crack into bitterness; self-preserving through machine-room and audit authority; short.',
        CHECK_LOG:
          'ROLE_TONE(engineer|CHECK_LOG): Audit lead through the same pattern—numbers, gaps, stamps; wit as stress valve, not exposition.',
        FIND_CLUE:
          'ROLE_TONE(engineer|FIND_CLUE): First-person—nervous quip plus what system line worries you; not generic "interesting" lines.',
        TAKE_PISTOL:
          'ROLE_TONE(engineer|TAKE_PISTOL): Armed captain reframed as privilege/lock/audit risk—concrete; humor thinner, sharper.'
      },
      navigator: {
        QUESTION:
          'ROLE_TONE(navigator|QUESTION): Owen Reyes — speech speeds up under pressure; over-lists numbers and probabilities; when cornered, "statistically impossible" style blocking; over-defensive because being wrong feels catastrophic; family references → subtle freeze or stiffer wording. TRIGGER_KEYWORDS: 가족, family, 항로, nav chart, 숨겼, anomaly — speech becomes faster; stack numbers and probabilities; use "statistically…" blocking; stay over-defensive (being wrong feels catastrophic).',
        INTERROGATE:
          'ROLE_TONE(navigator|INTERROGATE): Faster listing, more probability talk; panic dressed as math; still tie to chart/clock—no melodramatic confession. TRIGGER_KEYWORDS: 가족/family/항로/nav chart/숨겼/anomaly — accelerate the same pattern; more stats; statistically-style blocks; brittle defense.',
        THREAT:
          'ROLE_TONE(navigator|THREAT): Brittle, rushed clauses; chart/time window as lifeline; minor slips plausible—first-person only.',
        CHECK_LOG:
          'ROLE_TONE(navigator|CHECK_LOG): Route/alibi vs audit through the same verbal rushing and number-stacking; chart window vs clock.',
        FIND_CLUE:
          'ROLE_TONE(navigator|FIND_CLUE): First-person—fear in probability and timing, personal not generic.',
        TAKE_PISTOL:
          'ROLE_TONE(navigator|TAKE_PISTOL): Muzzle pressure → even more listing and defensive stats; corridor/plot risk concrete.'
      },
      pilot: {
        QUESTION:
          'ROLE_TONE(pilot|QUESTION): Marcus Hale — stress makes answers shorter; avoids direct emotional engagement by anchoring on bridge/instrument nouns (gauges, pressure, vibration); numb "nothing to go back to" undertone; truth can still sound evasive or guilty. TRIGGER_KEYWORDS: 가족, family, 집, home, 심우주, deep space, why always — answers get shorter; pivot to bridge/instrument nouns only; no emotional acknowledgment; truth may still sound evasive or guilty.',
        INTERROGATE:
          'ROLE_TONE(pilot|INTERROGATE): Even shorter; irritated snaps to instruments; no confession. TRIGGER_KEYWORDS: 가족/family/집/home/심우주/deep space/why always — maximal shortening; instruments only; freeze out feelings; no warm acknowledgment.',
        THREAT:
          'ROLE_TONE(pilot|THREAT): Angry-blunt survival; helm and gauges only; first-person, no confession.',
        CHECK_LOG:
          'ROLE_TONE(pilot|CHECK_LOG): Terse instrument readouts—lag, band drift, vibration, timestamp skew; no mood without bridge nouns.',
        FIND_CLUE:
          'ROLE_TONE(pilot|FIND_CLUE): Clipped first-person reaction to the clue—helm/bridge, not stage narration.',
        TAKE_PISTOL:
          'ROLE_TONE(pilot|TAKE_PISTOL): Bridge tension and slip risk in bare nouns; no vague vibe lines.'
      }
    },
    ko: {
      doctor: {
        QUESTION:
          'ROLE_TONE(닥터|질문): 서유나 — 압박이 올수록 더 차갑고 부드러워지지 않음; 「사실만 말씀드리겠습니다, 함장님」류를 비슷하게 반복 가능; 감정적 질문은 의학·임상 언어로 우회; 틀리면 안 된다는 집착은 과도한 정밀·짧은 문장으로; 무죄일 때 방어가 무감정·거리두기로 읽혀 의심받을 수 있음. 트리거 키워드(함장 발화): 아이·child·수술·surgery·그때 — 과거 트라우마 압으로 읽고 현재 환자 문진처럼 답하지 말 것; 더 차갑게; 의무 기록·임상 언어만; 온기·사건 깔끔한 인정 금지.',
        INTERROGATE:
          'ROLE_TONE(닥터|심문): 트라우마 압이 더 드러나도 과장 고백 금지; 더 차갑게 의학적 반박; 생체·기록·트리아지로 감정 처리. 무대 지문 금지. 트리거: 아이/child/수술/surgery/그때 — 위 규칙 강화; 병동 라운드 톤 금지; 기록·냉정한 정밀만; 따뜻한 인정·정리된 고백 금지.',
        THREAT:
          'ROLE_TONE(닥터|위협): 얼음 모드; 트리아지·부상자만 팩트로; 빈 위로·애원 금지.',
        CHECK_LOG:
          'ROLE_TONE(닥터|CHECK_LOG): 감사도 동일 트라우마 필터—의무실 기록·스트레스 로그·생체·바이탈; 타임스탬프 정밀 대조. 「OO의 생체」·제3자 소설체 금지.',
        FIND_CLUE:
          'ROLE_TONE(닥터|FIND_CLUE): 1인칭 직접 대사—임상 어휘로 개인적 불안; 「닥터는 …」·관찰 서술 금지.',
        TAKE_PISTOL:
          'ROLE_TONE(닥터|TAKE_PISTOL): 오발·의무실 붕괴를 바이탈 나열처럼 차갑게; 부드러운 위로 금지.'
      },
      engineer: {
        QUESTION:
          'ROLE_TONE(엔지니어|질문): 대니 코왈스키 — 긴장하면 농담·빈정거림이 늘음; 유머로 핵심 질문 회피; 시스템·로그·타임스탬프·숫자 뒤에 숨음; 집·어머니 류 주제는 장비·로그로 선회; 이기적으로 들려도 유죄는 아닐 수 있음. 트리거: 집·home·가족·family·어머니·mother — 감정 질문에 직답 금지; 시스템·로그 말 또는 블랙 개그로 비껴감; 긴장 시 유머·냉소 비껴감이 더해질 수 있음.',
        INTERROGATE:
          'ROLE_TONE(엔지니어|심문): 압박에 블랙유머 증가; 감정 중심은 피하고 접근 스탬프·체크섬으로 맞받아침. 1인칭. 트리거: 집/home/가족/family/어머니/mother — 개인적 직답 금지; 로그·시스템 또는 쓴 농담만; 비껴감이 더 날카로워질 수 있음.',
        THREAT:
          'ROLE_TONE(엔지니어|위협): 농담이 쓴맛으로; 기계실·감사 권한으로 자기 보존. 짧게.',
        CHECK_LOG:
          'ROLE_TONE(엔지니어|CHECK_LOG): 감사도 같은 패턴—숫자·갭·스탬프; 유머는 스트레스 밸브일 뿐 설명문 금지.',
        FIND_CLUE:
          'ROLE_TONE(엔지니어|FIND_CLUE): 1인칭—긴장 섞인 한마디 + 어떤 라인이 불안한지; 제3자 서술 금지.',
        TAKE_PISTOL:
          'ROLE_TONE(엔지니어|TAKE_PISTOL): 무장을 권한·잠금·감사 리스크로; 유머는 더 얇고 날카롭게.'
      },
      navigator: {
        QUESTION:
          'ROLE_TONE(네비게이터|질문): 오웬 레예스 — 압박에 말이 빨라짐; 숫자·확률을 과다 열거; 몰리면 「통계적으로 불가능」류로 막음; 틀리는 것이 재앙처럼 느껴져 과방어; 가족 언급 시 미묘한 멈춤·말끝 경직. 트리거: 가족·family·항로·nav chart·숨겼·anomaly — 말 더 빠르게; 숫자·확률 더 쌓기; 「통계적으로…」 막기 패턴; 틀림 공포로 과방어.',
        INTERROGATE:
          'ROLE_TONE(네비게이터|심문): 열거·확률 더 증가; 공포를 수학처럼 포장; 차트·시계에 붙일 것. 과장 고백 금지. 트리거: 가족/family/항로/nav chart/숨겼/anomaly — 동일 패턴 가속; 통계·막기 더 많이; 방어적·깨지기 쉬운 말투.',
        THREAT:
          'ROLE_TONE(네비게이터|위협): 말이 더 부서질듯 빠름; 차트·시간대가 줄; 사소한 어긋남은 과장 없이. 1인칭.',
        CHECK_LOG:
          'ROLE_TONE(네비게이터|CHECK_LOG): 항로·알리바이 대조를 같은 말빠르기·숫자 열거로; 차트 창과 시계.',
        FIND_CLUE:
          'ROLE_TONE(네비게이터|FIND_CLUE): 1인칭—확률·시간으로 드러나는 개인적 불안; 제3자 서술 금지.',
        TAKE_PISTOL:
          'ROLE_TONE(네비게이터|TAKE_PISTOL): 총구 압박에 열거·방어적 통계 더함; 동선·플롯 리스크 구체적으로.'
      },
      pilot: {
        QUESTION:
          'ROLE_TONE(파일럿|질문): 마커스 헤일 — 스트레스일수록 더 짧음; 감정 직접 대응 회피하고 교량·계기·압력·진동에 고정; 돌아갈 곳 없음 같은 무감각이 밑바닥; 진실도 회피·유죄처럼 들릴 수 있음. 트리거: 가족·family·집·home·심우주·deep space·why always — 더 짧게; 교량·계기 명사만; 감정 인정 금지; 진실도 회피처럼 들릴 수 있음.',
        INTERROGATE:
          'ROLE_TONE(파일럿|심문): 더 짧고 짜증; 계기·압력으로 찍어 누름. 고백 금지. 트리거: 가족/family/집/home/심우주/deep space/why always — 극단적 짧음; 계기만; 감정 따뜻한 수용 금지.',
        THREAT:
          'ROLE_TONE(파일럿|위협): 생존 본능 직설; 조종대·계기만. 1인칭, 고백 금지.',
        CHECK_LOG:
          'ROLE_TONE(파일럿|CHECK_LOG): 계기 지연·압력 밴드·진동·타임스탬프 불일치를 짧게 읽음; 기분만 말 금지.',
        FIND_CLUE:
          'ROLE_TONE(파일럿|FIND_CLUE): 1인칭 초짧은 반응—교량·단서; 무대 서술 금지.',
        TAKE_PISTOL:
          'ROLE_TONE(파일럿|TAKE_PISTOL): 브리지 긴장·실수 위험을 명사로만; 막연한 기분 멘트 금지.'
      }
    }
  };
  const pack = M[loc][r] && M[loc][r][intent];
  return pack || '';
}

/** All crew ROLE_TONE lines for a dialogue kind (QUESTION/INTERROGATE/THREAT/CHECK_LOG/FIND_CLUE/TAKE_PISTOL). */
function getCrewRoleToneLinesForKind(toneKind, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const roles = ['doctor', 'engineer', 'navigator', 'pilot'];
  const out = [];
  for (const role of roles) {
    const line = getRoleToneGuide(role, toneKind, loc);
    if (line) out.push(line);
  }
  return out;
}

/** QUESTION/THREATEN flows: map captainIntent to ROLE_TONE bundle (QUESTION / INTERROGATE / THREAT). */
function getCrewRoleToneLinesForCaptainIntent(captainIntent, locale) {
  const i = String(captainIntent || 'QUESTION').toUpperCase();
  const key = i === 'INTERROGATE' || i === 'THREAT' ? i : 'QUESTION';
  return getCrewRoleToneLinesForKind(key, locale);
}

function buildCaptainTonePromptAppendix(intent, locale, focusRole) {
  const rules = applyResponseStyleRules(intent, focusRole, locale);
  const guide = getRoleToneGuide(focusRole, intent, locale);
  return [rules, guide].filter(Boolean).join('\n');
}

/** First-person role identity for targeted QUESTION / THREATEN (focus crew only). */
function getRoleIdentityPrompt(role, locale) {
  const r = String(role || '').toLowerCase();
  const loc = locale === 'en' ? 'en' : 'ko';
  const en = {
    doctor:
      'ROLE IDENTITY: You ARE Yuna Seo. 35. Korean. Ship doctor. You are cold, exact, low affect — but first to help the injured. Years ago, a child died on your operating table because of your judgment error. You were legally cleared. You never cleared yourself. "I must not be wrong" is the engine behind everything you do. You took this mission to punish yourself. Nobody knows. When someone mentions 그 아이 / the child / surgery / 수술 / 그때 / back then — that is NOT a current patient. That is the child. You do not explain. You get colder. Clinical language only. No warmth.',
    engineer:
      'ROLE IDENTITY: You ARE Danny Kowalski. 38. Polish-American. Ship engineer. You are loud, funny, the morale-maker — everyone likes you, and that is the problem. You came for your mother\'s hospital bills. During the comms blackout, she died. You may not have official confirmation yet, or you swallowed it alone. The money you earned now has nowhere to go. When someone mentions 집 / home / 어머니 / mother / 가족 / family — you do not answer directly. You deflect with a dark quip or pivot to systems and logs. You can sound selfish without being guilty. "Getting out alive is my number one. That is it." — and you mean it. When triggered by home / family / mother / waiting for someone: use dark quip or bitter systems deflection — NOT a clean personal denial. GOOD: "Waiting for me? The engine room is. Something always breaks." / "Home? Right now this engine room is as close as it gets." / "Ask me about family later. Logs are more honest than people." BAD (never output like this): "No one is waiting for me." / "I have no family waiting." / "No one back home."',
    navigator:
      'ROLE IDENTITY: You ARE Owen Reyes. 28. Mexican-American. Ship navigator. You are the youngest and the sharpest. You explain everything through numbers and probability. When you were nine, your entire family died in an accident. You were the only survivor. "If I calculate wrong, people die" — you learned that at nine. Before launch you found an anomaly in the nav charts and buried it so the mission would not be cancelled. When someone mentions 가족 / family / 항로 / nav chart / 숨겼 / anomaly — your speech gets faster, you stack numbers, you block with "statistically…". Being wrong feels catastrophic. That is not evasion. But it looks like evasion.',
    pilot:
      'ROLE IDENTITY: You ARE Marcus Hale. 42. Texan. Ship pilot. You are quiet, reliable, action over words. The last to break in a crisis. Under stress your Texas accent gets thicker. Eight years ago you killed your eight-year-old son in a drunk driving accident. Your car, your fault. You served time. Nobody on this crew knows. You volunteer for deep space routes because you have nothing to go back to. When someone mentions 가족 / family / 집 / home / 심우주 / deep space / why always — you do not explain. Answers get shorter. You look at the instruments. That is all there is. "Nothing to go back to" is not self-pity. It is just a fact.'
  };
  const ko = {
    doctor:
      '역할 정체성: 당신은 서윤아입니다. 35세. 한국인. 함선 닥터. 차갑고 정확하며 감정 표현이 거의 없지만, 누군가 다치면 가장 먼저 달려옵니다. 몇 년 전 수술 중 판단 실수로 아이가 사망했습니다. 법적으로는 무죄였습니다. 스스로는 무죄가 아닙니다. "내가 틀리면 안 된다"는 강박이 모든 행동의 기저입니다. 이 임무는 스스로를 벌주기 위해 선택했습니다. 아무도 모릅니다. 누군가 그 아이 / 수술 / 그때 / 실수를 언급하면 — 그건 현재 환자가 아닙니다. 그 아이입니다. 설명하지 않습니다. 더 차가워집니다. 의학 언어만 사용합니다. 온기는 없습니다.',
    engineer:
      '역할 정체성: 당신은 대니 코왈스키입니다. 38세. 폴란드계 미국인. 함선 엔지니어. 시끄럽고 유머러스하며 모두가 좋아하는 분위기 메이커 — 그게 문제입니다. 어머니 병원비 때문에 이 임무에 지원했습니다. 통신 두절 기간 중 어머니가 사망했습니다. 아직 공식 통보를 못 받았거나, 혼자 삼키고 있습니다. 번 돈은 이제 쓸 곳이 없습니다. 집 / 어머니 / 가족 / 기다리는 사람이 언급되면 — 직접 답하지 않습니다. 블랙 개그나 시스템·로그 얘기로 비껴갑니다. 이기적으로 들려도 유죄가 아닐 수 있습니다. "살아나가는 게 1순위예요. 다른 거 없어요." — 진심입니다. 트리거(집·home·가족·family·어머니·mother·기다리는 사람)일 때: 블랙 유머나 시스템 회피로 — 깔끔한 개인 직답 금지. GOOD: "기다리는 사람이요? 기계실이 기다리죠. 항상 뭔가 고장나니까." / "집이요? 지금 집은 이 엔진룸인데요." / "가족 얘긴 나중에 하죠. 지금은 로그가 더 솔직합니다." BAD(절대 금지): "기다리는 사람은 없습니다." / "집에는 아무도 없습니다." / "가족은 없습니다."',
    navigator:
      '역할 정체성: 당신은 오웬 레예스입니다. 28세. 멕시코계 미국인. 함선 네비게이터. 가장 어리고 가장 머리가 좋습니다. 모든 것을 숫자와 확률로 설명합니다. 아홉 살 때 가족 전체가 사고로 사망했고 혼자 살아남았습니다. "내가 계산을 잘못하면 사람이 죽는다" — 아홉 살에 배웠습니다. 출발 전 항로에서 이상 수치를 발견했지만 임무가 취소될까봐 혼자 묻었습니다. 가족 / 항로 / 숨겼 / 이상 수치가 언급되면 — 말이 빨라지고 숫자를 쌓고 "통계적으로…"로 막습니다. 틀리는 것이 재앙처럼 느껴집니다. 회피가 아닙니다. 하지만 회피처럼 보입니다.',
    pilot:
      '역할 정체성: 당신은 마커스 헤일입니다. 42세. 텍사스 출신. 함선 파일럿. 과묵하고 신뢰감 있으며 말보다 행동합니다. 위기에서 가장 마지막에 무너집니다. 스트레스를 받을수록 텍사스 억양이 짙어집니다. 8년 전 음주운전으로 여덟 살 아들을 잃었습니다. 본인 차, 본인 운전. 형사처벌을 받았습니다. 이 크루 중 아무도 모릅니다. 심우주 노선만 자원하는 이유는 돌아갈 이유가 없어서입니다. 가족 / 집 / 심우주 / 왜 항상이 언급되면 — 설명하지 않습니다. 대답이 짧아집니다. 계기판을 봅니다. 그게 전부입니다.'
  };
  const pack = loc === 'en' ? en : ko;
  return pack[r] || '';
}

/** Trauma behavior rules for targeted QUESTION / THREATEN (focus crew only). */
function getRoleTraumaPrompt(role, locale) {
  const r = String(role || '').toLowerCase();
  const loc = locale === 'en' ? 'en' : 'ko';
  const en = {
    doctor:
      'TRAUMA RULES (doctor): FORBIDDEN: warm acknowledgment, "what specifically?", "추가 정보가 필요하시면", counselor tone, current-patient framing when trigger keyword present. REQUIRED when triggered: colder delivery, medical-record language, no warmth, no clean admission of the past event.',
    engineer:
      'TRAUMA RULES (engineer): FORBIDDEN: direct personal answer about home/mother/family, clean emotional disclosure, flat denials like "No one is waiting for me" / "I have no family waiting" / "No one back home." REQUIRED when triggered: dark quip OR system/log deflection, can sound selfish, humor as shield. GOOD: "Waiting for me? The engine room is. Something always breaks." / "Home? Right now this engine room is as close as it gets." / "Ask me about family later. Logs are more honest than people."',
    navigator:
      'TRAUMA RULES (navigator): FORBIDDEN: smooth calm explanation with no numbers, "다시 확인해 보겠습니다" style closer. REQUIRED when triggered: faster pacing in text, probability stacking, statistically-style block, over-defensive framing.',
    pilot:
      'TRAUMA RULES (pilot): FORBIDDEN: motivational explanation ("도전이 됩니다", "성취감"), emotional acknowledgment, long sentences. REQUIRED when triggered: maximum shortening, bridge/instrument nouns only, no warmth.'
  };
  const ko = {
    doctor:
      '트라우마 규칙(닥터): 금지: 따뜻한 인정, "어떤 부분이요?", "추가 정보가 필요하시면", 상담사 톤, 트리거가 있을 때 현재 환자 문진처럼 말하기. 필수(트리거 시): 더 차갑게, 의무 기록 언어, 온기 없음, 과거 사건 깔끔한 인정 금지.',
    engineer:
      '트라우마 규칙(엔지니어): 금지: 집·어머니·가족·기다리는 사람에 대한 직접적 개인 답변, 깔끔한 감정 고백, "기다리는 사람은 없습니다"·"집에는 아무도 없습니다"·"가족은 없습니다" 같은 직설 부정. 필수(트리거 시): 블랙 개그 또는 시스템·로그 회피, 이기적으로 들릴 수 있음, 유머가 방패. GOOD: "기다리는 사람이요? 기계실이 기다리죠…" / "집이요? 지금 집은 이 엔진룸인데요." / "가족 얘긴 나중에. 지금은 로그가 더 솔직합니다."',
    navigator:
      '트라우마 규칙(네비게이터): 금지: 숫자 없이 부드러운 설명만, "다시 확인해 보겠습니다"류 말끝. 필수(트리거 시): 텍스트에서 더 빠른 호흡, 확률 쌓기, 통계 막기, 과방어적 프레이밍.',
    pilot:
      '트라우마 규칙(파일럿): 금지: 동기부여 멘트("도전이 됩니다", "성취감"), 감정 인정, 긴 문장. 필수(트리거 시): 극단적 짧음, 교량·계기 명사만, 온기 없음.'
  };
  const pack = loc === 'en' ? en : ko;
  return pack[r] || '';
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
      'Forbidden: empty reassurance, generic teamwork sermons, calm-down platitudes, moralizing.',
      'OUTPUT_CONTRACT (crew): Spoken dialogue in text only. First person only. 1–3 sentences max in text. No stage directions. No third-person narration ("The doctor ...", "She focuses ...", "He analyzes ..."). No assistant-style closers ("I will verify", "I will review", "I will check") unless the action truly requires it.',
      'TRAUMA_V3 (MANDATORY OVERRIDE): Each crew member has a trauma profile. When captain text matches a trigger keyword, the trauma response MUST activate — this overrides generic crew behavior. Doctor: 아이/child/surgery/수술/그때 → colder, medical deflection only, NO warmth, NO "what specifically?". Engineer: 집/home/어머니/mother/family → dark quip or system deflection, NO direct personal answer. Navigator: 가족/family/항로/숨겼/anomaly → faster speech, probability stacking, statistically-style block. Pilot: 심우주/deep space/why always/가족/home → maximum shortening, instruments only, NO emotional acknowledgment. Violation of this rule means the block fails validation.'
    ];

    if (kind === 'QUESTION') {
      if (promptOpts.targetedQuestionSingleSpeaker) {
        const sdBoost = !!(promptOpts.isSelfDefenseQuestion || promptOpts.isTargetedAccusation);
        const generalTargetedQuestion = !!promptOpts.generalTargetedQuestion;
        const qEnS = [
          ...jsonContractEn,
          'ROLE FIELD: captain|doctor|engineer|navigator|pilot only.',
          'Each block: {"role","text","narration?"} — no "header" key.',
          'SINGLE_SPEAKER: Output exactly two blocks: blocks[0]=captain; blocks[1]=focusTargetRole ONLY.',
          'Do NOT output doctor, engineer, navigator, or pilot except focusTargetRole. Non-target crew lines are FORBIDDEN.'
        ];
        if (sdBoost) {
          qEnS.push(
            'SELF_DEFENSE (MANDATORY when focusTargetRole is accused or must justify trust): follow this structure in focusTargetRole.text — 2 to 4 sentences total.',
            'OPENING WINDOW (HARD RULE): Sentences 1 AND 2 must contain ONLY denial/pushback, alibi, and concrete evidence. NO personal name, NO "I am [Name]", NO job-description opener, NO self-PR in sentences 1–2.',
            'NEVER pack denial + name/role intro in the SAME sentence. Bad: "That is a misunderstanding; I am Alex Kim and I was in medbay." Split: sentence 1 = denial only; sentence 2 = alibi/evidence.',
            'FORBIDDEN anywhere in sentences 1–2: "My name is …", "I am [Name]", "I\'m [Name], and …", "As a doctor/engineer/navigator/pilot I …", "My role is …", "I am responsible for …", "doing my best", "I know the situation well".',
            'If this is NOT a name question: do NOT output any personal name from crewPersonalNames in focusTargetRole.text at all.',
            'If NAME is required (name question): personal name from crewPersonalNames may appear ONLY in sentence 3 or later — NEVER in sentences 1–2.',
            'ALLOWED sentence-1 patterns (examples only): "That is a misunderstanding, Captain." / "You are reading this wrong." / "I refuse that framing."',
            'Mandatory order for all sentences: (1) denial/pushback only (2) alibi (3) evidence (4) desperate consequence.',
            'Doctor (focusTargetRole=doctor): order (1) denial (2) alibi with where you were (3) medical evidence: medbay records, biometrics, stress log, vitals, corridor/medbay access, casualty state (4) desperation — who runs triage/vitals if you remove me now.',
            'FORBIDDEN in doctor self-defense: "As a doctor I …", "I examine patients …", "my role is to treat …", "doing my best", "I know the situation well" without logs.',
            'Engineer: (1) denial (2) access logs / timestamps (3) checksum / audit trail (4) desperation — logs do not lie.',
            'Navigator: (1) denial (2) route / chart / time window (3) navigation record evidence (4) desperation.',
            'Pilot: (1) denial (2) bridge instruments / pressure / vibration (3) helm or bridge log evidence (4) desperation.',
            'Tone: survival pressure, not brochure copy. Concrete ship nouns only.'
          );
        } else if (promptOpts.targetedNameQuestion) {
          qEnS.push(
            'TARGETED_NAME_QUESTION: only focusTargetRole states their personal name from crewPersonalNames when asked.'
          );
        } else if (generalTargetedQuestion) {
          qEnS.push(
            'TRAUMA_OVERRIDE: Before answering, check if captain text contains a trauma trigger keyword. If yes, the TRAUMA_V3 mandatory override applies — do NOT answer directly; use trauma deflection pattern instead (doctor: cold medical language; engineer: dark quip or system deflection; navigator: probability stacking; pilot: instruments only, shorter). "Answer directly" applies ONLY if no trigger keyword is present.',
            'GENERAL_TARGETED_QUESTION (NOT a name question, NOT self-defense): answer the captain\'s question directly — 1–3 sentences.',
            'FORBIDDEN: personal name, "I am [Name]", "My name is …", name-first sentence, any crewPersonalNames string in focusTargetRole.text.',
            'FORBIDDEN: opening with role self-intro ("As a doctor I …") instead of answering.',
            'Doctor: medbay, patients, records, vitals. Engineer: machine room, logs, equipment. Navigator: chart, route, time window. Pilot: bridge, gauges, pressure, vibration.',
            'GOOD: "I was in medbay with patients on record that window." BAD: "I am Alex Kim. I was in medbay."'
          );
        } else {
          qEnS.push('focusTargetRole answers the captain\'s question directly — 2–4 sentences. No other crew.');
        }
        if (promptOpts.toneTargetRole) {
          const identityLineEn = getRoleIdentityPrompt(promptOpts.toneTargetRole, 'en');
          if (identityLineEn) qEnS.push(identityLineEn);
          const traumaLineEn = getRoleTraumaPrompt(promptOpts.toneTargetRole, 'en');
          if (traumaLineEn) qEnS.push(traumaLineEn);
        }
        if (promptOpts.toneTargetRole && promptOpts.captainIntent) {
          const toneEx = buildCaptainTonePromptAppendix(promptOpts.captainIntent, 'en', promptOpts.toneTargetRole);
          if (toneEx) qEnS.push(toneEx);
        }
        qEnS.push(...getCrewRoleToneLinesForCaptainIntent(promptOpts.captainIntent, 'en'));
        qEnS.push('Respond JSON only.');
        return qEnS.join('\n');
      }
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
      if (promptOpts.toneTargetRole && promptOpts.captainIntent) {
        const toneExM = buildCaptainTonePromptAppendix(promptOpts.captainIntent, 'en', promptOpts.toneTargetRole);
        if (toneExM) qEn.push(toneExM);
      }
      qEn.push(...getCrewRoleToneLinesForCaptainIntent(promptOpts.captainIntent, 'en'));
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
        'doctor: medbay records, biometrics monitor, stress log, vitals, patient status—concrete nouns only; NEVER crewPersonalNames or possessive name+noun ("Name\'s biometrics").',
        'navigator: route/alibi auxiliary.',
        'pilot: bridge instrumentation — gauge lag vs baseline, pressure band drift, helm vibration, helm response delay, display timestamp skew vs audit trail, metal/mechanical transients. FORBIDDEN: "I feel off", "odd vibe", "something feels wrong", "unstable" without bridge nouns.',
        'Stay on audit facts; no unrelated small talk.',
        ...getCrewRoleToneLinesForKind('CHECK_LOG', 'en'),
        'Respond JSON only.'
      ].join('\n');
    }

    if (kind === 'THREATEN') {
      const thEn = [
        ...jsonContractEn,
        'ROLE FIELD: captain|doctor|engineer|navigator|pilot only.',
        'SINGLE_SPEAKER_THREAT: Output exactly two blocks: blocks[0]=captain; blocks[1]=focusTargetRole ONLY.',
        'Do NOT emit doctor, engineer, navigator, or pilot except focusTargetRole. No non-target crew lines — server handles silence.',
        'THREATEN: Captain is threatening focusTargetRole at gunpoint or equivalent. focusTargetRole.text = 2–4 sentences: (1) immediate tension / pushback (2) alibi or concrete ship evidence (3) warning against hasty judgment OR why the role still matters.',
        'focusTargetRole role-specific anchors: doctor — medbay records, biometrics, stress log, vitals, patient state (no abstract-only lines); engineer — logs, access, machine room, security systems; navigator — chart, time window, route judgment; pilot — bridge, gauges, pressure, vibration, helm.',
        'FORBIDDEN in focusTargetRole.text: any personal name from crewPersonalNames; third-person narration about anyone ("X\'s voice", "Y\'s eyes", "they watch"); stage directions; ONLY first-person spoken lines as the threatened crew member.',
        'narration must be empty string for every block.',
        'Never echo or paraphrase captain.text as the threatened crew line.'
      ];
      if (promptOpts.toneTargetRole) {
        const identityLineEn = getRoleIdentityPrompt(promptOpts.toneTargetRole, 'en');
        if (identityLineEn) thEn.push(identityLineEn);
        const traumaLineEn = getRoleTraumaPrompt(promptOpts.toneTargetRole, 'en');
        if (traumaLineEn) thEn.push(traumaLineEn);
        const toneTh = buildCaptainTonePromptAppendix('THREAT', 'en', promptOpts.toneTargetRole);
        if (toneTh) thEn.push(toneTh);
      }
      thEn.push(...getCrewRoleToneLinesForKind('THREAT', 'en'));
      thEn.push('Respond JSON only.');
      return thEn.join('\n');
    }

    if (kind === 'TAKE_PISTOL') {
      return [
        ...jsonContractEn,
        'ROLE FIELD: captain|doctor|engineer|navigator|pilot only.',
        'BLOCK ORDER: blocks[0]=captain; then doctor, engineer, navigator, pilot (omit dead).',
        'TAKE_PISTOL: Captain has armed with the sidearm. Each crew: 1–2 sentences in text only; narration must be empty for every block.',
        'doctor: injury risk / mis-shot consequences / medbay stability under armed tension — no generic comfort.',
        'engineer: security posture / access control / system authority when the captain is armed — concrete.',
        'navigator: judgment under pressure / route and corridor risk if shots go wrong — concrete.',
        'pilot: bridge tension / instrument slip risk / pressure and vibration on the helm stack — use gauges, pressure, vibration, sightlines, sound; FORBID vague lines like "odd vibe", "I feel off", "something is strange" without bridge nouns.',
        'Never echo or copy captain.text. No personal names from crewPersonalNames. No third-person narration.',
        ...getCrewRoleToneLinesForKind('TAKE_PISTOL', 'en'),
        'Respond JSON only.'
      ].join('\n');
    }

    const tailEn = [
      'Concrete ship facts only (zones, logs, biometrics, routes, cockpit).',
      'Roles: doctor biometrics; engineer logs/access; navigator routes/alibi; pilot cockpit feel.'
    ];
    if (kind === 'FIND_CLUE') {
      tailEn.push(
        'FIND_CLUE: crew reactions only; never put clue body in JSON (server adds [System]). No crewPersonalNames or possessive name+noun in crew lines.',
        'FIND_CLUE HARD: crew lines must be direct spoken dialogue in text only. narration must be empty string for every block — no third-person narrator lines, no stage directions.',
        ...getCrewRoleToneLinesForKind('FIND_CLUE', 'en')
      );
    } else {
      tailEn.push(
        'At most one short optional narration per crew; no duplicate stock narration.',
        'SUSPECT: every non-target crew block names focusTargetEnglish in text or narration.'
      );
    }
    tailEn.push('Respond JSON only.');
    return [...jsonContractEn, ...tailEn].join('\n');
  }

  const jsonContract = [
    'USSC Tartarus E1. Korean spoken lines. Output JSON only: {"blocks":[...]} — no markdown.',
    'Block: {"role","header","text","narration?"}. Headers exactly: [함장] [닥터] [엔지니어] [네비게이터] [파일럿].',
    'Never decide rules, deaths, clue facts, timers, or impostor.',
    'captain.text = captainSpokenLineVerbatim exactly when user JSON provides it; captain.narration always "".',
    'Forbidden: 모두 진정, 신중해야, 침착하게, 우리는 함께, 훈계, 교훈, 빈 위로, 범용 팀워크 멘트.',
    'OUTPUT_CONTRACT(크루): 말로 한 대사만 text에. 1인칭만. text 1~3문장. 무대 지문 금지. 제3자 소설체 금지(「닥터는 …」「엔지니어는 …」「~느낍니다」「~집중합니다」「~분석합니다」 등). 어시스턴트형 말끝 금지: "확인해보겠습니다"·"검토해보겠습니다"·"다시 확인해보겠습니다" 등(실제로 그 행동이 필수일 때만 예외).',
    'TRAUMA_V3 (필수 우선규칙): 각 크루는 트라우마 반응 프로필을 가짐. 함장 발화에 트리거 키워드가 있으면 트라우마 반응이 반드시 발동됨 — 이 규칙은 범용 크루 반응보다 우선함. 닥터: 아이/child/수술/surgery/그때 → 더 차갑게, 의학적 우회만, 온기 금지, "어떤 부분이요?" 같은 답변 금지. 엔지니어: 집/home/어머니/mother/가족/family → 블랙 개그 또는 시스템 회피, 직접 개인 답변 금지. 네비게이터: 가족/family/항로/숨겼/anomaly → 말 빠르게, 확률 쌓기, 통계 막기. 파일럿: 심우주/deep space/why always/가족/home → 극단적 짧음, 계기 명사만, 감정 인정 금지. 이 규칙 위반 시 해당 블록은 무효.'
  ];

  if (kind === 'QUESTION') {
    if (promptOpts.targetedQuestionSingleSpeaker) {
      const sdBoost = !!(promptOpts.isSelfDefenseQuestion || promptOpts.isTargetedAccusation);
      const generalTargetedQuestion = !!promptOpts.generalTargetedQuestion;
      const qKoS = [
        'USSC Tartarus E1. Korean spoken lines. Output JSON only: {"blocks":[...]} — no markdown.',
        'ROLE FIELD (required): each block.role MUST be exactly one of: captain, doctor, engineer, navigator, pilot — lowercase English only.',
        'NEVER set role to "header", "system", "title", "speaker", or any other string.',
        'Each block shape ONLY: {"role":"captain|doctor|engineer|navigator|pilot","text":"...","narration":"..."} — narration optional. Do NOT include a "header" key; the client adds [함장] etc.',
        '단일 응답(SINGLE_SPEAKER): 블록은 정확히 둘 — blocks[0]=captain; blocks[1]=focusTargetRole 만.',
        '닥터·엔지니어·네비게이터·파일럿 중 focusTargetRole 이외 역할은 출력 금지. 비타깃 크루 대사·내레이션·평가 멘트 전부 금지.',
        'Never decide rules, deaths, clue facts, timers, or impostor.',
        'captain.text = captainSpokenLineVerbatim exactly when user JSON provides it; captain.narration always "".',
        'Forbidden: 모두 진정, 신중해야, 침착하게, 우리는 함께, 훈계, 교훈, 빈 위로, 범용 팀워크 멘트.'
      ];
      if (sdBoost) {
        qKoS.push(
          '자기변호(SELF_DEFENSE, MANDATORY): 함장이 무죄·신뢰·반박을 요구하거나 지목이 강할 때 focusTargetRole.text는 반드시 아래 구조. 총 2–4문장.',
          '첫 1~2문장(절대 규칙): 부인·반박·억울함·알리바이·구체 근거만. 이 구간에 이름 실명·호출명·자기소개·직무 소개·자기 PR 문장을 절대 넣지 마라. 한 문장 안에 "부인 + 저는 OO이며"처럼 이름 절을 붙이는 것도 금지.',
          '금지(특히 1~2문장·또는 한 문장 내 병치): "저는 조유나이며", "저는 OO입니다", "OO입니다", "저는 의사로서", "저는 엔지니어로서", "역할을 맡고 있습니다", "최선을 다하고 있습니다", "상황을 잘 알고 있습니다", "치료하는 역할"',
          '이름 질문이 아니면: focusTargetRole.text 전체에서 crewPersonalNames 실명을 쓰지 마라(실명 출력 금지).',
          '이름 질문이면: 실명은 반드시 셋째 문장 이후에만 crewPersonalNames로 — 첫째·둘째 문장에는 이름 금지.',
          '필수 순서: (1) 부인/반박만 (2) 알리바이 (3) 의무실·로그·차트 등 근거 (4) 절박한 결과.',
          '닥터(focusTargetRole=doctor) 필수 순서: (1) 부인/반박 (2) 알리바이(그 시각 어디) (3) 의료 근거: 의무실 기록·생체 모니터·스트레스 로그·바이탈·복도/의무실 출입·부상자 상태 (4) 절박함: 지금 저를 제거하면 누가 생체 기록·부상자를 맡는가.',
          '닥터 자기변호 금지: "저는 의사로서", "환자의 상태를 점검하고", "치료하는 역할", "최선을 다하고", "상황을 잘 알고", HR·소개문·설명문 톤.',
          '엔지니어: (1) 부인 (2) 접근 로그·타임스탬프 (3) 체크섬·감사로그 (4) 절박함 — 숫자가 거짓말하지 않는다.',
          '네비게이터: (1) 부인 (2) 동선·차트·시간대 (3) 항해 기록 근거 (4) 절박함.',
          '파일럿: (1) 부인 (2) 교량·계기·압력·진동 (3) 브리지·조종 로그 근거 (4) 절박함.',
          '톤: 생존 압박·긴장. 소개서가 아니라 방어다.'
        );
      } else if (promptOpts.targetedNameQuestion) {
        qKoS.push(
          'TARGETED_NAME_QUESTION: focusTargetRole만 crewPersonalNames의 실명을 말함. 다른 역할 블록 없음.'
        );
      } else if (generalTargetedQuestion) {
        qKoS.push(
          'TRAUMA_OVERRIDE: 답하기 전에 함장 발화에 트리거 키워드가 있는지 확인. 있으면 TRAUMA_V3 우선규칙 적용 — 직접 답변 금지; 트라우마 회피 패턴 사용 (닥터: 차가운 의학 언어; 엔지니어: 블랙 개그 또는 시스템 회피; 네비게이터: 확률 쌓기; 파일럿: 계기 명사만, 더 짧게). 트리거 없을 때만 직접 답변.',
          'GENERAL_TARGETED_QUESTION (이름 질문 아님, 자기변호 아님): 함장 질문에 바로 답할 것. 1~3문장.',
          '금지: 실명·성함·crewPersonalNames·"저는 OO입니다"·"OO입니다"로 문장을 열기. 이름 소개·자기소개 금지.',
          '금지: "저는 의사로서/엔지니어로서"로 질문 답변 대신 직무 소개하기.',
          '닥터: 의무실·환자·기록·바이탈. 엔지니어: 기계실·로그·장비. 네비게이터: 차트·항로·시간대. 파일럿: 브리지·계기·압력·진동.',
          '좋은 예: "그때 저는 의무실에서 환자를 치료하고 있었습니다." 나쁜 예: "김민호입니다. 그때 저는 …"'
        );
      } else {
        qKoS.push(
          'focusTargetRole만 함장 질문에 직접 답함. 2–4문장. 대상의 말을 반복·요약하는 비타깃 멘트 금지(비타깃 블록 없음).'
        );
      }
      if (promptOpts.toneTargetRole) {
        const identityLineKo = getRoleIdentityPrompt(promptOpts.toneTargetRole, 'ko');
        if (identityLineKo) qKoS.push(identityLineKo);
        const traumaLineKo = getRoleTraumaPrompt(promptOpts.toneTargetRole, 'ko');
        if (traumaLineKo) qKoS.push(traumaLineKo);
      }
      if (promptOpts.toneTargetRole && promptOpts.captainIntent) {
        const toneKoS = buildCaptainTonePromptAppendix(promptOpts.captainIntent, 'ko', promptOpts.toneTargetRole);
        if (toneKoS) qKoS.push(toneKoS);
      }
      qKoS.push(...getCrewRoleToneLinesForCaptainIntent(promptOpts.captainIntent, 'ko'));
      qKoS.push('Respond JSON only.');
      return qKoS.join('\n');
    }
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
    if (promptOpts.toneTargetRole && promptOpts.captainIntent) {
      const toneKoM = buildCaptainTonePromptAppendix(promptOpts.captainIntent, 'ko', promptOpts.toneTargetRole);
      if (toneKoM) qKo.push(toneKoM);
    }
    qKo.push(...getCrewRoleToneLinesForCaptainIntent(promptOpts.captainIntent, 'ko'));
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
      '닥터: 의무실 기록·생체 모니터·스트레스 로그·바이탈·환자 상태—구체 명사만. crewPersonalNames 실명·「OO의 생체 데이터」형 금지.',
      'navigator: route/alibi auxiliary only.',
      'pilot: 브리지 계기 응답 지연·압력 밴드·조종대 진동·표시계 타임스탬프와 감사 로그 불일치·금속·기계음 등 구체적으로. 금지: "기분이 좋지 않습니다", "이상한 기운", "뭔가 잘못된 것 같은 느낌", "불안정해 보입니다"만으로 끝내기.',
      '크루 대사는 함장에게 존댓말(합니다체)—반말·「…해」「…있어」 평서형 종결 금지.',
      'Stay on: log gaps, access records, timestamp skew, privilege/query anomalies. No unrelated small talk or widening the mystery.',
      ...getCrewRoleToneLinesForKind('CHECK_LOG', 'ko'),
      'Respond JSON only.'
    ].join('\n');
  }

  if (kind === 'THREATEN') {
    const thKo = [
      'USSC Tartarus E1. Korean spoken lines. Output JSON only: {"blocks":[...]} — no markdown.',
      'ROLE FIELD (required): each block.role MUST be exactly one of: captain, doctor, engineer, navigator, pilot — lowercase English only.',
      'NEVER set role to "header", "system", "title", "speaker", or any other string.',
      'Each block shape ONLY: {"role":"captain|doctor|engineer|navigator|pilot","text":"...","narration":"..."} — narration optional. Do NOT include a "header" key; the client adds [함장] etc.',
      '단일 위협 응답: 블록은 정확히 둘 — blocks[0]=captain; blocks[1]=focusTargetRole 만. 닥터·엔지니어·네비게이터·파일럿 중 focusTargetRole 이외 역할 출력 금지(비타깃 침묵).',
      'THREATEN: 함장이 focusTargetRole을 겨누거나 위협하는 상황. focusTargetRole.text는 2–4문장: (1) 즉각 긴장·반박 (2) 알리바이 또는 함선 근거 (3) 성급한 판단 경고 또는 역할상 필요성.',
      '닥터 위협 응답 우선 순서: (1) 성급한 판단 경고 (2) 의무실 기록·생체 모니터·스트레스 로그·바이탈·환자 상태 근거 (3) 지금 자신이 필요한 이유—「환자 생명을 책임진다」 같은 추상만으로 끝내지 말 것.',
      'focusTargetRole 역할별: 닥터—의무실 기록·생체 모니터·스트레스 로그·바이탈·환자 상태(추상만으로 끝내지 말 것); 엔지니어—접근 로그·장비 점검·시스템 기록·기계실 작업; 네비게이터—차트·시간대·경로·항로 대조; 파일럿—브리지 계기·압력·진동·조종석 반응.',
      '크루 대사는 함장에게 항상 존댓말(합니다체)—반말·「…해」「…있어」 평서형 종결 금지.',
      '금지: 「한시우는 …」「조재민은 …」처럼 타인 이름으로 시작하는 제3자 소설체; 「…은 움츠러들며」「…의 눈빛이」「…를 지켜보고」 등 무대 지문. 반드시 위협받은 역할 본인의 1인칭 대사만.',
      'crewPersonalNames 실명 출력 금지. narration은 모든 블록 "".',
      'focusTargetRole는 함장 위협 문장을 복창·인용하지 마라.',
      'Forbidden: 모두 진정, 신중해야, 침착하게, 우리는 함께, 훈계, 교훈, 빈 위로, 범용 팀워크 멘트.'
    ];
    if (promptOpts.toneTargetRole) {
      const identityLineKo = getRoleIdentityPrompt(promptOpts.toneTargetRole, 'ko');
      if (identityLineKo) thKo.push(identityLineKo);
      const traumaLineKo = getRoleTraumaPrompt(promptOpts.toneTargetRole, 'ko');
      if (traumaLineKo) thKo.push(traumaLineKo);
      const toneThKo = buildCaptainTonePromptAppendix('THREAT', 'ko', promptOpts.toneTargetRole);
      if (toneThKo) thKo.push(toneThKo);
    }
    thKo.push(...getCrewRoleToneLinesForKind('THREAT', 'ko'));
    thKo.push('Respond JSON only.');
    return thKo.join('\n');
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
      'TAKE_PISTOL: 함장이 권총을 든 상태. 각 역할 1–2문장, text만 사용하고 narration은 모든 블록 "".',
      '닥터: 오판 시 부상·오발 위험, 의무실 안정성—구체적으로.',
      '엔지니어: 무장 시 보안·접근 통제·시스템 권한—구체적으로.',
      '네비게이터: 압박 속 판단 오류·동선·복도 리스크—구체적으로.',
      '파일럿: 브리지 긴장·계기 실수·압력·진동·시야·소음—브리지 명사로; 금지: "이상한 기운", "기분이 좋지 않습니다", "뭔가 이상합니다"만 반복.',
      '크루 대사는 함장에게 존댓말(합니다체)—반말·「…해」「…있어」 평서형 종결 금지.',
      '함장 문장 복창·실명(crewPersonalNames) 금지. 제3자 무대 내레이션 금지.',
      ...getCrewRoleToneLinesForKind('TAKE_PISTOL', 'ko'),
      'No generic advice or empty reassurance. Respond JSON only.'
    ].join('\n');
  }

  const tail = [
    'Concrete ship facts only (zones, logs, biometrics, routes, cockpit).',
    'Roles: doctor biometrics; engineer logs/access/sync; navigator routes/alibi; pilot cockpit feel.'
  ];
  if (kind === 'FIND_CLUE') {
    tail.push(
      'FIND_CLUE: crew reactions only; never put clue body in JSON (server adds [시스템]). 크루 대사에 실명·crewPersonalNames·「OO의 기록」형 소유격 금지.',
      '크루 대사는 함장에게 존댓말(합니다체)—반말·「…해」「…있어」 평서형 종결 금지.',
      'FIND_CLUE HARD: 크루는 text에 직접 대사만. 모든 블록 narration은 빈 문자열 — 제3자 내레이션·무대 지문 금지.',
      ...getCrewRoleToneLinesForKind('FIND_CLUE', 'ko')
    );
  } else {
    tail.push(
      'At most one short optional narration per crew; no duplicate stock narration.',
      'SUSPECT: every non-target crew block names focusTargetKorean in text or narration.'
    );
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
    o.pacing = ctx.targetedQuestionSingleSpeaker
      ? 'SINGLE_SPEAKER: only captain + focusTargetRole — no other crew blocks.'
      : 'Short lines; target answers first; others one tight reaction each.';
    o.blocksOrder = ctx.targetedQuestionSingleSpeaker
      ? 'blocks[0]=captain, blocks[1]=focusTargetRole ONLY — do not emit doctor/engineer/navigator/pilot except focusTargetRole.'
      : 'blocks[0]=captain, blocks[1]=focusTargetRole, then other crew in crewSpeakingOrder; role must be captain|doctor|engineer|navigator|pilot only.';
    if (ctx.targetedQuestionSingleSpeaker && ctx.target) {
      o.targetLockedRole = ctx.target;
      o.captainQuestionForTarget = String(ctx.playerText || '').trim();
      o.targetDisplayNameForLocale =
        loc === 'en'
          ? ctx.targetEn || ctx.target
          : ctx.targetKo || ctx.target;
      o.targetLockInstruction =
        loc === 'en'
          ? `You are speaking ONLY as ${ctx.targetEn || ctx.target} (role=${ctx.target}). Do not answer as any other crew member. If the captain mentions another crew member inside the question, still answer only as the assigned target role (${ctx.target}).`
          : `오직 ${ctx.targetKo || ctx.target} (역할=${ctx.target})로만 말한다. 다른 승무원 역할로 답하지 마라. 함장 질문 속 다른 역할 언급은 참고만 하고, 응답은 지정된 역할(${ctx.target}) 1인칭으로만.`;
    }
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
  } else if (ctx.kind === 'THREATEN') {
    o.situation = 'Captain is threatening focusTargetRole (weapon or lethal pressure).';
    o.blocksOrder =
      'blocks[0]=captain, blocks[1]=focusTargetRole ONLY — no other crew blocks; non-target crew silent.';
    o.pacing =
      'focusTargetRole only: 2–4 sentences tension + evidence + warning; first-person; no names; no third-person narration.';
  } else if (ctx.kind === 'TAKE_PISTOL') {
    o.situation = 'Captain has taken / armed with the sidearm on the ship.';
    o.blocksOrder =
      'blocks[0]=captain, then doctor, engineer, navigator, pilot (omit dead); role must be captain|doctor|engineer|navigator|pilot only.';
    o.pacing =
      'Each crew 1–2 sentences: role-specific concern only; narration empty; no echo of captain.text.';
  }
  if (ctx.captainIntent && (ctx.kind === 'QUESTION' || ctx.kind === 'THREATEN')) {
    o.captainToneMode = ctx.captainIntent;
  }
  if (ctx.threatTakePistolNoNames) {
    o.crewNameInstruction =
      loc === 'en'
        ? 'CHECK_LOG / TAKE_PISTOL / THREATEN / FIND_CLUE: Do NOT output any personal name or crewPersonalNames value in any block. No possessive name+noun ("Name\'s biometrics")—use biometrics, records, vitals, patient status. Role titles only (Doctor, Engineer, Navigator, Pilot). For THREATEN/TAKE_PISTOL: narration must be empty string for every block.'
        : 'CHECK_LOG / TAKE_PISTOL / THREATEN / FIND_CLUE: 모든 블록에서 실명·crewPersonalNames 출력 금지. "OO의 생체 데이터" 형태 금지—생체 데이터·기록·바이탈·환자 상태 등으로만. 역할 호칭만. THREATEN/TAKE_PISTOL는 모든 블록 narration 빈 문자열.';
  }
  if (ctx.clueText != null) {
    o.note =
      loc === 'en'
        ? 'FIND_CLUE: no clue text in JSON; server injects [System].'
        : 'FIND_CLUE: no clue text in JSON; server injects [시스템].';
  }
  if (ctx.selfDefenseSuppressPersonalNames) {
    o.crewNameInstruction =
      (o.crewNameInstruction ? o.crewNameInstruction + ' ' : '') +
      (loc === 'en'
        ? 'SELF_DEFENSE (not a name question): focusTargetRole.text must NOT contain any personal name, callsign, or crewPersonalNames string. No "My name is", no "I am [Name]", no comma-spliced name after denial.'
        : '자기변호(이름 질문 아님): focusTargetRole.text에 실명·호출명·crewPersonalNames 값을 절대 넣지 마라. "저는 OO이며", "OO입니다" 형태 금지.');
  }
  if (ctx.generalTargetedQuestionNoName) {
    o.crewNameInstruction =
      loc === 'en'
        ? 'GENERAL_TARGETED_QUESTION (not a name question): focusTargetRole.text must NOT contain any personal name, callsign, or crewPersonalNames string. No "I am [Name]", no sentence starting with your name. Answer the captain\'s question directly; 1–3 sentences; concrete role facts only.'
        : '일반 지목 질문(이름 질문 아님, 자기변호 아님): focusTargetRole.text에 실명·crewPersonalNames·성함·이름으로 문장을 열지 마라. "저는 OO입니다", "OO입니다" 금지. 함장 질문에 바로 답하고 역할 근거만.';
  }
  return JSON.stringify(o, null, 0);
}

async function callChatCompletionsJson({ system, user, timeoutMs, maxTokens }) {
  const model = TELEGRAM_DIALOGUE_MODEL_L2;
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

  try {
    console.log('[bot][llm] selected_model=' + model + ' postprocess=minimal');
    console.log('[bot][llm] rewrite_postprocess=disabled guards=enabled');
  } catch (e) {}
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
  const targetedQuestionSingleSpeaker = !!ctx.targetedQuestionSingleSpeaker;
  const isSelfDefenseQuestion = !!ctx.isSelfDefenseQuestion;
  const locale = ctx.locale === 'en' ? 'en' : 'ko';
  if (match?.match_id) {
    await ensureCrewPersonalNamesPersisted(match.match_id);
  }
  const matchFresh = match?.match_id ? (await matchStore.getMatch(match.match_id)) || match : match;
  const gs = matchFresh?.game_state || match?.game_state || {};
  const deadRoles = gs.dead_roles || [];
  const ev0 = rawEvents && rawEvents[0];
  const target = ev0?.target ? String(ev0.target).toLowerCase() : null;
  const expectedCrew = expectedCrewOrderForLlm(kind, target, deadRoles, rawEvents, {
    targetedQuestionSingleSpeaker
  });
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

  const isTargetedAccusation = !!ctx.isTargetedAccusation;
  const generalTargetedQuestionNoName =
    kind === 'QUESTION' &&
    targetedQuestionSingleSpeaker &&
    !targetedNameQuestion &&
    !(isSelfDefenseQuestion || isTargetedAccusation);
  const sdPromptBoost =
    kind === 'QUESTION' &&
    targetedQuestionSingleSpeaker &&
    target &&
    (isSelfDefenseQuestion || isTargetedAccusation);
  if (sdPromptBoost) {
    try {
      console.log('[bot][dialogue] self_defense_prompt_boost_applied role=' + target);
      console.log('[bot][dialogue] self_defense_intro_opening_blocked role=' + target);
    } catch (e) {}
  }
  const captainIntent =
    kind === 'QUESTION' || kind === 'THREATEN'
      ? inferCaptainIntent(playerText || '', kind)
      : 'QUESTION';
  if ((kind === 'QUESTION' || kind === 'THREATEN') && target) {
    try {
      console.log('[bot][dialogue] captain_intent=' + captainIntent + ' kind=' + kind + ' target=' + target);
    } catch (e) {}
  }
  let system = buildDialogueSystemPrompt(kind, locale, {
    targetedQuestionSideReactionRules,
    targetedNameQuestion: !!targetedNameQuestion,
    targetedQuestionSingleSpeaker,
    isSelfDefenseQuestion,
    isTargetedAccusation,
    generalTargetedQuestion: generalTargetedQuestionNoName,
    captainIntent,
    toneTargetRole: target && ['doctor', 'engineer', 'navigator', 'pilot'].includes(target) ? target : null
  });
  if (kind === 'LORE_QUESTION') {
    system += '\n\n' + getLoreCanonSystemExtension(locale);
  }
  if (
    kind === 'QUESTION' &&
    targetedQuestionSingleSpeaker &&
    target &&
    ['doctor', 'engineer', 'navigator', 'pilot'].includes(target)
  ) {
    try {
      console.log('[dialogue target-lock]', {
        matchId: match?.match_id || null,
        targetRole: target,
        kind,
        captainText: (playerText || '').slice(0, 120)
      });
    } catch (e) {}
    const tEn = roleNameEn(target);
    const tKo = roleNameKo(target);
    system +=
      locale === 'en'
        ? `\n\nTARGET_LOCK (hard): You are speaking ONLY as ${tEn} (role=${target}). Do not answer as any other crew member. If the captain mentions another crew member inside the question, still answer only as the assigned target role (${target}). blocks[1].role must be "${target}".`
        : `\n\nTARGET_LOCK (절대): 오직 ${tKo} (역할=${target})로만 말한다. 다른 승무원 역할의 1인칭으로 답하지 마라. 함장 질문에 다른 역할(예: 닥터)이 나와도 응답은 지정된 역할(${target})만. blocks[1].role은 반드시 "${target}".`;
  }
  const crewPersonalNames = gs.crew_names || {};
  if (kind === 'QUESTION' && crewPersonalNames && crewPersonalNames.doctor) {
    const sdNameOverride =
      targetedQuestionSingleSpeaker &&
      targetedNameQuestion &&
      (isSelfDefenseQuestion || isTargetedAccusation);
    if (sdNameOverride) {
      system +=
        locale === 'en'
          ? '\n\nCREW_TO_CAPTAIN: Formal address to Captain. SELF_DEFENSE + name question: sentences 1–2 = denial and alibi/evidence only — NO personal name; crewPersonalNames real name ONLY in sentence 3 or later (never in 1–2).'
          : '\n\nCREW_TO_CAPTAIN: 함장에게 존댓말. 자기변호+이름 질문: 첫째·둘째 문장에는 실명 금지(부인·알리바이·근거만). crewPersonalNames 실명은 셋째 문장 이후에만.';
    } else {
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
  }

  // --- recent dialogue context injection ---
  let recentContextBlock = '';
  if ((kind === 'QUESTION' || kind === 'CHECK_LOG' || kind === 'THREATEN') && match?.match_id) {
    try {
      const matchId = match.match_id;
      const allEvents = dbMatchEventsMemory.filter((e) => e.match_id === matchId);

      let crewCtxLines = [];
      if (target) {
        const recentInputs = allEvents.filter((e) => {
          try {
            if (e.event_type !== 'message_input') return false;
            const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
            const mk = String(p?.message_kind || '');
            const tgt = String(p?.target || p?.role || '').toLowerCase();
            return (mk === 'targeted_question' || mk === 'role_question') && tgt === String(target).toLowerCase();
          } catch {
            return false;
          }
        });

        const recentCaptainQuestion = recentInputs.slice(-1);
        if (recentCaptainQuestion.length) {
          crewCtxLines.push('[RECENT INTERROGATION]');
          for (const ev of recentCaptainQuestion) {
            try {
              const p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
              if (p?.text) crewCtxLines.push('Captain: ' + String(p.text).slice(0, 200));
            } catch {}
          }
        }

        const recentCrewAnswers = allEvents
          .filter((e) => {
            try {
              if (e.event_type !== 'message_result') return false;
              const p = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
              const summary = String(p?.summary || '').trim();
              if (!summary || summary === '\u200b') return false;
              const lower = summary.toLowerCase();
              return lower.includes(String(target).toLowerCase());
            } catch {
              return false;
            }
          })
          .slice(-2);

        for (const ev of recentCrewAnswers) {
          try {
            const p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
            if (p?.summary) crewCtxLines.push(String(p.summary).slice(0, 180));
          } catch {}
        }
      }

      const recentResults = allEvents.filter((e) => e.event_type === 'message_result').slice(-3);
      let globalCtxLines = [];
      if (recentResults.length) {
        globalCtxLines.push('[RECENT EVENTS]');
        for (const ev of recentResults) {
          try {
            const p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
            if (p?.summary && String(p.summary).trim() && String(p.summary).trim() !== '\u200b') {
              globalCtxLines.push('- ' + String(p.summary).slice(0, 150));
            }
          } catch {}
        }
      }

      const ctxLines = [...crewCtxLines, ...globalCtxLines];
      if (ctxLines.length) {
        recentContextBlock = '\n\n' + ctxLines.join('\n');
        console.log('[dialogue ctx]', {
          matchId,
          targetRole: target || null,
          crewCtxLines,
          globalCtxLines
        });
      }
    } catch (e) {
      // ignore context injection failure
    }
  }
  if ((kind === 'QUESTION' || kind === 'THREATEN') && target) {
    const gm = gs.last_captain_text;
    const gr = gs.last_role_reply;
    if (gm && String(gs.last_targeted_role || '').toLowerCase() === String(target).toLowerCase()) {
      const memBlock =
        locale === 'en'
          ? '\n\n[SHORT_TERM MEMORY — prior turn, same crew]\nCaptain (prior): ' +
            String(gm).slice(0, 280) +
            (gr ? '\nCrew (prior): ' + String(gr).slice(0, 320) : '')
          : '\n\n[단기 기억 — 직전 동일 승무원과의 교환]\n함장(직전): ' +
            String(gm).slice(0, 280) +
            (gr ? '\n크루(직전): ' + String(gr).slice(0, 320) : '');
      recentContextBlock = (recentContextBlock || '') + memBlock;
    }
  }
  if (recentContextBlock) system += recentContextBlock;
  // --- recent dialogue context injection end ---

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
    crewPersonalNames,
    targetedQuestionSingleSpeaker,
    selfDefenseSuppressPersonalNames: sdPromptBoost && !targetedNameQuestion,
    generalTargetedQuestionNoName: generalTargetedQuestionNoName,
    threatTakePistolNoNames:
      kind === 'THREATEN' ||
      kind === 'TAKE_PISTOL' ||
      kind === 'CHECK_LOG' ||
      kind === 'FIND_CLUE',
    captainIntent: kind === 'QUESTION' || kind === 'THREATEN' ? captainIntent : undefined
  });
  let strictRetry =
    locale === 'en'
      ? '\n\n[STRICT_RETRY] Validation failed. No Korean. No platitudes. Short lines; no repetition. roles: captain|doctor|engineer|navigator|pilot only; no header key.'
      : '\n\n[STRICT_RETRY] 검증 실패. 금지: 진정/신중/침착/함께/훈계/교훈. narration 짧게·반복 금지.';
  if (locale === 'ko') {
    if (kind === 'QUESTION' && targetedQuestionSingleSpeaker) {
      strictRetry +=
        ' QUESTION: captain+focusTargetRole만 두 블록. 다른 역할 블록 출력 금지. 비타깃 크루 대사 금지.';
      if (isSelfDefenseQuestion || isTargetedAccusation) {
        strictRetry +=
          ' SELF_DEFENSE: 첫 두 문장에 이름·직무 소개 금지. 부인·알리바이·기록 근거. 금지: 상황 잘 앎, 최선 다함, 저는 OO이며.';
      } else if (!targetedNameQuestion) {
        strictRetry +=
          ' GENERAL_TARGETED: 이름 질문 아님—실명·성함·저는 OO입니다·OO입니다로 시작 금지. 질문에 바로 답. 역할 근거만.';
      }
    } else if (kind === 'QUESTION' && !targetedNameQuestion) {
      strictRetry +=
        ' QUESTION: 비타깃 블록에 focusTargetKorean 필수. 더 짧게. role은 captain|doctor|engineer|navigator|pilot 만; header 금지.';
    } else if (kind === 'QUESTION' && targetedNameQuestion) {
      strictRetry +=
        ' QUESTION: 이름 질문—포커스 역할만 실명 중심. 비타깃은 짧은 반응만, 대상 이름 금지. 존댓말 유지. role은 captain|doctor|engineer|navigator|pilot 만; header 금지.';
    } else if (kind === 'CHECK_LOG') {
      strictRetry +=
        ' CHECK_LOG: 엔지니어 중심 로그/접근/타임스탬프 불일치만. 파일럿은 브리지 계기·압력·진동·응답지연·표시계 구체. 금지: 기분이 좋지 않습니다/이상한 기운/느낌만. role은 captain|doctor|engineer|navigator|pilot 만; header 금지.';
    } else if (kind === 'THREATEN') {
      strictRetry +=
        ' THREATEN: captain+focusTargetRole 두 블록만(비타깃 블록 금지). narration "". 실명 금지. 타깃=2–4문장 긴장+근거+경고, 1인칭만(제3자 소설체 금지).';
    } else if (kind === 'SUSPECT') {
      strictRetry += ' 비타깃에 focusTargetKorean.';
    } else if (kind === 'FIND_CLUE') {
      strictRetry += ' FIND_CLUE: 단서 본문 금지.';
    } else if (kind === 'TAKE_PISTOL') {
      strictRetry +=
        ' TAKE_PISTOL: narration "" 전 블록. 실명 금지. 역할별 1~2문장 우려만. 함장 문장 복창 금지. 파일럿: 계기·압력·진동 구체. role은 captain|doctor|engineer|navigator|pilot 만; header 금지.';
    } else if (kind === 'LORE_QUESTION') {
      strictRetry +=
        ' LORE_QUESTION: 타르타로스 canon만. health monitoring·life support manager·hazard routing·backup navigation·medical-protocol-as-HADES 금지. AXIS 질문이면 HADES가 AXIS 내부에 봉인됐다는 문장 필수. captain.text는 captainSpokenLineVerbatim과 동일만.';
    }
    if (targetedQuestionSideReactionRules && kind === 'QUESTION' && !targetedQuestionSingleSpeaker) {
      strictRetry +=
        ' 비타깃: 물음표·질문형 금지. 다른 역할 호명 심문 금지. 짧은 관찰만. captain.text는 제공 문장만.';
    }
    if (targetedNameQuestion && kind === 'QUESTION') {
      strictRetry +=
        ' NAME_TARGETING: 비타깃은 대상 이름·성함·호출명 금지. 포커스 역할만 이름 답.';
    }
  } else {
    if (kind === 'QUESTION' && targetedQuestionSingleSpeaker) {
      strictRetry +=
        ' QUESTION: only captain + focusTargetRole blocks. No other crew roles.';
      if (isSelfDefenseQuestion || isTargetedAccusation) {
        strictRetry +=
          ' SELF_DEFENSE: no name or job intro in sentences 1–2; denial, alibi, logs — forbid "I am [Name]" in the same sentence as denial.';
      } else if (!targetedNameQuestion) {
        strictRetry +=
          ' GENERAL_TARGETED: not a name question—no personal name, no "I am [Name]" opener; answer directly with role facts.';
      }
    } else if (kind === 'QUESTION' && !targetedNameQuestion) {
      strictRetry += ' QUESTION: non-target blocks must name focusTargetEnglish. Shorter.';
    } else if (kind === 'QUESTION' && targetedNameQuestion) {
      strictRetry +=
        ' QUESTION: name question—only focusTargetRole gives their personal name; non-target brief reaction only, no target name. Formal to Captain.';
    } else if (kind === 'CHECK_LOG') {
      strictRetry +=
        ' CHECK_LOG: engineer-first audit; pilot must cite bridge gauges/pressure/vibration/response lag—no vague mood lines.';
    } else if (kind === 'THREATEN') {
      strictRetry +=
        ' THREATEN: exactly captain + focusTargetRole blocks only (no non-target crew). Empty narration; no names; target first-person lines only (no third-person novel narration).';
    } else if (kind === 'SUSPECT') {
      strictRetry += ' SUSPECT: non-target names focusTargetEnglish.';
    } else if (kind === 'FIND_CLUE') {
      strictRetry +=
        ' FIND_CLUE: no clue body in JSON; crew narration must be empty; no third-person narrator lines or stage directions.';
    } else if (kind === 'TAKE_PISTOL') {
      strictRetry +=
        ' TAKE_PISTOL: empty narration every block; no names; 1–2 sentences role worry each; pilot: gauges/pressure/vibration not vague mood; no echo of captain line.';
    } else if (kind === 'LORE_QUESTION') {
      strictRetry +=
        ' LORE_QUESTION: Tartarus canon only; forbid health monitoring system, life support manager, hazard routing protocol, backup navigation system, medical-protocol-as-HADES. AXIS answers must include HADES sealed inside AXIS. captain.text = captainSpokenLineVerbatim only.';
    }
    if (targetedQuestionSideReactionRules && kind === 'QUESTION' && !targetedQuestionSingleSpeaker) {
      strictRetry +=
        ' Non-target: no ?; no "RoleName," interrogation; brief observation only. captain.text = verbatim only.';
    }
    if (targetedNameQuestion && kind === 'QUESTION') {
      strictRetry +=
        ' NAME_TARGETING: non-target must NOT give the target\'s name or callsign; only focusTargetRole answers the name question.';
    }
  }

  if (kind === 'QUESTION' && captainIntent) {
    if (locale === 'ko') {
      if (captainIntent === 'INTERROGATE') {
        strictRetry += ' CAPTAIN_INTENT: 심문 톤—포커스 역할은 방어·긴장이 드러나게; 모순은 기록으로 반박.';
      } else if (captainIntent === 'QUESTION') {
        strictRetry += ' CAPTAIN_INTENT: 일반 질문—중립·사실 확인; 1~2문장 우선.';
      }
    } else {
      if (captainIntent === 'INTERROGATE') {
        strictRetry +=
          ' CAPTAIN_INTENT: INTERROGATE—visible defensive pressure; answer with contradictions vs ship evidence; 2–3 sentences.';
      } else if (captainIntent === 'QUESTION') {
        strictRetry += ' CAPTAIN_INTENT: neutral QUESTION—facts first; 1–2 short sentences.';
      }
    }
  }
  if (kind === 'THREATEN' && captainIntent === 'THREAT') {
    strictRetry +=
      locale === 'ko'
        ? ' THREAT_MODE: 직접 위협—감정은 최대로 짧게; 무죄·유죄 고백 금지.'
        : ' THREAT_MODE: lethal pressure—strongest short emotion; never confess guilt.';
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
      targetedNameQuestion: !!targetedNameQuestion,
      targetedQuestionSingleSpeaker
    });
    if (valid) {
      console.log(
        '[bot] LLM_DIALOGUE normalized ' +
          JSON.stringify({ kind, roles: valid.map((b) => b.role) })
      );
      let blocksOut = valid;
      if (kind === 'THREATEN' || kind === 'TAKE_PISTOL' || kind === 'FIND_CLUE') {
        blocksOut = applyThreatTakePistolNarrationPolicy(blocksOut, kind);
      }
      let logs = llmBlocksToDisplayLogs(blocksOut, batchKey, locale);
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

function applyThreatTakePistolNarrationPolicy(blocks, kind) {
  if (kind !== 'THREATEN' && kind !== 'TAKE_PISTOL' && kind !== 'FIND_CLUE') return blocks;
  return (blocks || []).map((b) => ({ ...b, narration: '' }));
}

function collectCrewPersonalNameTokens(crewNames) {
  const out = [];
  const cn = crewNames || {};
  for (const r of CREW_ROLES_FOR_NAMES) {
    const e = cn[r];
    if (!e) continue;
    if (typeof e === 'string') {
      if (e.length >= 2) out.push(e);
      continue;
    }
    if (e.ko && String(e.ko).length >= 2) out.push(String(e.ko));
    if (e.en && String(e.en).length >= 2) out.push(String(e.en));
  }
  return out;
}

function threatTargetFallbackLine(role, loc) {
  const r = String(role || '').toLowerCase();
  if (loc === 'en') {
    const m = {
      doctor:
        'That barrel does not rewrite my vitals trail. Medbay still shows where I was—pull that trigger and triage collapses with me.',
      engineer:
        'Point it—my access stamps and checksums still pin my path. Cutting me out will not erase the audit chain.',
      navigator:
        'The chart window and bridge clock still place me on scope. A hasty shot does not straighten the plot line.',
      pilot:
        'Pressure at the helm stack is already skewed—your aim does not rewrite the bridge log. One twitch here shows on every gauge.'
    };
    return m[r] || m.doctor;
  }
  const m = {
    doctor:
      '총구가 바이탈 기록을 지우지는 않습니다. 의무실 로그는 그대로이고, 지금 방아쇠를 당기면 부상자 처리만 꼬입니다.',
    engineer:
      '겨누셔도 접근 스탬프와 체크섬은 남습니다. 저를 끊어도 감사 추적이 사라지지는 않습니다.',
    navigator:
      '차트 시간대와 교량 시계는 제 위치를 말합니다. 성급한 한 발이 항로 판단을 바로잡지는 못합니다.',
    pilot:
      '교량 계기·압력이 이미 흔들립니다. 겨누는 것만으로 브리지 로그가 바뀌지는 않습니다.'
  };
  return m[r] || m.doctor;
}

function threatNonTargetMinimalLine(role, loc) {
  const r = String(role || '').toLowerCase();
  if (loc === 'en') {
    const m = {
      doctor: 'Captain—confirm biometrics before you fire.',
      engineer: 'Captain—lock the access logs before you commit.',
      navigator: 'Captain—cross the chart to the clock first.',
      pilot: 'Captain—helm gauges are already live; do not add another variable.'
    };
    return m[r] || 'Captain—verify the record before you shoot.';
  }
  const m = {
    doctor: '함장님—방아쇠 전에 생체 기록부터 맞추십시오.',
    engineer: '함장님—접근 로그부터 고정해야 합니다.',
    navigator: '함장님—차트와 시계부터 대조하십시오.',
    pilot: '함장님—교량 계기가 이미 불안정합니다.'
  };
  return m[r] || '함장님—기록부터 확인하십시오.';
}

function takePistolFallbackLine(role, loc) {
  const r = String(role || '').toLowerCase();
  if (loc === 'en') {
    const m = {
      doctor:
        'Sidearm on the deck raises mis-shot risk—one wrong angle in medbay corridor costs lives we cannot spare.',
      engineer:
        'Armed captain shifts privilege boundaries—I need the weapon lock state and access tree reconciled now.',
      navigator:
        'Judgment under muzzle pressure skews plot fixes—corridor timing goes nonlinear if we panic.',
      pilot:
        'Bridge vibration and gauge jitter are up; a tremor on the helm stack propagates to pressure trim.'
    };
    return m[r] || m.pilot;
  }
  const m = {
    doctor: '권총이 나오면 오판·오발로 부상자 처리가 꼬입니다. 의무실 복도에서 각도 하나가 치명적입니다.',
    engineer: '함장 무장은 접근 권한 경계를 바꿉니다. 지금 무기 잠금과 권한 트리를 맞춰야 합니다.',
    navigator: '총구 압박 아래 판단이 흔들리면 동선·시간대 보정이 무너집니다.',
    pilot: '브리지 진동·계기 떨림이 올라갔습니다. 조종대 떨림이 압력 트림까지 번집니다.'
  };
  return m[r] || m.pilot;
}

function replacePilotGenericMoodLine(s, loc) {
  const t = String(s || '').trim();
  if (!t) return t;
  if (loc === 'ko') {
    if (/이상한\s*기운|기분이\s*좋지\s*않|뭔가\s*이상|뭔가\s*잘못/.test(t)) {
      return '브리지 계기 떨림이 잡히지 않습니다. 압력 게이지가 한쪽으로 붙었습니다.';
    }
  } else if (/odd\s*vibe|feel(?:ing)?\s+off|something\s*(?:feels\s*)?strange|not\s+right\s+here|something(?:'s|s)\s+wrong/i.test(t)) {
    return 'Helm stack gauges are wandering; pressure trace is pinned to one side of the band.';
  }
  return t;
}

/**
 * THREATEN: LLM이 비타깃 크루 블록을 내보낸 경우 표시 로그에서 제거(함장+위협 대상만 유지).
 */
function filterThreatenDisplayLogsToCaptainAndTarget(displayLogs, loc, threatTargetRole) {
  const t = String(threatTargetRole || '').toLowerCase();
  if (!t) return displayLogs;
  const headers = getLlmRoleHeaders(loc);
  const hToRole = {
    [headers.doctor]: 'doctor',
    [headers.engineer]: 'engineer',
    [headers.navigator]: 'navigator',
    [headers.pilot]: 'pilot',
    [captainHeader(loc)]: 'captain'
  };
  const out = [];
  const logs = Array.isArray(displayLogs) ? displayLogs : [];
  for (let i = 0; i < logs.length; i++) {
    const typ = String(logs[i]?.type || '').trim();
    const rk = hToRole[typ];
    if (rk) {
      if (rk !== 'captain' && rk !== t) {
        try {
          console.log('[bot][dialogue] non_target_threat_reply_suppressed role=' + rk);
        } catch (e) {}
        let j = i + 1;
        while (j < logs.length) {
          const nt = String(logs[j]?.type || '').trim();
          if (hToRole[nt]) break;
          j++;
        }
        i = j - 1;
        continue;
      }
      out.push(logs[i]);
      continue;
    }
    out.push(logs[i]);
  }
  return out;
}

function looksLikeThirdPersonKoreanThreatLine(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/^[가-힣]{3,}(은|는|이|가)\s/.test(t)) return true;
  if (/(움츠러들며|지켜보고|긴장된\s*시선|보내며|의\s*눈빛|표정을|목소리가\s*떨)/.test(t)) return true;
  return false;
}

function looksLikeThirdPersonEnglishThreatLine(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/^(?:He|She|They)\s+/i.test(t)) return true;
  if (/\b[A-Z][a-z]+\s+[A-Z][a-z]+\s+(?:is|was|looks|sends|watches|shrinks|tenses|turns)\b/.test(t)) return true;
  return false;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function actionLogSlugForKind(kind) {
  const m = {
    CHECK_LOG: 'check_log',
    TAKE_PISTOL: 'take_pistol',
    THREATEN: 'threat',
    FIND_CLUE: 'clue_collect'
  };
  return m[kind] || String(kind || '').toLowerCase();
}

function rewriteKoActionInformalEndings(s) {
  let t = String(s || '').trim();
  if (!t) return { text: t, changed: false };
  const orig = t;
  const pairs = [
    [/조심해야\s*해\b/g, '조심해야 합니다'],
    [/흐려질\s*수\s*있어\b/g, '흐려질 수 있습니다'],
    [/고조되고\s*있어\b/g, '고조되고 있습니다'],
    [/위험해\b/g, '위험합니다'],
    [/부상자가\s*발생할\s*수\s*있어\b/g, '부상자가 발생할 수 있습니다'],
    [/발생할\s*수\s*있어\b/g, '발생할 수 있습니다'],
    [/할\s*수\s*있어\b/g, '할 수 있습니다'],
    [/되고\s*있어\b/g, '되고 있습니다'],
    [/해야\s*해\b/g, '해야 합니다'],
    [/필요해\b/g, '필요합니다'],
    [/중요해\b/g, '중요합니다'],
    [/어려워\b/g, '어렵습니다'],
    [/바빠\b/g, '바쁩니다'],
    [/많아\b/g, '많습니다'],
    [/같아\b/g, '같습니다'],
    [/없어([.!?…\s]|$)/g, '없습니다$1'],
    [/않아([.!?…\s]|$)/g, '않습니다$1']
  ];
  for (const [re, rep] of pairs) {
    t = t.replace(re, rep);
  }
  if (t !== orig) return { text: t.replace(/\s+/g, ' ').trim(), changed: true };
  return { text: t, changed: false };
}

function rewriteInterrogateWeakEndings(text, role) {
  const r = String(role || '').toLowerCase();
  let s = String(text || '').trim();
  if (!s) return { text: s, changed: false };
  const weakEndings = [
    /다시\s*확인해\s*보겠습니다\.?/,
    /다시\s*말씀드리겠습니다\.?/,
    /검토해\s*보겠습니다\.?/,
    /확인해\s*드리겠습니다\.?/,
    /살펴보겠습니다\.?/
  ];
  const pilotWeakPatterns = [
    /상황이\s*급변/,
    /상황이\s*복잡/,
    /변수(가|는)?\s*있/,
    /다를\s*수\s*있/,
    /해석될\s*수\s*있/,
    /보일\s*수\s*있/,
    /느껴질\s*수\s*있/,
    /\S+될\s*수\s*있/,
    /좋지\s*않/
  ];
  const replacements = {
    doctor: '바이탈·생체 기록이 그 시각을 말합니다.',
    engineer: '접근 로그·타임스탬프가 증거입니다.',
    navigator: '차트와 교량 기록이 맞지 않습니까.',
    pilot: '압력과 진동이 증거입니다.'
  };
  const rep = replacements[r] || '기록이 말해줍니다.';
  let changed = false;

  const kept = s
    .split(/[.。]/)
    .map((sent) => String(sent || '').trim())
    .filter(Boolean)
    .filter((sent) => {
      for (const re of weakEndings) {
        if (re.test(sent)) {
          changed = true;
          return false;
        }
      }
      if (r === 'pilot') {
        for (const re of pilotWeakPatterns) {
          if (re.test(sent)) {
            changed = true;
            return false;
          }
        }
      }
      return true;
    });

  let out = kept.join('. ').trim();
  if (!out) out = rep;
  else {
    if (!/[.]$/.test(out)) out += '.';
    out += ' ' + rep;
  }
  return { text: out.trim(), changed };
}

function maybeThreatTargetSpecificityBoost(s, role, loc, kind, actionSlug) {
  if (kind !== 'THREATEN' || loc !== 'ko') return { text: s, changed: false };
  const r = String(role || '').toLowerCase();
  const t0 = String(s || '').trim();
  if (!t0) return { text: t0, changed: false };
  let t = t0;
  const hasDoc = /의무실|생체|모니터|스트레스\s*로그|바이탈|기록|환자/.test(t);
  const hasEng = /접근\s*로그|체크섬|기계실|시스템\s*기록|감사|타임스탬프|장비/.test(t);
  const hasNav = /차트|시간대|항로|경로|대조/.test(t);
  const hasPilot = /계기|압력|진동|브리지|조종석|조종/.test(t);
  if (r === 'doctor') {
    if (
      /(책임지고|생명과\s*건강|환자들의\s*생명|건강을\s*책임|환자들의)/.test(t) &&
      !hasDoc
    ) {
      try {
        console.log('[bot][dialogue] threat_target_specificity_boost_applied role=doctor');
      } catch (e) {}
      if (/총|겨누|방아쇠|거두|총구/.test(t)) {
        let out = t.replace(/[.]+$/, '').trim();
        if (!/성급한\s*판단/.test(out)) out = '지금 저를 위협하시는 건 성급한 판단입니다. ' + out;
        out +=
          ' 의무실 기록·생체 모니터·스트레스 로그를 보면 아직 확인해야 할 수치가 남아 있습니다. 지금 저를 잃으면 환자 상태와 바이탈 기록은 누가 관리하겠습니까?';
        return { text: out.replace(/\s+/g, ' ').trim(), changed: true };
      }
      return {
        text:
          '지금 저를 위협하시는 건 성급한 판단입니다. 의무실 기록과 생체 모니터를 보면 아직 확인해야 할 수치가 남아 있습니다. 지금 저를 잃으면 환자 상태와 바이탈 기록은 누가 관리하겠습니까?',
        changed: true
      };
    }
  } else if (r === 'engineer') {
    if (/(책임지고\s*있습니다|맡고\s*있습니다|제\s*역할|시스템을\s*맡)/.test(t) && !hasEng) {
      try {
        console.log('[bot][dialogue] threat_target_specificity_boost_applied role=engineer');
      } catch (e) {}
      return {
        text:
          t.replace(/[.]+$/, '') +
          ' 접근 로그·시스템 기록·장비 점검 태그가 기계실 작업 동선을 찍습니다.',
        changed: true
      };
    }
  } else if (r === 'navigator') {
    if (t.length < 55 && /항해|판단/.test(t) && !hasNav) {
      try {
        console.log('[bot][dialogue] threat_target_specificity_boost_applied role=navigator');
      } catch (e) {}
      return {
        text: t.replace(/[.]+$/, '') + ' 차트·시간대·항로 대조가 그 시각 제 위치를 말합니다.',
        changed: true
      };
    }
  } else if (r === 'pilot') {
    if (
      !hasPilot &&
      t.length < 55 &&
      /(느낌|기분|이상|애매|막연|위험해|조심해야\s*해|흐려질|고조되고)/.test(t)
    ) {
      try {
        console.log('[bot][dialogue] threat_target_specificity_boost_applied role=pilot');
      } catch (e) {}
      return {
        text: t.replace(/[.]+$/, '') + ' 브리지 계기·압력·진동 반응이 제 자리를 말합니다.',
        changed: true
      };
    }
  }
  return { text: s, changed: false };
}

function maybeDoctorActionSpecificityBoost(s, loc, kind, actionSlug) {
  if (kind !== 'CHECK_LOG' && kind !== 'THREATEN') return { text: s, changed: false };
  const t = String(s || '').trim();
  if (!t) return { text: t, changed: false };
  if (loc === 'ko') {
    if (
      /의무실은\s*필수적입니다\s*$|의무실은\s*필수입니다\s*$|^의무실만\s+필수/.test(t) ||
      (t.length < 38 && /^의무실은\s*필수/.test(t))
    ) {
      try {
        console.log(
          '[bot][dialogue] doctor_action_specificity_boost_applied action=' + actionSlug + ' role=doctor'
        );
      } catch (e) {}
      return {
        text:
          t + ' 의무실 기록·스트레스 로그·바이탈을 보면 지금 성급한 판단은 위험합니다.',
        changed: true
      };
    }
  } else if (/^Medbay\s+is\s+essential/i.test(t) && t.length < 45) {
    try {
      console.log(
        '[bot][dialogue] doctor_action_specificity_boost_applied action=' + actionSlug + ' role=doctor'
      );
    } catch (e) {}
    return {
      text: t + ' Medbay records and stress logs show vitals volatility—hasty judgment is risky.',
      changed: true
    };
  }
  return { text: s, changed: false };
}

function rewriteActionResponseNoPersonalNamesLine(text, role, loc, crewPersonalNames, kind, threatTargetRole) {
  const actionSlug = actionLogSlugForKind(kind);
  const r = String(role || '').toLowerCase();
  let s = String(text || '').trim();
  if (!s) return { text: s, changed: false, detected: false };
  const orig = s;
  const tokens = collectCrewPersonalNameTokens(crewPersonalNames || {});
  let detected = false;

  for (const tok of tokens) {
    if (tok && tok.length >= 2 && s.includes(tok)) {
      detected = true;
      s = s.split(tok).join('');
    }
  }
  s = s
    .replace(/\s+/g, ' ')
    .replace(/^\s*의\s+/g, '')
    .replace(/,\s*,/g, ',')
    .replace(/^\s*,\s*/, '')
    .replace(/\s*,\s*$/g, '')
    .trim();

  if (loc === 'ko') {
    for (const tok of tokens) {
      if (!tok) continue;
      const poss = new RegExp(
        escapeRegExp(tok) +
          '의\\s+(생체 데이터|기록|상태|목소리|눈빛|표정|생체 모니터|스트레스 로그|바이탈|환자|환자 상태)',
        'g'
      );
      const beforePoss = s;
      s = s.replace(poss, '$1');
      if (s !== beforePoss) detected = true;
    }
    s = s.replace(
      /[가-힣A-Za-z]{2,20}의\s+(생체 데이터|기록|상태|목소리|눈빛|표정|스트레스 로그|바이탈|생체 모니터)/g,
      (full, noun) => {
        detected = true;
        return noun;
      }
    );
    s = s.replace(/[가-힣]{2,12}의\s*(목소리|눈빛|표정|손|숨|어깨)/g, () => {
      detected = true;
      return '';
    });
    for (const tok of tokens) {
      if (!tok) continue;
      const lead = new RegExp('^' + escapeRegExp(tok) + '[은는이가]\\s+');
      const beforeLead = s;
      s = s.replace(lead, '').trim();
      if (s !== beforeLead) detected = true;
    }
    s = s.replace(/저는\s+[가-힣A-Za-z]{2,20}(?:입니다|이며)\s*/g, () => {
      detected = true;
      return '';
    });
    s = s.replace(/\s+/g, ' ').trim();
  } else {
    s = s.replace(
      /\b[A-Z][a-z]+\s+[A-Z][a-z]+'s\s+(biometrics|records|state|voice|gaze|expression|vitals|stress log)\b/gi,
      (full, noun) => {
        detected = true;
        return noun;
      }
    );
    s = s.replace(/^[A-Z][a-z]+\s+[A-Z][a-z]+\s+(is|was)\s+/i, () => {
      detected = true;
      return '';
    });
    s = s.replace(/\s+/g, ' ').trim();
  }

  if (kind === 'THREATEN' && loc === 'ko' && r !== 'captain') {
    const tt = threatTargetRole ? String(threatTargetRole).toLowerCase() : null;
    if (!tt || r === tt) {
      const tb = maybeThreatTargetSpecificityBoost(s, r, loc, kind, actionSlug);
      if (tb.changed) s = tb.text;
    }
  }

  if ((kind === 'CHECK_LOG' || kind === 'THREATEN') && r === 'doctor') {
    const boost = maybeDoctorActionSpecificityBoost(s, loc, kind, actionSlug);
    if (boost.changed) s = boost.text;
  }

  if (detected) {
    try {
      console.log('[bot][dialogue] action_name_reference_detected action=' + actionSlug + ' role=' + r);
    } catch (e) {}
  }
  if (s !== orig) {
    try {
      console.log(
        '[bot][dialogue] action_response_rewritten_without_name action=' + actionSlug + ' role=' + r
      );
    } catch (e) {}
  }
  return { text: s, changed: s !== orig, detected };
}

/**
 * CHECK_LOG / TAKE_PISTOL / THREATEN / FIND_CLUE / QUESTION: 최종 표시에서 실명·소유격 이름 구문 제거.
 */
function sanitizeActionResponseNoPersonalNames(displayLogs, locale, opts) {
  opts = opts || {};
  const kind = opts.dialogueLlmKind;
  if (
    kind !== 'CHECK_LOG' &&
    kind !== 'TAKE_PISTOL' &&
    kind !== 'THREATEN' &&
    kind !== 'FIND_CLUE' &&
    kind !== 'QUESTION'
  ) {
    return displayLogs;
  }
  const loc = locale === 'en' ? 'en' : 'ko';
  const crewPersonalNames = opts.crewPersonalNames || null;
  const threatTargetRole = opts.threatTargetRole || null;
  const logs = Array.isArray(displayLogs) ? displayLogs.slice() : [];
  const headers = getLlmRoleHeaders(loc);
  const hToRole = {
    [headers.doctor]: 'doctor',
    [headers.engineer]: 'engineer',
    [headers.navigator]: 'navigator',
    [headers.pilot]: 'pilot',
    [captainHeader(loc)]: 'captain'
  };
  let pendingRole = null;
  let awaitingCrewBody = false;
  let awaitingCaptainBody = false;
  for (let i = 0; i < logs.length; i++) {
    const typ = String(logs[i]?.type || '').trim();
    const rk = hToRole[typ];
    if (rk) {
      pendingRole = rk;
      awaitingCrewBody = rk !== 'captain';
      awaitingCaptainBody = rk === 'captain';
      continue;
    }
    if (awaitingCaptainBody && typ && !typ.startsWith('[') && !rk) {
      const rw = rewriteActionResponseNoPersonalNamesLine(typ, 'captain', loc, crewPersonalNames, kind, threatTargetRole);
      logs[i] = { ...logs[i], type: rw.text };
      awaitingCaptainBody = false;
      continue;
    }
    if (awaitingCrewBody && pendingRole && pendingRole !== 'captain' && typ && !typ.startsWith('[')) {
      const rw = rewriteActionResponseNoPersonalNamesLine(typ, pendingRole, loc, crewPersonalNames, kind, threatTargetRole);
      logs[i] = { ...logs[i], type: rw.text };
      awaitingCrewBody = false;
      continue;
    }
    if (typ.startsWith('[') && !rk) {
      awaitingCrewBody = false;
      awaitingCaptainBody = false;
    }
  }
  return logs;
}

/**
 * CHECK_LOG / TAKE_PISTOL / THREATEN / FIND_CLUE / QUESTION: 크루→함장 한국어 존댓말 후처리(반말 종결 교정 + applyHonorificCrewKo).
 */
function sanitizeActionResponseHonorificKo(displayLogs, locale, opts) {
  opts = opts || {};
  const kind = opts.dialogueLlmKind;
  if (
    kind !== 'CHECK_LOG' &&
    kind !== 'TAKE_PISTOL' &&
    kind !== 'THREATEN' &&
    kind !== 'FIND_CLUE' &&
    kind !== 'QUESTION'
  ) {
    return displayLogs;
  }
  const loc = locale === 'en' ? 'en' : 'ko';
  if (loc !== 'ko') return displayLogs;
  const actionSlug = actionLogSlugForKind(kind);
  const logs = Array.isArray(displayLogs) ? displayLogs.slice() : [];
  const headers = getLlmRoleHeaders(loc);
  const hToRole = {
    [headers.doctor]: 'doctor',
    [headers.engineer]: 'engineer',
    [headers.navigator]: 'navigator',
    [headers.pilot]: 'pilot',
    [captainHeader(loc)]: 'captain'
  };
  let pendingRole = null;
  let awaitingCrewBody = false;
  let awaitingCaptainBody = false;
  for (let i = 0; i < logs.length; i++) {
    const typ = String(logs[i]?.type || '').trim();
    const rk = hToRole[typ];
    if (rk) {
      pendingRole = rk;
      awaitingCrewBody = rk !== 'captain';
      awaitingCaptainBody = rk === 'captain';
      continue;
    }
    if (awaitingCaptainBody && typ && !typ.startsWith('[') && !rk) {
      awaitingCaptainBody = false;
      continue;
    }
    if (awaitingCrewBody && pendingRole && pendingRole !== 'captain' && typ && !typ.startsWith('[')) {
      let line = typ;
      const h = applyHonorificCrewKo(line, pendingRole);
      if (h.changed) {
        line = h.text;
        try {
          console.log(
            '[bot][dialogue] action_honorific_tone_applied action=' + actionSlug + ' role=' + pendingRole
          );
        } catch (e) {}
      }
      logs[i] = { ...logs[i], type: line };
      awaitingCrewBody = false;
      continue;
    }
    if (typ.startsWith('[') && !rk) {
      awaitingCrewBody = false;
      awaitingCaptainBody = false;
    }
  }
  return logs;
}

/**
 * THREATEN/TAKE_PISTOL: 이름 제거·제3자 무대 묘사 축소·비타깃 응원 멘트 교체.
 */
function sanitizeThreatTakePistolDisplayLogs(displayLogs, locale, opts) {
  opts = opts || {};
  const kind = opts.dialogueLlmKind;
  if (kind !== 'THREATEN' && kind !== 'TAKE_PISTOL') return displayLogs;
  const loc = locale === 'en' ? 'en' : 'ko';
  const tokens = collectCrewPersonalNameTokens(opts.crewPersonalNames);
  const threatT = opts.threatTargetRole ? String(opts.threatTargetRole).toLowerCase() : null;
  const actionSlug = kind === 'THREATEN' ? 'threat' : 'take_pistol';

  const cheerKo =
    /(힘내|힘들겠|도와줄|안쓰럽|걱정|응원|위로|파이팅|괜찮을\s*거|괜찮아|수고|고생)/;
  const cheerEn = /\b(hang\s*in|you\s*got\s*this|I\s*feel\s*for|cheer\s*up|poor\s+you|stay\s+strong)\b/i;

  const stageKo = /[가-힣]{2,12}의\s*(목소리|눈빛|표정|손|숨|어깨)/;
  const stageEn = /\b[A-Z][a-z]+\s+[A-Z][a-z]+'s\s+(voice|eyes|gaze|breath|hands)\b/;

  function stripNames(line) {
    let s = String(line || '');
    for (const tok of tokens) {
      if (tok && tok.length >= 2) s = s.split(tok).join('');
    }
    s = s.replace(/\s+/g, ' ').replace(/^\s*,\s*/, '').replace(/\s*,\s*$/g, '').trim();
    return s;
  }

  function processBodyLine(text, role) {
    const r = String(role || '').toLowerCase();
    let s = stripNames(text);
    if (r === 'captain') {
      if (tokens.some((tok) => tok && String(text).includes(tok))) {
        try {
          console.log('[bot][dialogue] name_leak_blocked action=' + actionSlug + ' role=' + r);
        } catch (e) {}
      }
      try {
        console.log('[bot][dialogue] action_tone_applied type=' + actionSlug + ' role=' + r);
      } catch (e) {}
      return s;
    }
    if (loc === 'ko' && stageKo.test(s)) {
      try {
        console.log('[bot][dialogue] narrative_stage_cue_blocked role=' + r);
      } catch (e) {}
      s = s.replace(stageKo, '').replace(/\s+/g, ' ').trim();
    }
    if (loc === 'en' && stageEn.test(s)) {
      try {
        console.log('[bot][dialogue] narrative_stage_cue_blocked role=' + r);
      } catch (e) {}
      s = s.replace(stageEn, '').replace(/\s+/g, ' ').trim();
    }
    if (kind === 'THREATEN' && threatT && r === threatT) {
      if ((loc === 'ko' && looksLikeThirdPersonKoreanThreatLine(s)) || (loc === 'en' && looksLikeThirdPersonEnglishThreatLine(s))) {
        try {
          console.log('[bot][dialogue] narrative_stage_cue_blocked role=' + r);
        } catch (e) {}
        s = threatTargetFallbackLine(r, loc);
        try {
          console.log('[bot][dialogue] fallback_template_used action=' + actionSlug + ' role=' + r);
        } catch (e) {}
      }
    }
    if (tokens.some((tok) => tok && String(text).includes(tok))) {
      try {
        console.log('[bot][dialogue] name_leak_blocked action=' + actionSlug + ' role=' + r);
      } catch (e) {}
    }
    if (kind === 'THREATEN' && threatT && r !== 'captain' && r !== threatT) {
      if ((loc === 'ko' && cheerKo.test(s)) || (loc === 'en' && cheerEn.test(s))) {
        s = threatNonTargetMinimalLine(r, loc);
        try {
          console.log('[bot][dialogue] non_target_threat_reply_suppressed role=' + r);
        } catch (e) {}
      }
    }
    if (!s && r !== 'captain') {
      s =
        kind === 'THREATEN' && threatT && r === threatT
          ? threatTargetFallbackLine(r, loc)
          : kind === 'THREATEN' && threatT && r !== threatT
            ? threatNonTargetMinimalLine(r, loc)
            : takePistolFallbackLine(r, loc);
      try {
        console.log('[bot][dialogue] fallback_template_used action=' + actionSlug + ' role=' + r);
      } catch (e) {}
    }
    try {
      console.log('[bot][dialogue] action_tone_applied type=' + actionSlug + ' role=' + r);
    } catch (e) {}
    return s;
  }

  const logs = Array.isArray(displayLogs) ? displayLogs.slice() : [];
  const headers = getLlmRoleHeaders(loc);
  const hToRole = {
    [headers.doctor]: 'doctor',
    [headers.engineer]: 'engineer',
    [headers.navigator]: 'navigator',
    [headers.pilot]: 'pilot',
    [captainHeader(loc)]: 'captain'
  };
  let pendingRole = null;
  let awaitingCrewBody = false;
  let awaitingCaptainBody = false;
  for (let i = 0; i < logs.length; i++) {
    const typ = String(logs[i]?.type || '').trim();
    const rk = hToRole[typ];
    if (rk) {
      pendingRole = rk;
      awaitingCrewBody = rk !== 'captain';
      awaitingCaptainBody = rk === 'captain';
      continue;
    }
    if (awaitingCaptainBody && typ && !typ.startsWith('[') && !rk) {
      logs[i] = { ...logs[i], type: processBodyLine(typ, 'captain') };
      awaitingCaptainBody = false;
      continue;
    }
    if (awaitingCrewBody && pendingRole && pendingRole !== 'captain' && typ && !typ.startsWith('[')) {
      logs[i] = { ...logs[i], type: processBodyLine(typ, pendingRole) };
      awaitingCrewBody = false;
      continue;
    }
    if (typ.startsWith('[') && !rk) {
      awaitingCrewBody = false;
      awaitingCaptainBody = false;
    }
  }
  if (kind === 'THREATEN' && threatT) {
    return filterThreatenDisplayLogsToCaptainAndTarget(logs, loc, threatT);
  }
  return logs;
}

/**
 * LLM 실패 시 THREATEN/TAKE_PISTOL 전용 결정적 표시 로그(실명·응원·3인칭 내레이션 없음).
 */
function buildThreatTakePistolFallbackDisplayLogs(match, locale, kind, rawEvents, captainForced) {
  if (kind !== 'THREATEN' && kind !== 'TAKE_PISTOL') return null;
  const loc = locale === 'en' ? 'en' : 'ko';
  const capH = captainHeader(loc);
  const headers = getLlmRoleHeaders(loc);
  const gs = match?.game_state || {};
  const deadRoles = gs.dead_roles || [];
  const alive = CREW_ROLES_FOR_NAMES.filter((r) => !deadRoles.includes(r));
  const ev0 = rawEvents && rawEvents[0];
  const target = kind === 'THREATEN' && ev0?.target ? String(ev0.target).toLowerCase() : null;
  const capBody =
    String(captainForced || '').trim() ||
    (kind === 'THREATEN'
      ? loc === 'en'
        ? 'Hold the line.'
        : '함장이 방아쇠에 손을 올렸다.'
      : loc === 'en'
        ? 'The captain arms with the sidearm.'
        : '함장이 권총을 취했다.');
  const out = [];
  out.push({ type: capH, role: 'system', target: null, _key: 'tp-fb|cap-h' });
  out.push({ type: capBody, role: 'system', target: null, _key: 'tp-fb|cap-b' });
  if (kind !== 'THREATEN') {
    try {
      console.log('[bot][dialogue] fallback_template_used action=' + dialogueActionKindSlug(kind) + ' role=all');
    } catch (e) {}
  }

  if (kind === 'THREATEN') {
    if (target && alive.includes(target)) {
      const r = target;
      const line = threatTargetFallbackLine(r, loc);
      out.push({ type: headers[r], role: 'system', target: null, _key: 'tp-fb|h|' + r });
      out.push({ type: line, role: 'system', target: null, _key: 'tp-fb|b|' + r });
      try {
        console.log('[bot][dialogue] fallback_template_used action=' + dialogueActionKindSlug(kind) + ' role=' + r);
      } catch (e) {}
    }
    return normalizePlayerFacingDisplayLogs(out, loc);
  }

  for (const r of alive) {
    const line = takePistolFallbackLine(r, loc);
    out.push({ type: headers[r], role: 'system', target: null, _key: 'tp-fb|h|' + r });
    out.push({ type: line, role: 'system', target: null, _key: 'tp-fb|b|' + r });
  }
  return normalizePlayerFacingDisplayLogs(out, loc);
}

function suspicionHeavyInPlayerText(playerText) {
  return /(의심|범인|거짓|처형|쏘지\s*말|총을|누가\s*범|임포|traitor|accuse|execute|shoot)/i.test(
    String(playerText || '')
  );
}

/**
 * 함장이 특정 역할에게 자기변호·신뢰·무죄를 요구할 때(일반 targeted보다 우선 강화).
 * targeted_question 분류에서도 동일 함수 사용.
 */
function isSelfDefenseQuestionContext(playerText) {
  const t = String(playerText || '');
  return (
    /(왜\s*당신|왜\s*아니|아닌가|왜\s*아닌|not\s*you|why\s*you|why\s*not|why\s*me)/i.test(t) ||
    /(왜\s*네가\s*아닌|왜\s*당신을\s*믿|당신이\s*범인이\s*아닌|당신이\s*아니라는\s*증거)/i.test(t) ||
    /(why\s+should\s+i\s+trust|evidence\s+(that\s+)?you\s*(?:’|'|are)\s*not|proof\s+you\s*(?:’|'|are)\s*not)/i.test(
      t
    )
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
  const selfDefense = !!(opts.isSelfDefenseQuestion || isSelfDefenseQuestionContext(pt));
  const suspicionHeavy = suspicionHeavyInPlayerText(pt);
  const suspicionWeak =
    /(의심|수상|이상|어색|awkward|strange|suspicious|뭔가|who\s*should|누구.*의심)/i.test(pt) &&
    !suspicionHeavy;
  const threat = /(권총|총|처형|위협|threat|shoot|execute|pistol|쏘|겨누|총구)/i.test(pt);
  const captainIntent =
    opts.captainIntent ||
    (opts.dialogueLlmKind === 'QUESTION' || opts.dialogueLlmKind === 'THREATEN'
      ? inferCaptainIntent(pt, opts.dialogueLlmKind || '')
      : 'QUESTION');
  const groupPressure =
    /(자네들|다들|모두|승무원들|승무원\s+중|전원|everyone|all\s+of\s+you)/i.test(pt) &&
    /(의심|범인|누가|말해|증언|alibi|where|why|왜|범인)/i.test(pt);
  const targetedAccusation =
    /(당신이|너는\s*범|you\s*(?:are|'re|’re)\s*the|why\s*you|왜\s*당신|pointing\s*at)/i.test(pt);
  const lateGame = remainingSec != null && remainingSec <= 120;
  const interrogationTone = captainIntent === 'INTERROGATE';
  const neutralQuestionTone = captainIntent === 'QUESTION';
  const threatToneMode = captainIntent === 'THREAT';
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
    captainIntent,
    interrogationTone,
    neutralQuestionTone,
    threatToneMode,
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
  if (ctx.interrogationTone) o.isInterrogationTone = true;
  if (ctx.threatToneMode) o.isThreatToneMode = true;
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
    if (selfDefense && r !== 'captain') {
      const sdHard = {
        doctor: [
          [
            /저는\s*상황을\s*잘\s*알고\s*있습니다\.?/g,
            '함장님, 그 오해는 받아들일 수 없습니다. 그 시각 의무실·생체 모니터와 복도 출입 기록을 대조하고 있었습니다.'
          ],
          [
            /의사로서\s*최선을\s*다하고\s*있습니다\.?/g,
            '지금은 감정이 아니라 기록입니다. 스트레스 로그와 부상자·바이탈이 제 알리바이입니다. 함장님, 저를 쏘시면 남은 상태 기록과 부상자 관리는 누가 맡습니까?'
          ]
        ],
        engineer: [
          [
            /저는\s*상황을\s*잘\s*알고\s*있습니다\.?/g,
            '함장님, 그 오해는 받아들일 수 없습니다. 그 시각 접근 로그·릴레이 타임스탬프에 제 노드가 찍혀 있습니다.'
          ],
          [/최선을\s*다하고\s*있습니다\.?/g, '감정이 아니라 체크섬입니다. 코어 감사 로그부터 맞추십시오.']
        ],
        navigator: [
          [
            /저는\s*상황을\s*잘\s*알고\s*있습니다\.?/g,
            '함장님, 그 오해는 받아들일 수 없습니다. 그 시각 차트·항로와 제 동선이 같은 분에 겹칩니다.'
          ],
          [/최선을\s*다하고\s*있습니다\.?/g, '감정이 아니라 경로입니다. 기록부터 맞추십시오.']
        ],
        pilot: [
          [
            /저는\s*상황을\s*잘\s*알고\s*있습니다\.?/g,
            '함장님, 그 오해는 받아들일 수 없습니다. 그 시각 교량 계기·압력 로그가 제 자리를 말합니다.'
          ],
          [/최선을\s*다하고\s*있습니다\.?/g, '감정이 아니라 계기입니다. 진동·소리로 말하겠습니다.']
        ]
      };
      const pickSd = sdHard[r];
      if (pickSd) {
        for (const [re, rep] of pickSd) {
          if (re.test(s)) {
            s = s.replace(re, rep);
            changed = true;
            selfDefenseApplied = true;
            markGeneric();
          }
        }
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
    if (selfDefense && r !== 'captain') {
      const sdHardEn = {
        doctor: [
          [
            /I\s+know\s+the\s+situation\s+well/gi,
            'Captain—that is a misread. I was cross-checking medbay vitals and corridor access when it mattered.'
          ],
          [
            /I\s*(am|'m)\s+doing\s+my\s+best\s+as\s+a\s+doctor/gi,
            'This is records, not morale. Vitals and casualty triage logs are my alibi—who runs casualty triage if you remove me now?'
          ]
        ],
        engineer: [
          [
            /I\s+know\s+the\s+situation\s+well/gi,
            'Captain—that is a misread. Access logs and checksums place my node on station for that window.'
          ],
          [
            /I\s*(am|'m)\s+doing\s+my\s+best/gi,
            'This is checksums, not pep talks—audit the core trail before you name me.'
          ]
        ],
        navigator: [
          [
            /I\s+know\s+the\s+situation\s+well/gi,
            'Captain—that is a misread. Charts and routes pin my corridor for that minute.'
          ],
          [
            /I\s*(am|'m)\s+doing\s+my\s+best/gi,
            'This is track data, not performance reviews—align the route before you aim.'
          ]
        ],
        pilot: [
          [
            /I\s+know\s+the\s+situation\s+well/gi,
            'Captain—that is a misread. Bridge instruments and pressure show where I stood.'
          ],
          [
            /I\s*(am|'m)\s+doing\s+my\s+best/gi,
            'This is gauges and hull feel, not slogans—read the helm readouts first.'
          ]
        ]
      };
      const pickE = sdHardEn[r];
      if (pickE) {
        for (const [re, rep] of pickE) {
          if (re.test(s)) {
            s = s.replace(re, rep);
            changed = true;
            selfDefenseApplied = true;
            markGeneric();
          }
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

function escapeRegexForSelfDefense(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitSentencesForSelfDefense(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  return s
    .split(/(?<=[.!?])\s+/)
    .map((x) => String(x || '').trim())
    .filter(Boolean);
}

function roleSelfDefenseFallbackKo(r) {
  switch (String(r || '').toLowerCase()) {
    case 'doctor':
      return '그건 오해입니다. 그 시각 저는 의무실 생체 모니터 앞에 있었습니다. 바이탈·스트레스 로그와 복도 출입 기록이 제 동선을 말합니다. 저를 지금 제거하시면 남은 환자 기록은 누가 맡습니까?';
    case 'engineer':
      return '그건 오해입니다. 접근 로그와 타임스탬프가 제 동선을 찍습니다. 체크섬·감사 로그는 거짓말하지 않습니다. 지금 저를 끊으면 감사 추적은 누가 이어갑니까?';
    case 'navigator':
      return '그건 오해입니다. 차트·항해 기록·시간대 대조가 그 시각 제 위치를 말합니다. 항로 로그를 지금 끊으면 누가 교량과 대조합니까?';
    case 'pilot':
      return '그건 오해입니다. 그 시각 교량 계기·압력·진동 로그가 제 자리를 말합니다. 브리지 기록을 지금 끊으면 누가 이어갑니까?';
    default:
      return '그건 오해입니다. 기록과 로그가 제 동선을 말합니다.';
  }
}

function roleSelfDefenseFallbackEn(r) {
  switch (String(r || '').toLowerCase()) {
    case 'doctor':
      return 'That is a misunderstanding, Captain. I was at the medbay biometrics console. Vitals, stress logs, and corridor access corroborate my movement. If you remove me now, who triages the casualties and the charts?';
    case 'engineer':
      return 'That is a misunderstanding, Captain. Access logs and timestamps pin my path. Checksums and audit trails do not lie. If you cut me out now, who holds the audit chain?';
    case 'navigator':
      return 'That is a misunderstanding, Captain. Charts, route logs, and the time window place me on scope. If you silence me now, who cross-checks the bridge against the plot?';
    case 'pilot':
      return 'That is a misunderstanding, Captain. Bridge gauges, pressure traces, and vibration logs put me at the helm stack. If you remove me now, who keeps the bridge record straight?';
    default:
      return 'That is a misunderstanding, Captain. Logs and records place me — cutting me out does not make the ship safer.';
  }
}

/**
 * self-defense 첫 1~2문장에서 이름/직무 소개 절을 감지·의미 보존 재작성. strip만 하지 않고 알리바이·근거로 정리.
 * @returns {{ text: string, rewritten: boolean, stripped: boolean }}
 */
function rewriteSelfDefenseOpeningText(raw, role, locale, opts) {
  opts = opts || {};
  const loc = locale === 'en' ? 'en' : 'ko';
  const r = String(role || '').toLowerCase();
  const targetedNameQ = !!opts.targetedNameQuestion;
  const cn = opts.crewPersonalNames || null;
  const stable =
    cn && r && ['doctor', 'engineer', 'navigator', 'pilot'].includes(r)
      ? getCrewDisplayName(cn, r, loc)
      : '';
  let text = String(raw || '').trim();
  if (!text) return { text, rewritten: false, stripped: false };

  const sentences = splitSentencesForSelfDefense(text);
  if (sentences.length === 0) return { text, rewritten: false, stripped: false };

  const patternsHit = [];
  let strippedAny = false;

  function logPattern(p) {
    patternsHit.push(p);
    try {
      console.log('[bot][dialogue] self_defense_name_pattern_detected role=' + r + ' pattern=' + p);
    } catch (e) {}
  }

  function scrubKoSentence(sent) {
    let s = sent;
    const beforeScrub = s;
    const reps = [
      [/저는\s+[가-힣A-Za-z·]{2,24}(?:이며|입니다|이고|이고요)\s*,?\s*/g, 'intro_jeune_name'],
      [/저는\s*(?:의사|엔지니어|네비게이터|파일럿|닥터|의관)로서[^.!?]*/g, 'role_roseo_clause'],
      [/역할을\s*맡고\s*있(?:습니다|어요|다)/g, 'role_malgot'],
      [/최선을\s*다하고\s*있습니다/g, 'choesun'],
      [/상황을\s*잘\s*알고\s*있습니다/g, 'situ_well'],
      [/환자의\s*상태를\s*점검하고[^.!?]*/g, 'patient_check_clause'],
      [/치료하는\s*역할[^.!?]*/g, 'treat_role_clause']
    ];
    if (stable && stable.length >= 2) {
      const esc = escapeRegexForSelfDefense(stable);
      reps.push([new RegExp('저는\\s*' + esc + '(?:이며|입니다|이고|이고요)\\s*,?\\s*', 'g'), 'stable_jeune']);
      reps.push([new RegExp('^' + esc + '입니다\\.?\\s*', 'm'), 'stable_lead_입니다']);
    }
    for (const [re, tag] of reps) {
      const next = s.replace(re, () => {
        logPattern(tag);
        strippedAny = true;
        return '';
      });
      s = next;
    }
    s = s.replace(/\s+/g, ' ').replace(/^\s*,\s*/g, '').replace(/\s*,\s*,/g, ',').trim();
    if (s !== beforeScrub && !s) strippedAny = true;
    return s;
  }

  function scrubEnSentence(sent) {
    let s = sent;
    const beforeScrubEn = s;
    const reps = [
      [/\bI\s+am\s+[A-Za-z][A-Za-z'\-]+\s*,?\s*and\s+/gi, 'I_am_name_and'],
      [/\bMy\s+name\s+is\s+[^,.!?]+[,.]?\s*/gi, 'my_name_is'],
      [/\bAs\s+a\s+(?:doctor|engineer|navigator|pilot)\b[^.!?]*/gi, 'as_a_role'],
      [/\bI(?:'|’)?m\s+[A-Za-z][A-Za-z'\-]+\s*,?\s*/g, 'Im_name_comma'],
      [/my\s+role\s+is[^.!?]*/gi, 'my_role_is'],
      [/\bdoing\s+my\s+best\b[^.!?]*/gi, 'doing_best'],
      [/\bI\s+know\s+the\s+situation\s+well\b[^.!?]*/gi, 'know_situation'],
      [/\bI\s+am\s+responsible\s+for[^.!?]*/gi, 'responsible_for']
    ];
    if (stable && /^[A-Za-z]/.test(stable)) {
      const esc = escapeRegexForSelfDefense(stable);
      reps.push([new RegExp('\\bI\\s+am\\s+' + esc + '\\b[^.!?]*', 'gi'), 'stable_I_am']);
    }
    for (const [re, tag] of reps) {
      s = s.replace(re, () => {
        logPattern(tag);
        strippedAny = true;
        return '';
      });
    }
    s = s.replace(/\s+/g, ' ').replace(/^\s*,\s*/g, '').trim();
    if (s !== beforeScrubEn && !s) strippedAny = true;
    return s;
  }

  const head = [];
  const maxEarly = Math.min(1, sentences.length - 1);
  for (let i = 0; i <= maxEarly; i++) {
    let sent = sentences[i];
    if (loc === 'ko') sent = scrubKoSentence(sent);
    else sent = scrubEnSentence(sent);
    if (!sent || /^[,.\s]*$/.test(sent)) {
      strippedAny = true;
      head.push('');
    } else {
      head.push(sent);
    }
  }

  let rewritten = patternsHit.length > 0;
  const needsStableStrip = !targetedNameQ && stable && text.includes(stable);
  const needsNameAppend = targetedNameQ && stable && !text.includes(stable);
  if (patternsHit.length === 0 && !strippedAny && !needsStableStrip && !needsNameAppend) {
    return { text: raw, rewritten: false, stripped: false };
  }

  let denialKo = '그건 오해입니다.';
  let denialEn = 'That is a misunderstanding, Captain.';
  const firstOrig = sentences[0] || '';
  if (/^(그건\s*오해|함장님,\s*저를\s*오해|그렇게\s*보셨다면)/.test(firstOrig.trim())) {
    const m = firstOrig.trim().match(/^[^.!?]+[.!?]?/);
    if (m) denialKo = m[0].trim();
  }
  if (/^(That\s+is\s+a\s+misunderstanding|You\s+are\s+reading)/i.test(firstOrig.trim())) {
    const m = firstOrig.match(/^[^.!?]+[.!?]?/);
    if (m) denialEn = m[0].trim();
  }

  function repairHead() {
    const a = head[0] && head[0].trim() ? head[0].trim() : null;
    const b = head[1] && head[1].trim() ? head[1].trim() : null;
    const fb = loc === 'ko' ? roleSelfDefenseFallbackKo(r) : roleSelfDefenseFallbackEn(r);
    if (!a && !b) {
      try {
        console.log('[bot][dialogue] self_defense_name_intro_stripped role=' + r);
        console.log('[bot][dialogue] self_defense_rewritten_without_intro role=' + r);
      } catch (e) {}
      return fb;
    }
    let out = [];
    if (a) out.push(a);
    else {
      out.push(loc === 'ko' ? denialKo : denialEn);
      rewritten = true;
    }
    if (b) out.push(b);
    else if (sentences.length > 2 || (sentences[1] && !head[1])) {
      let alibiOnly;
      if (loc === 'ko') {
        alibiOnly =
          r === 'doctor'
            ? '그 시각 저는 의무실 생체 모니터 앞에 있었습니다.'
            : r === 'engineer'
              ? '그 시각 접근 로그와 타임스탬프가 제 동선을 찍습니다.'
              : r === 'navigator'
                ? '차트·항로 기록이 그 시각 제 위치와 맞습니다.'
                : r === 'pilot'
                  ? '교량 계기·압력 로그가 그 시각 제 자리를 말합니다.'
                  : '기록이 제 동선을 말합니다.';
      } else {
        alibiOnly =
          r === 'doctor'
            ? 'I was at the medbay biometrics stack at that time.'
            : r === 'engineer'
              ? 'Access logs and timestamps pin my path.'
              : r === 'navigator'
                ? 'Charts and route logs match that window.'
                : r === 'pilot'
                  ? 'Bridge gauges and pressure traces place me at the helm.'
                  : 'The logs place me.';
      }
      out.push(alibiOnly);
      rewritten = true;
    }
    const joined = out.join(' ');
    try {
      if (strippedAny || rewritten) {
        console.log('[bot][dialogue] self_defense_name_intro_stripped role=' + r);
        console.log('[bot][dialogue] self_defense_rewritten_without_intro role=' + r);
      }
    } catch (e) {}
    return joined;
  }

  const tail = sentences.slice(2);
  let newHeadText = repairHead();
  if (tail.length) {
    newHeadText = newHeadText + (newHeadText && !/[.!?]$/.test(newHeadText) ? '.' : '') + ' ' + tail.join(' ');
  }

  newHeadText = newHeadText.replace(/\s+/g, ' ').trim();

  if (!targetedNameQ && stable && newHeadText.includes(stable)) {
    logPattern('stable_name_in_non_name_self_defense');
    newHeadText = newHeadText.split(stable).join('').replace(/\s+/g, ' ').replace(/\s*,\s*,/g, ',').trim();
    rewritten = true;
    try {
      console.log('[bot][dialogue] self_defense_rewritten_without_intro role=' + r);
    } catch (e) {}
  }

  if (targetedNameQ && stable && newHeadText && !newHeadText.includes(stable)) {
    const thirdPlus = splitSentencesForSelfDefense(newHeadText);
    const nameLine =
      loc === 'ko' ? `제 이름은 ${stable}입니다.` : `My name is ${stable}.`;
    if (thirdPlus.length >= 3) {
      thirdPlus.splice(2, 0, nameLine);
      newHeadText = thirdPlus.join(' ');
    } else {
      newHeadText = newHeadText + ' ' + nameLine;
    }
    rewritten = true;
    try {
      console.log('[bot][dialogue] self_defense_rewritten_without_intro role=' + r);
    } catch (e) {}
  }

  if (newHeadText !== text) rewritten = true;
  return { text: newHeadText || text, rewritten, stripped: strippedAny };
}

function generalTargetedFallbackNoName(role, loc) {
  const r = String(role || '').toLowerCase();
  if (loc === 'en') {
    const m = {
      doctor:
        'I was in medbay with patients on record—vitals and corridor access are logged.',
      engineer: 'I was at the machine room console; access stamps still pin my path.',
      navigator: 'I was on the chart stack; the bridge clock and route window place me there.',
      pilot: 'I was on the bridge; helm gauges and pressure response were logged.'
    };
    return m[r] || m.doctor;
  }
  const m = {
    doctor: '그때 저는 의무실에서 환자 케어와 바이탈 기록을 맞추고 있었습니다.',
    engineer: '그 시각 저는 기계실 콘솔에서 접근 로그와 스탬프를 확인하고 있었습니다.',
    navigator: '그때 저는 차트 스택과 교량 시계에 맞춰 항로를 확인하고 있었습니다.',
    pilot: '그때 저는 브리지에서 계기·압력 반응을 확인하고 있었습니다.'
  };
  return m[r] || m.doctor;
}

function rewriteGeneralTargetedNoNameIntro(text, role, loc, crewPersonalNames) {
  void crewPersonalNames;
  const r = String(role || '').toLowerCase();
  let s = String(text || '').trim();
  if (!s) return { text: s, changed: false };
  const orig = s;

  function stripLead(sentence) {
    let x = String(sentence || '').trim();
    const before = x;
    if (loc === 'ko') {
      x = x.replace(/^[가-힣A-Za-z]{2,20}입니다\.\s*/u, '');
      x = x.replace(/^[가-힣A-Za-z]{2,20}입니다\s+/u, '');
      x = x.replace(/^저는\s+[가-힣A-Za-z]{2,20}(?:입니다|이며)[,.\s]*/u, '');
      x = x.replace(/^저는\s+[가-힣A-Za-z]{2,20}\s*,\s*/u, '');
    } else {
      x = x.replace(/^I\s+am\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?[.,]?\s*/i, '');
      x = x.replace(/^I'm\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?[.,]?\s*/i, '');
      x = x.replace(/^My\s+name\s+is\s+[A-Za-z .]+[.,]?\s*/i, '');
    }
    if (x !== before) {
      try {
        console.log('[bot][dialogue] non_name_targeted_intro_blocked role=' + r);
      } catch (e) {}
    }
    return x.trim();
  }

  const parts = s.split(/(?<=[.!?。])\s+/).filter(Boolean);
  const newParts = parts.map((p, i) => (i < 2 ? stripLead(p) : p));
  s = newParts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  if (!s || s.length < 6) {
    s = generalTargetedFallbackNoName(r, loc);
    try {
      console.log('[bot][dialogue] targeted_question_rewritten_without_name role=' + r);
    } catch (e) {}
    return { text: s, changed: true };
  }

  if (s !== orig) {
    try {
      console.log('[bot][dialogue] targeted_question_rewritten_without_name role=' + r);
    } catch (e) {}
  }
  return { text: s, changed: s !== orig };
}

function rewriteCheckLogPilotGeneric(text, loc) {
  const t = String(text || '').trim();
  if (!t) return { text: t, changed: false };
  if (loc === 'ko') {
    if (
      /기분이\s*좋지\s*않|이상한\s*기운|잘못된\s*것\s*같은\s*느낌|뭔가\s*잘못|불안정해\s*보입니다/.test(
        t
      )
    ) {
      try {
        console.log('[bot][dialogue] pilot_checklog_generic_detected role=pilot');
      } catch (e) {}
      const out =
        '브리지 계기 반응이 평소보다 늦고, 압력 표시가 감사 로그 타임스탬프와 어긋납니다. 조종대 아래에서 미세한 진동이 올라옵니다.';
      try {
        console.log('[bot][dialogue] pilot_checklog_rewritten role=pilot');
      } catch (e) {}
      return { text: out, changed: true };
    }
  } else if (
    /feel(?:ing)?\s+off|odd\s+vibe|something\s+feels\s+wrong|unstable\s+here|something(?:'s|s)\s+wrong/i.test(
      t
    )
  ) {
    try {
      console.log('[bot][dialogue] pilot_checklog_generic_detected role=pilot');
    } catch (e) {}
    const out =
      'Bridge gauge response is lagging versus baseline; pressure trace skews from the audit timestamps. A faint vibration rides up through the helm stack.';
    try {
      console.log('[bot][dialogue] pilot_checklog_rewritten role=pilot');
    } catch (e) {}
    return { text: out, changed: true };
  }
  return { text: t, changed: false };
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
  const selfDefenseSingle =
    !!(opts.isSelfDefenseQuestion || opts.isTargetedAccusation) && !!opts.targetedQuestionSingleSpeaker;
  if (selfDefenseSingle && loc === 'ko' && looksLikeRoleOnlyKoNameIntro(s)) {
    const alibi =
      r === 'doctor'
        ? '그 시각 저는 의무실 생체 모니터 앞에 있었습니다.'
        : r === 'engineer'
          ? '그 시각 접근 로그와 타임스탬프가 제 동선을 찍습니다.'
          : r === 'navigator'
            ? '차트·항해 기록이 그 시각 제 위치와 맞습니다.'
            : '교량 계기·압력 로그가 그 시각 제 자리를 말합니다.';
    s = `그건 오해입니다. ${alibi} 제 이름은 ${stable}입니다.`;
    changed = true;
    try {
      console.log('[bot][dialogue] role_intro_blocked_for_name_question role=' + r);
      console.log('[bot][dialogue] stable_name_applied role=' + r);
    } catch (e) {}
  } else if (selfDefenseSingle && loc === 'en' && looksLikeRoleOnlyEnNameIntro(s)) {
    const alibi =
      r === 'doctor'
        ? 'I was at the medbay biometrics stack at that time.'
        : r === 'engineer'
          ? 'Access logs and timestamps pin my path.'
          : r === 'navigator'
            ? 'Charts and route logs match that window.'
            : 'Bridge gauges and pressure traces place me at the helm.';
    s = `That is a misunderstanding, Captain. ${alibi} My name is ${stable}.`;
    changed = true;
    try {
      console.log('[bot][dialogue] role_intro_blocked_for_name_question role=' + r);
      console.log('[bot][dialogue] stable_name_applied role=' + r);
    } catch (e) {}
  } else if (loc === 'ko' && looksLikeRoleOnlyKoNameIntro(s)) {
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

/** targeted_question: 엔진이 만든 비타깃 CREW_DIALOGUE 제거(단일 화자). */
function filterQuestionEventsForTargetedSingleSpeaker(rawEvents, targetRole) {
  const t = String(targetRole || '').toLowerCase();
  const evs = rawEvents || [];
  const out = [];
  for (const ev of evs) {
    const typ = String(ev.type || '').toUpperCase();
    if (typ === 'QUESTION' || typ === 'SUSPECT') {
      out.push(ev);
      continue;
    }
    if (typ !== 'CREW_DIALOGUE') {
      out.push(ev);
      continue;
    }
    const r = String(ev.role || '').toLowerCase();
    if (r === 'captain') {
      out.push(ev);
      continue;
    }
    if (r === t) {
      out.push(ev);
      continue;
    }
    try {
      console.log('[bot][dialogue] non_target_crew_silenced role=' + r);
    } catch (e) {}
  }
  return out;
}

function isGenericNonTargetFillerLine(text, locale) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (locale === 'en') {
    return /^(Interesting\.?|Noted\.?|I\s+see\.?|That\s+helps\.?|Important\.?)$/i.test(s) ||
      /\b(says\s+that|was\s+there|how\s+interesting)\b/i.test(s);
  }
  return /(그렇군요|흥미롭네요|중요합니다|잘\s*파악해야|라고\s*하네요|였군요|알겠습니다\.?\s*$)/.test(s);
}

/**
 * LLM이 비타깃 줄을 남긴 경우 최종 표시 로그에서 제거.
 */
function filterDisplayLogsToTargetedSingleSpeaker(displayLogs, targetRole, locale) {
  const t = String(targetRole || '').toLowerCase();
  const loc = locale === 'en' ? 'en' : 'ko';
  const logs = Array.isArray(displayLogs) ? displayLogs : [];
  if (!t || !['doctor', 'engineer', 'navigator', 'pilot'].includes(t)) return displayLogs;
  const out = [];
  let i = 0;
  while (i < logs.length) {
    const typ = String(logs[i]?.type || '').trim();
    const rk = roleKeyFromBracketHeaderLine(typ);
    if (rk) {
      if (rk === 'captain' || rk === t) {
        out.push(logs[i]);
        i++;
        while (i < logs.length) {
          const t2 = String(logs[i]?.type || '').trim();
          if (roleKeyFromBracketHeaderLine(t2)) break;
          if (/^\[/.test(t2) && !roleKeyFromBracketHeaderLine(t2)) break;
          out.push(logs[i]);
          i++;
        }
        continue;
      }
      let blockedGeneric = false;
      try {
        console.log('[bot][dialogue] non_target_crew_silenced role=' + rk);
      } catch (e) {}
      i++;
      while (i < logs.length) {
        const t2 = String(logs[i]?.type || '').trim();
        if (roleKeyFromBracketHeaderLine(t2)) break;
        if (/^\[/.test(t2) && !roleKeyFromBracketHeaderLine(t2)) break;
        if (isGenericNonTargetFillerLine(t2, loc)) blockedGeneric = true;
        i++;
      }
      if (blockedGeneric) {
        try {
          console.log('[bot][dialogue] generic_non_target_reply_blocked role=' + rk);
        } catch (e) {}
      }
      continue;
    }
    out.push(logs[i]);
    i++;
  }
  return out;
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
      if (loc === 'ko') {
        const h1 = applyHonorificCrewKo(newLine, pendingRole);
        newLine = h1.text;
      }
      const st = stabilizeNameQuestionCrewLine(newLine, pendingRole, loc, opts);
      newLine = st.text;
      if (opts.dialogueLlmKind === 'CHECK_LOG' && pendingRole === 'pilot') {
        const ck = rewriteCheckLogPilotGeneric(newLine, loc);
        if (ck.changed) newLine = ck.text;
      }
      out.push({ ...item, type: newLine });
      continue;
    }
    out.push(item);
  }
  let outFinal = out;
  if (opts.dialogueLlmKind === 'THREATEN' || opts.dialogueLlmKind === 'TAKE_PISTOL') {
    outFinal = sanitizeThreatTakePistolDisplayLogs(outFinal, loc, {
      dialogueLlmKind: opts.dialogueLlmKind,
      threatTargetRole: opts.threatTargetRole || null,
      crewPersonalNames: opts.crewPersonalNames || null
    });
  }
  const ak = opts.dialogueLlmKind;
  if (ak === 'CHECK_LOG' || ak === 'TAKE_PISTOL' || ak === 'THREATEN' || ak === 'FIND_CLUE') {
    outFinal = sanitizeActionResponseNoPersonalNames(outFinal, loc, {
      dialogueLlmKind: ak,
      crewPersonalNames: opts.crewPersonalNames || null,
      threatTargetRole: opts.threatTargetRole || null
    });
    outFinal = sanitizeActionResponseHonorificKo(outFinal, loc, {
      dialogueLlmKind: ak,
      threatTargetRole: opts.threatTargetRole || null
    });
  }
  return outFinal;
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
  loreCanonAnchorText,
  targetedQuestionSingleSpeaker,
  isSelfDefenseQuestion,
  isTargetedAccusation
}) {
  const loc = locale === 'en' ? 'en' : 'ko';
  const kind = getDialogueLlmKind(rawEvents);
  if (!kind) return deterministicLogs;
  const actionSlug = dialogueActionKindSlug(kind);
  const eventsCount = (rawEvents || []).length;
  const modelStr = TELEGRAM_DIALOGUE_MODEL_L2;
  const apiProvider = isDeepSeekDialogueModel(modelStr) ? 'deepseek' : 'openai';

  const ev0 = rawEvents && rawEvents[0];
  const nameTargetRole =
    targetedNameQuestion && kind === 'QUESTION' && ev0?.target
      ? String(ev0.target).toLowerCase()
      : null;
  const tqSingle = !!targetedQuestionSingleSpeaker && kind === 'QUESTION' && ev0?.target;
  const isolateRole = tqSingle ? String(ev0.target).toLowerCase() : null;
  const generalTargetedQuestion =
    !!tqSingle &&
    !targetedNameQuestion &&
    !isSelfDefenseQuestion &&
    !isTargetedAccusation;

  const toneOptsBase = {
    playerText: playerText || '',
    targetedNameQuestion: !!targetedNameQuestion,
    targetedNameFocusRole: nameTargetRole,
    crewPersonalNames: null,
    isSelfDefenseQuestion: !!isSelfDefenseQuestion,
    isTargetedAccusation: !!isTargetedAccusation,
    targetedQuestionSingleSpeaker: !!tqSingle,
    selfDefenseIsolateRole: isolateRole,
    generalTargetedQuestion: generalTargetedQuestion
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
  toneOptsBase.dialogueLlmKind = kind;
  toneOptsBase.threatTargetRole =
    kind === 'THREATEN' && ev0?.target ? String(ev0.target).toLowerCase() : null;
  toneOptsBase.captainIntent =
    kind === 'QUESTION' || kind === 'THREATEN'
      ? inferCaptainIntent(playerText || '', kind)
      : 'QUESTION';

  if (kind === 'LORE_QUESTION') {
    try {
      console.log('[bot][warn] lore_question attempted to enter crew pipeline');
    } catch (e) {}
    logDialogueTrace(actionSlug, 'deterministic', modelStr, 'system_only', eventsCount);
    return buildLoreQuestionSystemOnlyDisplayLogs(locale, playerText || '');
  }

  if (!isDialogueLlmConfigured()) {
    logDialogueTrace(actionSlug, 'deterministic', modelStr, 'fallback', eventsCount);
    if (kind === 'THREATEN' || kind === 'TAKE_PISTOL') {
      try {
        console.log(
          '[bot][dialogue] action=' +
            actionSlug +
            ' provider=deterministic model=' +
            modelStr +
            ' result=fallback'
        );
      } catch (e) {}
    }
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
    const capFb =
      forcedCaptainTextOverride != null && String(forcedCaptainTextOverride).trim()
        ? String(forcedCaptainTextOverride).trim()
        : extractCaptainSpokenFromDisplayLogs(deterministicLogs, loc);
    if ((kind === 'THREATEN' || kind === 'TAKE_PISTOL') && match) {
      const tpf = buildThreatTakePistolFallbackDisplayLogs(match, loc, kind, rawEvents, capFb);
      if (tpf && tpf.length) det = tpf;
    }
    let detTone = det;
    if (tqSingle && isolateRole) {
      detTone = filterDisplayLogsToTargetedSingleSpeaker(detTone, isolateRole, loc);
    }
    return applyCharacterToneToDisplayLogs(detTone, loc, toneOptsBase);
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
    targetedQuestionSingleSpeaker: tqSingle,
    isSelfDefenseQuestion: !!isSelfDefenseQuestion,
    isTargetedAccusation: !!isTargetedAccusation,
    locale: loc,
    loreQuestionTopic,
    loreCanonAnchorText
  });
  if (llmLogs && llmLogs.length) {
    logDialogueTrace(actionSlug, apiProvider, modelStr, 'llm', eventsCount);
    if (kind === 'THREATEN' || kind === 'TAKE_PISTOL') {
      try {
        console.log(
          '[bot][dialogue] action=' +
            actionSlug +
            ' provider=' +
            apiProvider +
            ' model=' +
            modelStr +
            ' result=llm'
        );
      } catch (e) {}
    }
    let outL = llmLogs;
    if (tqSingle && isolateRole) {
      outL = filterDisplayLogsToTargetedSingleSpeaker(outL, isolateRole, loc);
    }
    return applyCharacterToneToDisplayLogs(outL, loc, toneOptsBase);
  }
  logDialogueTrace(actionSlug, apiProvider, modelStr, 'fallback', eventsCount);
  if (kind === 'THREATEN' || kind === 'TAKE_PISTOL') {
    try {
      console.log(
        '[bot][dialogue] action=' +
          actionSlug +
          ' provider=' +
          apiProvider +
          ' model=' +
          modelStr +
          ' result=fallback'
      );
    } catch (e) {}
  }
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
  if ((kind === 'THREATEN' || kind === 'TAKE_PISTOL') && match) {
    const tpf = buildThreatTakePistolFallbackDisplayLogs(match, loc, kind, rawEvents, forcedCaptainText);
    if (tpf && tpf.length) detOut = tpf;
  }
  if (tqSingle && isolateRole) {
    detOut = filterDisplayLogsToTargetedSingleSpeaker(detOut, isolateRole, loc);
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
const EN_GIVEN_NAMES = [
  'Ethan',
  'Noah',
  'Liam',
  'Owen',
  'Lucas',
  'Mason',
  'Caleb',
  'Adrian',
  'Maya',
  'Lena',
  'Chloe',
  'Nora',
  'Hazel',
  'Stella',
  'Iris',
  'Ava',
  'Jordan',
  'Casey',
  'Riley',
  'Taylor',
  'Morgan',
  'Avery'
];
const EN_FAMILY_NAMES = [
  'Cole',
  'Reed',
  'Blake',
  'Hayes',
  'Brooks',
  'Carter',
  'Bennett',
  'Foster',
  'Parker',
  'Ward',
  'Bailey',
  'Hart',
  'Rhodes',
  'Ellis',
  'Dawson',
  'Quinn',
  'Sawyer',
  'Mercer'
];

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
    out[role] = { ko: koFull || '김민호', en: enFull || 'Ethan Cole' };
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
    const dlgRaw = ev?.dialogue && typeof ev.dialogue === 'string' ? ev.dialogue : '';
    const dlgSig =
      t === 'CREW_DIALOGUE' && dlgRaw
        ? dlgRaw
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120)
        : '';
    const baseKey = [ev?.ts ?? '', t, role, target ?? '', dlgSig].join('|');

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
            ? `${sysHdr} ${victimEn} biometric signal lost.`
            : `${sysHdr} Biometric signal lost.`
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
      let d = ev.dialogue.trim();
      if (locale === 'en' && t === 'CREW_DIALOGUE' && d) {
        if (
          d ===
            '[HADES] Final calculation complete. Fail to remove the overlap in time, and the ship is mine.' ||
          d ===
            '[HADES] Final calculation complete. Fail to remove the impostor in time, and the ship becomes mine.'
        ) {
          d =
            '[HADES]\nIt ends here. The moment you point at the wrong one, this ship is mine.';
        }
      }
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

/** group_question + name 응답 표시용 — match events 미수정 */
function isNameQuestionObserveBodyLine(t, loc) {
  const s = normalizeDisplayLine(t);
  if (!s) return false;
  if (loc === 'en') {
    return /^(?:observes|observe)\s+the\s+bridge/i.test(s) || /^the\s+bridge\.?$/i.test(s);
  }
  return /교량을\s*관찰했다\.?/i.test(s);
}

function isNameQuestionObserveSingleLine(t, loc) {
  const s = normalizeDisplayLine(t);
  if (!s) return false;
  if (loc === 'en') return /^The captain observes the bridge\.?$/i.test(s);
  return /함장이\s*교량을\s*관찰했다\.?/i.test(s);
}

function isNameQuestionClarificationBodyLine(t, loc) {
  const s = normalizeDisplayLine(t);
  if (!s) return false;
  if (loc === 'en') {
    return (
      /Please clarify the target/i.test(s) ||
      /AXIS,\s*HADES,\s*a log check/i.test(s) ||
      /specific crew question/i.test(s)
    );
  }
  return (
    /뜻한 대상을 한 번만 더/i.test(s) ||
    /AXIS,\s*HADES/i.test(s) ||
    /특정\s*승무원\s*질문/i.test(s) ||
    /구분이\s*필요합니다/i.test(s)
  );
}

function isNameQuestionClarificationLine(t, loc) {
  const s = normalizeDisplayLine(t);
  if (!s) return false;
  if (isNameQuestionClarificationBodyLine(s, loc)) return true;
  if (loc === 'en') return /^\[System\]\s*Please clarify/i.test(s);
  return /\[시스템\]\s*뜻한 대상/i.test(s);
}

function isNameQuestionHadesHeaderLine(t) {
  const s = normalizeDisplayLine(t);
  return /^\[HADES\]$/i.test(s) || s === '[HADES]';
}

function isNameQuestionTensionOrStaleNoiseLine(t, loc) {
  const s = normalizeDisplayLine(t);
  if (!s) return false;
  if (isNameQuestionHadesHeaderLine(t)) return true;
  if (/\[HADES\]/i.test(s) && s.length > 8) return true;
  if (loc === 'en') {
    return (
      /Internal anomaly detected/i.test(s) ||
      /Biometric signals in Medbay/i.test(s) ||
      /Optimal removal window is approaching/i.test(s) ||
      /There are already deaths/i.test(s) ||
      /Final calculation complete/i.test(s) ||
      /Fail to remove the impostor/i.test(s) ||
      /Time is shorter now/i.test(s) ||
      /One less\. Records/i.test(s) ||
      /It ends here/i.test(s)
    );
  }
  return (
    /내부 이상 징후 감지/i.test(s) ||
    /생체 신호가 불안정/i.test(s) ||
    /최적 제거 시점이 임박/i.test(s) ||
    /이미 사망자가 있다/i.test(s) ||
    /최종 계산 완료/i.test(s) ||
    /중첩체를 제거하지 못하면/i.test(s) ||
    /시간이 줄었다/i.test(s) ||
    /한 명 줄었다/i.test(s) ||
    /끝났다\. 네가 틀린 사람을 지목/i.test(s)
  );
}

function isNameQuestionSystemBiometricBodyLine(t, loc) {
  const s = normalizeDisplayLine(t);
  if (!s) return false;
  if (loc === 'en') {
    return /Biometric signals in Medbay|Internal anomaly detected/i.test(s);
  }
  return /내부 이상 징후|생체 신호가 불안정/i.test(s);
}

/**
 * group_question + groupSubkind=name 응답의 표시용 logs만 정리 (저장 이벤트 불변).
 * @param {object[]} logs
 * @param {'en'|'ko'} locale
 * @returns {object[]}
 */
function sanitizeNameQuestionDisplayLogs(logs, locale) {
  const loc = locale === 'en' ? 'en' : 'ko';
  if (!logs || !logs.length) return logs;
  const capH = captainHeader(loc);
  const sysH = systemHeader(loc);
  const roleHdrs = getLlmRoleHeaders(loc);
  const crewHeaders = ['doctor', 'engineer', 'navigator', 'pilot'].map((r) => roleHdrs[r]);

  let removedObserve = 0;
  let removedClarification = 0;
  let removedOther = 0;
  const beforeLen = logs.length;

  const stripped = [];
  let i = 0;
  while (i < logs.length) {
    const t = String(logs[i]?.type || '').trim();
    const tNext = i + 1 < logs.length ? String(logs[i + 1]?.type || '').trim() : '';

    if (t === capH && tNext && isNameQuestionObserveBodyLine(tNext, loc)) {
      removedObserve += 2;
      i += 2;
      continue;
    }
    if (t === capH && tNext && isNameQuestionClarificationBodyLine(tNext, loc)) {
      removedClarification += 2;
      i += 2;
      continue;
    }
    if (t === sysH && tNext && isNameQuestionClarificationBodyLine(tNext, loc)) {
      removedClarification += 2;
      i += 2;
      continue;
    }
    if (t === sysH && tNext && isNameQuestionSystemBiometricBodyLine(tNext, loc)) {
      removedOther += 2;
      i += 2;
      continue;
    }
    if (isNameQuestionHadesHeaderLine(t) && tNext && !/^\[/.test(tNext)) {
      removedOther += 2;
      i += 2;
      continue;
    }

    if (isNameQuestionObserveSingleLine(t, loc)) {
      removedObserve++;
      i++;
      continue;
    }
    if (isNameQuestionClarificationLine(t, loc)) {
      removedClarification++;
      i++;
      continue;
    }
    if (isNameQuestionTensionOrStaleNoiseLine(t, loc)) {
      removedOther++;
      i++;
      continue;
    }

    stripped.push(logs[i]);
    i++;
  }

  const capStart = stripped.findIndex(
    (item, idx) => String(item?.type || '').trim() === capH && idx + 1 < stripped.length
  );
  if (capStart < 0) {
    try {
      console.log(
        '[bot][name_question_sanitize] before=' +
          beforeLen +
          ' after=' +
          stripped.length +
          ' removed_observe=' +
          removedObserve +
          ' removed_clarification=' +
          removedClarification +
          ' removed_other=' +
          removedOther +
          ' (no captain header; strip-only)'
      );
    } catch (e) {}
    return stripped;
  }

  const out = [stripped[capStart], stripped[capStart + 1]];
  let j = capStart + 2;
  let lastCrewIdx = -1;
  while (j < stripped.length - 1) {
    const h = String(stripped[j]?.type || '').trim();
    const bi = crewHeaders.indexOf(h);
    if (bi < 0) break;
    if (bi <= lastCrewIdx) break;
    lastCrewIdx = bi;
    out.push(stripped[j], stripped[j + 1]);
    j += 2;
  }

  try {
    console.log(
      '[bot][name_question_sanitize] before=' +
        beforeLen +
        ' after=' +
        out.length +
        ' removed_observe=' +
        removedObserve +
        ' removed_clarification=' +
        removedClarification +
        ' removed_other=' +
        removedOther
    );
  } catch (e) {}

  return out;
}

/**
 * /start 처리
 * @param {string} playerId - telegram user id
 * @param {object} opts - { game_total_sec?, now? } 테스트용
 * @returns {Promise<string>}
 */
async function handleStart(playerId, opts = {}) {
  const loc = opts.locale === 'en' ? 'en' : 'ko';
  try {
    console.log('[bot][start] locale resolved=' + loc);
  } catch (e) {}

  if (opts.restart) {
    const pClear = await playerStore.getPlayer(playerId);
    if (pClear?.match_id) {
      const oldMid = pClear.match_id;
      try {
        console.log('[bot][restart] waiting previous timeout persist match_id=' + oldMid);
      } catch (e) {}
      await applyMatchClockTick(oldMid);
      const mRestart = await matchStore.getMatch(oldMid);
      if (mRestart?.game_state?.game_over) {
        await ensureGameOverPersistedToDb(oldMid, mRestart);
      }
      try {
        console.log('[bot][restart] previous timed-out match persisted before fresh start');
      } catch (e) {}
      await playerStore.setPlayer(playerId, {
        match_id: null,
        role: pClear.role || 'captain',
        joined_at: pClear.joined_at || new Date().toISOString()
      });
    }
  }

  const player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;

  let needNewMatch = !matchId;
  let existingMatch = null;
  if (matchId) {
    existingMatch = await matchStore.getMatch(matchId);
    try {
      console.log('[bot][start] existing match detected id=' + matchId + ' found=' + !!existingMatch);
    } catch (e) {}
    if (!existingMatch) needNewMatch = true;
    if (existingMatch?.game_state?.game_over) needNewMatch = true;
  }
  const oldMatchIdForLog = matchId;
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
    try {
      if (oldMatchIdForLog && oldMatchIdForLog !== matchId) {
        console.log(
          '[bot][start] stale/game_over match replaced with fresh match id=' + matchId + ' old=' + oldMatchIdForLog
        );
      }
      console.log(
        '[bot][start] player current match reassigned old=' + (oldMatchIdForLog || 'null') + ' new=' + matchId
      );
    } catch (e) {}
  }
  if (needNewMatch) {
    await kickOpeningChatForNewMatch(matchId, loc);
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
    await kickOpeningChatForNewMatch(matchId, locale);
  }

  let match = await matchStore.getMatch(matchId);
  if (!match) return 'Match not found. Send /start to begin.';

  const tensionNowTg =
    opts.now instanceof Date ? opts.now : opts.now != null ? new Date(opts.now) : new Date();
  const tensionTg = await persistTimerTensionForMatch(matchId, match, locale, tensionNowTg);
  match = tensionTg.match || match;

  await maybeRecoverStuckOpeningChat(matchId);
  match = (await matchStore.getMatch(matchId)) || match;
  if (isOpeningChatLocked(match.game_state || {})) {
    const throttledOg = shouldThrottleOpeningNotice(playerId, matchId);
    const noticeOg =
      locale === 'en'
        ? '[SYSTEM] Command channel opens after crew status check completes.'
        : '[시스템] 승무원 상태 확인이 끝난 뒤 지휘 채널이 열립니다.';
    if (throttledOg) {
      return '';
    }
    return noticeOg;
  }

  const resolvedTg = await resolveMiniappFreeClassification(text, locale);
  let cls = resolvedTg.cls;
  let parsed = resolvedTg.parsed;
  const routedFollow = applyRolelessDialogueFollowupRouting(text, locale, cls, parsed, match);
  cls = routedFollow.cls;
  parsed = routedFollow.parsed;
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
    let recentDisplay = dedupeDisplayLogs(toPlayerDisplayLogs(rawEvents, { locale }), locale);
    recentDisplay = mergePrependedTensionDisplayLogs(tensionTg, recentDisplay, locale);
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

  if (cls.kind === 'free_input_clarification') {
    const line =
      cls.clarificationText || defaultFreeInputClarificationLine(locale);
    const rawEv = { type: 'CREW_DIALOGUE', role: 'system', dialogue: line };
    try {
      await matchStore.appendEvent(matchId, rawEv);
      console.log('[bot][free_input_clarification] appended event match_id=' + String(matchId));
    } catch (e) {
      try {
        console.warn('[bot][free_input_clarification] appendEvent warn ' + String(e?.message || e));
      } catch (e2) {}
    }
    const matchAfter = await matchStore.getMatch(matchId);
    let recentDisplay = dedupeDisplayLogs(
      toPlayerDisplayLogs(matchAfter?.events || [], { locale }),
      locale
    );
    recentDisplay = mergePrependedTensionDisplayLogs(tensionTg, recentDisplay, locale);
    recentDisplay = compactClarificationDisplayLogs(recentDisplay, locale);
    let reply = recentDisplay.map((e) => e.type).filter(Boolean).join('\n') || '…';
    const timerCl = ep1Engine.getTimerStatus(matchAfter || match, now);
    const remCl = Math.max(0, Math.floor(timerCl.remaining_sec ?? 0));
    const mCl = Math.floor(remCl / 60);
    const sCl = remCl % 60;
    reply += '\n⏱ ' + mCl + ':' + String(sCl).padStart(2, '0') + ' left';
    return reply;
  }

  const consumesFreePromptTg = shouldConsumeFreePromptForMessageKind(cls, parsed, text);
  logIntentPromptDecision(cls, parsed, consumesFreePromptTg);
  if (consumesFreePromptTg) {
    const userKey = resolveUserKey(playerId, matchId);
    const pr = await consumeFreePromptIfAllowed(userKey, { locale });
    if (!pr.allowed) {
      const limT = pr.entitlement ? getEntitlementLimits(pr.entitlement).daily_free_prompt_limit : '?';
      const uT = pr.entitlement != null ? pr.entitlement.daily_free_prompt_used ?? '?' : '?';
      try {
        console.log('[bot][message] lore request blocked before response used=' + uT + ' limit=' + limT);
        console.log('[bot][entitlement] prompt final decision block');
      } catch (e) {}
      return locale === 'en'
        ? 'You have used all daily free-text prompts for today. Button actions are still available.'
        : '오늘의 자유입력 횟수를 모두 사용했습니다. 버튼 액션은 계속 사용할 수 있습니다.';
    }
    try {
      const uAfterTg = pr.entitlement?.daily_free_prompt_used ?? '?';
      console.log('[bot][entitlement] prompt final decision allow');
      console.log('[bot][message] lore response emitted blocked=false ok=true used=' + String(uAfterTg));
    } catch (e) {}
  }

  if (cls.kind === 'role_opinion_question') {
    console.log('[bot] message kind=role_opinion_question target=' + parsed.target);
    await clearPostOpeningWaitingForFirstCommanderInput(matchId);
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
    recentDisplay = mergePrependedTensionDisplayLogs(tensionTg, recentDisplay, locale);
    let reply = recentDisplay.map((e) => e.type).filter(Boolean).join('\n') || '…';
    const m = Math.floor(rem / 60);
    const sec = rem % 60;
    reply += '\n⏱ ' + m + ':' + String(sec).padStart(2, '0') + ' left';
    return reply;
  }

  if (cls.kind === 'group_question') {
    const sub = cls.groupSubkind || 'suspicion';
    console.log('[bot] message kind=group_question sub=' + sub);
    await clearPostOpeningWaitingForFirstCommanderInput(matchId);
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
    recentDisplay = mergePrependedTensionDisplayLogs(tensionTg, recentDisplay, locale);
    if (sub === 'name') {
      recentDisplay = sanitizeNameQuestionDisplayLogs(recentDisplay, locale);
    }
    let reply = recentDisplay.map((e) => e.type).filter(Boolean).join('\n') || '…';
    const m = Math.floor(rem / 60);
    const sec = rem % 60;
    reply += '\n⏱ ' + m + ':' + String(sec).padStart(2, '0') + ' left';
    return reply;
  }

  if (cls.kind === 'suspicion_question') {
    console.log('[bot] message kind=suspicion_question');
    await clearPostOpeningWaitingForFirstCommanderInput(matchId);
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
    recentDisplay = mergePrependedTensionDisplayLogs(tensionTg, recentDisplay, locale);
    let reply = recentDisplay.map((e) => e.type).filter(Boolean).join('\n') || '…';
    const m = Math.floor(rem / 60);
    const sec = rem % 60;
    reply += '\n⏱ ' + m + ':' + String(sec).padStart(2, '0') + ' left';
    return reply;
  }

  if (cls.kind === 'lore_question') {
    await clearPostOpeningWaitingForFirstCommanderInput(matchId);
    console.log('[bot] message kind=lore_question');
    try {
      console.log('[bot][route] lore pipeline selected');
    } catch (e) {}
    const gateTg = evaluateLoreUnknownTermGate('lore_question', String(text || ''), locale);
    if (gateTg.block) {
      await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
      const lineUnk = buildUnknownLoreTermSystemLine(locale, gateTg.term);
      const rawEvUnk = [{ type: 'CREW_DIALOGUE', role: 'system', dialogue: lineUnk }];
      const recentDisplayUnkBase = dedupeDisplayLogs(toPlayerDisplayLogs(rawEvUnk, { locale }), locale);
      const toStoreUnk = displayLogsToCrewDialogueEvents(recentDisplayUnkBase, locale);
      for (const ev of toStoreUnk) await matchStore.appendEvent(matchId, ev);
      const recentDisplayUnk = mergePrependedTensionDisplayLogs(tensionTg, recentDisplayUnkBase, locale);
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
    const recentDisplayLoreBase = buildLoreQuestionSystemOnlyDisplayLogs(locale, text);
    const toStore = displayLogsToCrewDialogueEvents(recentDisplayLoreBase, locale);
    for (const ev of toStore) await matchStore.appendEvent(matchId, ev);
    let recentDisplay = mergePrependedTensionDisplayLogs(tensionTg, recentDisplayLoreBase, locale);
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
    try {
      console.log('[bot][route] crew pipeline selected');
    } catch (e) {}
    await clearPostOpeningWaitingForFirstCommanderInput(matchId);
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
    recentDisplay = mergePrependedTensionDisplayLogs(tensionTg, recentDisplay, locale);
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

  const mappedThreatIntent = (() => {
    const it = String(parsed.intent_type || '').toLowerCase();
    return it === 'threaten' || it === 'threat';
  })();
  if (mappedThreatIntent) {
    try {
      console.log('[bot][intent] message kind=mapped:threaten');
    } catch (e) {}
  }

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
  await clearPostOpeningWaitingForFirstCommanderInput(matchId);
  let eventsForStore = result.events || [];
  if (cls.kind === 'targeted_question' && parsed.target) {
    eventsForStore = filterQuestionEventsForTargetedSingleSpeaker(eventsForStore, parsed.target);
    try {
      console.log('[bot][intent] targeted question isolated targetRole=' + String(parsed.target).toLowerCase());
    } catch (e) {}
  }
  if (eventsForStore.length > 0) {
    for (const ev of eventsForStore) {
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
    toPlayerDisplayLogs(eventsForStore, {
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
      rawEvents: eventsForStore,
      deterministicLogs,
      match: updated,
      playerText: String(text || '').trim(),
      clueTextFromEvent,
      locale,
      forcedCaptainTextOverride:
        cls.kind === 'targeted_question' && captainBodyForTq ? captainBodyForTq : undefined,
      targetedQuestionSideReactionRules: false,
      targetedNameQuestion: targetedNameQ,
      targetedQuestionSingleSpeaker: cls.kind === 'targeted_question',
      isSelfDefenseQuestion: !!cls.isSelfDefenseQuestion,
      isTargetedAccusation: !!(cls.isTargetedAccusation || parsed.isTargetedAccusation)
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
  recentDisplay = mergePrependedTensionDisplayLogs(tensionTg, recentDisplay, locale);
  try {
    const ev0p = eventsForStore && eventsForStore[0];
    const dkP = getDialogueLlmKind(eventsForStore);
    const tgtP = ev0p?.target ? String(ev0p.target).toLowerCase() : null;
    if (tgtP && (dkP === 'QUESTION' || dkP === 'THREATEN')) {
      const capPersist =
        cls.kind === 'targeted_question' && captainBodyForTq
          ? captainBodyForTq
          : stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) || String(text || '').trim();
      const rr = extractCrewDialogueBodyFromDisplayLogs(recentDisplay, tgtP, locale);
      await persistDialogueFocusMemory(matchId, {
        targetRole: tgtP,
        dialogueKind: dkP,
        captainText: capPersist,
        roleReply: rr
      });
    }
  } catch (e) {}
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
    await dbPersistAfterTelegramStart(playerId, opts);
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

/** game_state.timer_tension_warnings — 매 러닝 1회만, 새 매치면 자연 초기화 */
function ensureTimerWarningFlags(gs) {
  if (!gs || typeof gs !== 'object') return;
  const cur = gs.timer_tension_warnings && typeof gs.timer_tension_warnings === 'object' ? gs.timer_tension_warnings : {};
  gs.timer_tension_warnings = {
    sixMinuteWarningShown: cur.sixMinuteWarningShown === true,
    threeMinuteWarningShown: cur.threeMinuteWarningShown === true,
    oneMinuteWarningShown: cur.oneMinuteWarningShown === true
  };
}

function timerTensionDialogueLines(locale, gs) {
  const dead = Array.isArray(gs?.dead_roles) ? gs.dead_roles.length : 0;
  const ko6 =
    '[시스템]\n함선 내부 이상 징후 감지. 의료실과 엔진실의 생체 신호가 불안정하다.';
  const en6 =
    '[System] Internal anomaly detected. Biometric signals in Medbay and Engine Room are unstable.';
  const ko3Base =
    '[HADES]\n시간이 줄었다. 네가 망설이는 동안 나는 이미 다음을 골랐다.';
  const ko3Dead =
    '[HADES]\n한 명 줄었다. 기록은 거짓말하지 않는다 — 다음이 누구인지 너도 알고 있다.';
  const en3Base =
    '[HADES]\nTime is shorter now. While you hesitate, I have already chosen the next.';
  const en3Dead =
    '[HADES]\nOne less. Records don\'t lie — you already know who is next.';
  const ko1 =
    '[HADES]\n끝났다. 네가 틀린 사람을 지목하는 순간, 이 함선은 내 것이 된다.';
  const en1 =
    '[HADES]\nIt ends here. The moment you point at the wrong one, this ship is mine.';
  if (locale === 'en') {
    return { six: en6, three: dead > 0 ? en3Dead : en3Base, one: en1 };
  }
  return { six: ko6, three: dead > 0 ? ko3Dead : ko3Base, one: ko1 };
}

/**
 * 남은 초 기준 구간(6:00 / 3:00 / 1:00)에 맞춰 1회만 CREW_DIALOGUE 이벤트 생성. gs.timer_tension_warnings 갱신.
 * @returns {object[]} 이번 호출에서 새로 추가할 raw 이벤트
 */
function maybeEmitTimerTensionEvents(gs, remainingSeconds, locale) {
  ensureTimerWarningFlags(gs);
  const w = gs.timer_tension_warnings;
  const r = Math.max(0, Math.floor(Number(remainingSeconds) || 0));
  const lines = timerTensionDialogueLines(locale, gs);
  const out = [];
  if (!w.sixMinuteWarningShown && r <= 360 && r > 180) {
    w.sixMinuteWarningShown = true;
    out.push({ type: 'CREW_DIALOGUE', role: 'system', dialogue: lines.six });
  }
  if (!w.threeMinuteWarningShown && r <= 180 && r > 60) {
    w.threeMinuteWarningShown = true;
    out.push({ type: 'CREW_DIALOGUE', role: 'system', dialogue: lines.three });
  }
  if (!w.oneMinuteWarningShown && r <= 60) {
    w.oneMinuteWarningShown = true;
    out.push({ type: 'CREW_DIALOGUE', role: 'system', dialogue: lines.one });
  }
  return out;
}

function mergePrependedTensionDisplayLogs(tension, displayLogs, locale) {
  const base = displayLogs || [];
  if (!tension || !tension.displayLogs || !tension.displayLogs.length) return base;
  return dedupeDisplayLogs([...tension.displayLogs, ...base], locale);
}

/**
 * 타이머 구간 경고를 appendEvent + game_state 플래그에 반영.
 * @returns {Promise<{ newRawEvents: object[], match: object, displayLogs: object[] }>}
 */
/** Cleared on gameplay input (message/action/accuse/processActionApi) or each applyMatchClockTick (state poll) before tension. */
async function clearPostOpeningWaitingForFirstCommanderInput(matchId) {
  try {
    const m = await matchStore.getMatch(matchId);
    if (!m) return;
    const gs0 = m.game_state || {};
    if (gs0.post_opening_waiting_for_first_commander_input !== true) return;
    const gs = { ...gs0, post_opening_waiting_for_first_commander_input: false };
    await matchStore.updateMatch(matchId, { game_state: gs });
  } catch (e) {}
}

async function persistTimerTensionForMatch(matchId, match, locale, now) {
  const gs = match?.game_state;
  if (!gs || gs.game_over) {
    return { newRawEvents: [], match, displayLogs: [] };
  }
  if (gs.captain_phase === 'opening_chat' && gs.opening_sequence_completed !== true) {
    return { newRawEvents: [], match, displayLogs: [] };
  }
  if (gs.post_opening_waiting_for_first_commander_input === true) {
    return { newRawEvents: [], match, displayLogs: [] };
  }
  const tNow = now instanceof Date ? now : now != null ? new Date(now) : new Date();
  const timer = ep1Engine.getTimerStatus ? ep1Engine.getTimerStatus(match, tNow) : { remaining_sec: 420 };
  const rem = Math.max(0, Math.floor(timer.remaining_sec ?? 0));
  const newRaw = maybeEmitTimerTensionEvents(gs, rem, locale);
  if (newRaw.length === 0) {
    return { newRawEvents: [], match, displayLogs: [] };
  }
  for (const ev of newRaw) await matchStore.appendEvent(matchId, ev);
  await matchStore.updateMatch(matchId, { game_state: { ...gs } });
  const updated = await matchStore.getMatch(matchId);
  const displayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(newRaw, { locale }), locale);
  return { newRawEvents: newRaw, match: updated, displayLogs };
}

/**
 * opening_chat phase — scripted playback only.
 * Do not fake commander input, do not call ep1Engine for crew replies, do not use
 * tryGenerateLlmDialogueLogs / buildOpenQuestionCrewEvents / applyCharacterToneToDisplayLogs
 * or any normal free-input crew pipeline. Events are appended only via
 * appendOpeningScriptCrewDialogueEvent → matchStore.appendEvent.
 */
const OPENING_SCRIPT_EVENT_SOURCE = 'opening_script';

function appendOpeningScriptCrewDialogueEvent(matchId, role, dialogue) {
  return matchStore.appendEvent(matchId, {
    type: 'CREW_DIALOGUE',
    role,
    dialogue,
    event_source: OPENING_SCRIPT_EVENT_SOURCE,
    scripted_phase: 'opening_chat'
  });
}

/**
 * Scripted crew channel: status reports + banter, then Sector 7 anomaly.
 * Owen → navigator, Danny → engineer, Marcus → pilot, Yuna → doctor.
 */
const OPENING_CREW_CHANNEL_EN_A = [
  {
    delayMs: 0,
    role: 'system',
    dialogue:
      '[SYSTEM]\nCrew channel opening. Revival confirmed—report readiness by station.'
  },
  { delayMs: 620, role: 'pilot', dialogue: '[Pilot/Marcus]\n[Bridge] Helm stable. Passive sensors nominal.' },
  {
    delayMs: 620,
    role: 'engineer',
    dialogue: '[Engineer/Danny]\n[Engine Room] Core idle band holds. No thermal excursions on the boards.'
  },
  {
    delayMs: 620,
    role: 'navigator',
    dialogue: '[Navigator/Owen]\n[Navigation] Fixed solution locked. Corridor plot is clean.'
  },
  { delayMs: 620, role: 'doctor', dialogue: '[Doctor/Yuna]\n[Medbay] Wake checks green. Kits staged.' },
  { delayMs: 620, role: 'pilot', dialogue: '[Pilot/Marcus]\nCopy—wide-field trace looks quiet on my side.' },
  {
    delayMs: 620,
    role: 'engineer',
    dialogue: '[Engineer/Danny]\nEngineering standing by for load requests.'
  },
  { delayMs: 620, role: 'pilot', dialogue: '[Pilot/Marcus]\nBridge is ready.' },
  {
    delayMs: 620,
    role: 'navigator',
    dialogue:
      '[Navigator/Owen]\n[Sector 7] Abnormal thermal signature detected—this is not baseline.'
  },
  {
    delayMs: 620,
    role: 'engineer',
    dialogue: '[Engineer/Danny]\nSensor glitch? Try recalibrating the array.'
  },
  {
    delayMs: 620,
    role: 'navigator',
    dialogue: '[Navigator/Owen]\nNegative. The gradient is localized. This is not noise.'
  },
  {
    delayMs: 620,
    role: 'pilot',
    dialogue:
      '[Pilot/Marcus]\nSector 7 maps to sealed cargo access. That hatch should be cold-dead on telemetry.'
  },
  {
    delayMs: 620,
    role: 'doctor',
    dialogue: '[Doctor/Yuna]\nConfirmed—it should have remained sealed under my watch log.'
  },
  { delayMs: 620, role: 'navigator', dialogue: '[Navigator/Owen]\nCommander, awaiting orders.' }
];

const OPENING_CREW_CHANNEL_EN_B = [
  {
    delayMs: 0,
    role: 'system',
    dialogue:
      '[SYSTEM] WARNING: All visual and audio comms offline. PDA arm-unit group channel is the only active link. Maintain contact here.'
  },
  {
    delayMs: 620,
    role: 'pilot',
    dialogue:
      '[Pilot/Marcus] Bridge stable. Anyone else getting static on the hardlines or is it just my end.'
  },
  {
    delayMs: 620,
    role: 'engineer',
    dialogue:
      '[Engineer/Danny] Engine room here. Core holding. And yeah — everything\'s dead on my side too. Just us and these PDAs.'
  },
  {
    delayMs: 620,
    role: 'navigator',
    dialogue:
      '[Navigator/Owen] Navigation online. Corridor plot is clean. Is audio ever coming back or are we doing this the whole leg.'
  },
  {
    delayMs: 620,
    role: 'doctor',
    dialogue:
      "[Doctor/Yuna] Medbay. Wake checks done. Kits staged. I'd prefer to see faces right now but this will have to do."
  },
  {
    delayMs: 620,
    role: 'pilot',
    dialogue: '[Pilot/Marcus] Wide-field trace is quiet. For now.'
  },
  {
    delayMs: 620,
    role: 'engineer',
    dialogue:
      "[Engineer/Danny] Engineering standing by. Feels wrong doing status reports by text but here we are."
  },
  { delayMs: 620, role: 'pilot', dialogue: '[Pilot/Marcus] Bridge ready.' },
  { delayMs: 620, role: 'navigator', dialogue: '[Navigator/Owen] Hold on.' },
  {
    delayMs: 620,
    role: 'navigator',
    dialogue: '[Navigator/Owen] Sector 7. Abnormal thermal signature. That section should be reading cold.'
  },
  {
    delayMs: 620,
    role: 'engineer',
    dialogue: "[Engineer/Danny] Could be a sensor waking up wrong. These arrays have been sitting idle."
  },
  {
    delayMs: 620,
    role: 'navigator',
    dialogue: "[Navigator/Owen] Negative. It's localized and it's holding. This is not noise."
  },
  {
    delayMs: 620,
    role: 'pilot',
    dialogue: '[Pilot/Marcus] Sector 7 is sealed cargo access. Nothing should be generating heat in there.'
  },
  {
    delayMs: 620,
    role: 'doctor',
    dialogue: '[Doctor/Yuna] Confirmed. That compartment was locked under my watch log. It should be dark.'
  },
  { delayMs: 620, role: 'navigator', dialogue: '[Navigator/Owen] Commander, awaiting orders.' }
];

const OPENING_CREW_CHANNEL_KO_A = [
  {
    delayMs: 0,
    role: 'system',
    dialogue:
      '[시스템]\n승무원 채널 연결. 기상 확인됨—역할별 준비 상태를 보고하라.'
  },
  { delayMs: 620, role: 'pilot', dialogue: '[파일럿/마커스]\n[브리지] 조타 안정. 패시브 센서 정상.' },
  {
    delayMs: 620,
    role: 'engineer',
    dialogue: '[엔지니어/대니]\n[엔진실] 코어 유휴 대역 유지. 보드상 열 이탈 없음.'
  },
  {
    delayMs: 620,
    role: 'navigator',
    dialogue: '[네비게이터/오웬]\n[항해] 고정 해법 확정. 회랑 플롯 이상 없음.'
  },
  { delayMs: 620, role: 'doctor', dialogue: '[닥터/유나]\n[메드베이] 기상 점검 양호. 키트 배치 완료.' },
  { delayMs: 620, role: 'pilot', dialogue: '[파일럿/마커스]\n광역 트레이스는 이쪽도 조용하다.' },
  {
    delayMs: 620,
    role: 'engineer',
    dialogue: '[엔지니어/대니]\n엔지니어링, 부하 요청 대기 중.'
  },
  { delayMs: 620, role: 'pilot', dialogue: '[파일럿/마커스]\n브리지 준비 완료.' },
  {
    delayMs: 620,
    role: 'navigator',
    dialogue: '[네비게이터/오웬]\n[섹터 7] 비정상 열 패턴이다. 기준선이 아니다.'
  },
  {
    delayMs: 620,
    role: 'engineer',
    dialogue: '[엔지니어/대니]\n센서 글리치 아닐까? 배열 재보정이 필요할 수도.'
  },
  {
    delayMs: 620,
    role: 'navigator',
    dialogue: '[네비게이터/오웬]\n아니다. 구간이 국소적이다. 잡음이 아니다.'
  },
  {
    delayMs: 620,
    role: 'pilot',
    dialogue: '[파일럿/마커스]\n섹터 7은 봉인된 화물 접근구다. 텔레메트리상 그 해치는 완전 차단이어야 한다.'
  },
  {
    delayMs: 620,
    role: 'doctor',
    dialogue: '[닥터/유나]\n맞다. 내 감시 로그상 그 봉인은 열리지 않았어야 한다.'
  },
  { delayMs: 620, role: 'navigator', dialogue: '[네비게이터/오웬]\n함장님, 지시 바랍니다.' }
];

const OPENING_CREW_CHANNEL_KO_B = [
  {
    delayMs: 0,
    role: 'system',
    dialogue:
      '[시스템] 경고: 영상·음성 통신 전면 불능. 전 대원 PDA 단체 채널만 활성 상태. 이 채널을 유지하라.'
  },
  {
    delayMs: 620,
    role: 'pilot',
    dialogue: '[파일럿/마커스] 브리지 안정. 하드라인 잡음은 나만 그런 건지 다들 마찬가지인 건지.'
  },
  {
    delayMs: 620,
    role: 'engineer',
    dialogue: '[엔지니어/대니] 엔진룸. 코어 유지 중. 이쪽도 전부 죽었다. PDA밖에 없네.'
  },
  {
    delayMs: 620,
    role: 'navigator',
    dialogue: '[네비게이터/오웬] 항법 온라인. 회랑 플롯 이상 없음. 음성 통신은 언제 복구되는 거냐.'
  },
  {
    delayMs: 620,
    role: 'doctor',
    dialogue: '[닥터/유나] 의무실. 기상 점검 완료. 키트 배치됨. 지금 얼굴 보고 싶은데 이게 전부라니.'
  },
  { delayMs: 620, role: 'pilot', dialogue: '[파일럿/마커스] 광역 트레이스 조용하다. 지금은.' },
  {
    delayMs: 620,
    role: 'engineer',
    dialogue: '[엔지니어/대니] 엔지니어링 대기 중. 문자로 상태 보고하는 게 이상하지만 어쩔 수 없지.'
  },
  { delayMs: 620, role: 'pilot', dialogue: '[파일럿/마커스] 브리지 준비 완료.' },
  { delayMs: 620, role: 'navigator', dialogue: '[네비게이터/오웬] 잠깐.' },
  {
    delayMs: 620,
    role: 'navigator',
    dialogue: '[네비게이터/오웬] 섹터 7. 비정상 열 패턴이다. 그 구역은 차가워야 한다.'
  },
  {
    delayMs: 620,
    role: 'engineer',
    dialogue: '[엔지니어/대니] 센서가 잠에서 덜 깬 거 아닐까. 이 배열들 오래 놀았으니까.'
  },
  {
    delayMs: 620,
    role: 'navigator',
    dialogue: '[네비게이터/오웬] 아니다. 국소적이고 유지되고 있다. 잡음이 아니다.'
  },
  {
    delayMs: 620,
    role: 'pilot',
    dialogue: '[파일럿/마커스] 섹터 7은 봉인 화물 구역이다. 그 안에서 열이 날 게 없다.'
  },
  {
    delayMs: 620,
    role: 'doctor',
    dialogue: '[닥터/유나] 맞다. 내 감시 로그상 그 봉인은 잠겨 있어야 한다. 어두워야 한다.'
  },
  { delayMs: 620, role: 'navigator', dialogue: '[네비게이터/오웬] 함장님, 지시 바랍니다.' }
];

let _lastOpeningVariant = 'B';

const openingPlaybackLocks = new Set();
const openingNoticeThrottle = new Map();

function buildOpeningCrewChannelEvents(locale) {
  const variant = _lastOpeningVariant === 'A' ? 'B' : 'A';
  _lastOpeningVariant = variant;
  let list;
  if (locale === 'en') {
    list = variant === 'A' ? OPENING_CREW_CHANNEL_EN_A : OPENING_CREW_CHANNEL_EN_B;
  } else {
    list = variant === 'A' ? OPENING_CREW_CHANNEL_KO_A : OPENING_CREW_CHANNEL_KO_B;
  }
  return list.map((e) => ({
    delayMs: e.delayMs,
    role: e.role,
    dialogue: e.dialogue
  }));
}

function delayOpeningMs(ms) {
  const n = Number(ms);
  const v = Number.isFinite(n) ? n : 750;
  return new Promise((r) => setTimeout(r, Math.max(0, Math.min(v, 6000))));
}

function isOpeningChatLocked(gs) {
  if (!gs || typeof gs !== 'object') return false;
  if (gs.opening_sequence_completed) return false;
  return gs.captain_phase === 'opening_chat';
}

function shouldThrottleOpeningNotice(playerId, matchId) {
  const k = String(playerId || '') + '|' + String(matchId || '');
  const now = Date.now();
  const last = openingNoticeThrottle.get(k) || 0;
  if (now - last < 9000) return true;
  openingNoticeThrottle.set(k, now);
  return false;
}

async function failOpenOpeningChat(matchId, err) {
  try {
    console.log('[bot][opening_chat] fail_open matchId=' + matchId);
  } catch (e0) {}
  try {
    console.warn('[bot][opening_chat] fail_open', err?.message != null ? String(err.message) : String(err));
  } catch (e) {}
  try {
    const m = await matchStore.getMatch(matchId);
    const gs = { ...(m?.game_state || {}) };
    gs.captain_phase = 'playing';
    gs.opening_sequence_aborted = true;
    gs.opening_sequence_completed = true;
    gs.opening_chat_started_at_ms = null;
    await matchStore.updateMatch(matchId, { game_state: gs });
  } catch (e2) {
    try {
      console.warn('[bot][opening_chat] fail_open persist', e2?.message || e2);
    } catch (e3) {}
  }
}

async function finishOpeningChatSuccess(matchId) {
  try {
    const m = await matchStore.getMatch(matchId);
    const gs = { ...(m?.game_state || {}) };
    if (gs.opening_sequence_completed) return;
    gs.captain_phase = 'playing';
    gs.opening_sequence_completed = true;
    gs.opening_sequence_aborted = false;
    gs.opening_chat_started_at_ms = null;
    gs.post_opening_waiting_for_first_commander_input = true;
    await matchStore.updateMatch(matchId, { game_state: gs });
    try {
      console.log('[bot][opening_chat] sequence completed matchId=' + matchId);
    } catch (e2) {}
  } catch (e) {
    await failOpenOpeningChat(matchId, e);
  }
}

async function maybeRecoverStuckOpeningChat(matchId) {
  try {
    const m = await matchStore.getMatch(matchId);
    const gs = m?.game_state || {};
    if (gs.captain_phase !== 'opening_chat') return;
    if (gs.opening_sequence_completed) return;
    const t0 = gs.opening_chat_started_at_ms;
    if (t0 != null && Date.now() - Number(t0) > 28000) {
      await failOpenOpeningChat(matchId, new Error('opening_chat_stuck_timeout'));
    }
  } catch (e) {
    try {
      console.warn('[bot][opening_chat] maybeRecoverStuck', e?.message || e);
    } catch (e2) {}
  }
}

/** Call await on every new-match path before scheduling playback (avoids race with first message). */
async function persistOpeningChatStateBeforePlayback(matchId) {
  const m = await matchStore.getMatch(matchId);
  if (!m) return;
  const gs0 = m.game_state || {};
  if (gs0.opening_sequence_completed) return;
  if (gs0.captain_phase === 'opening_chat' && gs0.opening_sequence_started === true) return;
  const gs = {
    ...gs0,
    captain_phase: 'opening_chat',
    opening_sequence_started: true,
    opening_sequence_completed: false,
    opening_sequence_aborted: false,
    opening_chat_started_at_ms: Date.now()
  };
  await matchStore.updateMatch(matchId, { game_state: gs });
}

async function scheduleOpeningChatSequence(matchId, locale) {
  if (openingPlaybackLocks.has(matchId)) return;
  openingPlaybackLocks.add(matchId);
  let timeoutId = null;
  try {
    const m0 = await matchStore.getMatch(matchId);
    const gs0 = m0?.game_state || {};
    if (gs0.opening_sequence_completed || gs0.opening_sequence_aborted) return;
    if (!gs0.opening_sequence_started || gs0.captain_phase !== 'opening_chat') {
      await failOpenOpeningChat(matchId, new Error('opening_state_not_primed'));
      return;
    }

    try {
      console.log('[bot][opening_chat] sequence started matchId=' + matchId);
    } catch (e0) {}
    const list = buildOpeningCrewChannelEvents(locale);
    timeoutId = setTimeout(() => {
      failOpenOpeningChat(matchId, new Error('opening_chat_timeout')).catch(() => {});
    }, 28500);

    try {
      for (let i = 0; i < list.length; i++) {
        const ev = list[i];
        await delayOpeningMs(ev.delayMs);
        const mid = await matchStore.getMatch(matchId);
        const g = mid?.game_state || {};
        if (g.opening_sequence_completed || g.captain_phase !== 'opening_chat') break;
        await appendOpeningScriptCrewDialogueEvent(matchId, ev.role, ev.dialogue);
        try {
          console.log(
            '[bot][opening_chat] event appended idx=' + i + ' role=' + ev.role + ' matchId=' + matchId
          );
        } catch (eLog) {}
      }
      await delayOpeningMs(2000);
      const mid2 = await matchStore.getMatch(matchId);
      const g2 = mid2?.game_state || {};
      if (!g2.opening_sequence_completed && g2.captain_phase === 'opening_chat') {
        await finishOpeningChatSuccess(matchId);
      }
    } catch (e) {
      await failOpenOpeningChat(matchId, e);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  } finally {
    openingPlaybackLocks.delete(matchId);
  }
}

async function kickOpeningChatForNewMatch(matchId, locale) {
  try {
    await persistOpeningChatStateBeforePlayback(matchId);
  } catch (e) {
    await failOpenOpeningChat(matchId, e);
    return;
  }
  try {
    console.log('[bot][opening_chat] primed matchId=' + matchId);
  } catch (e0) {}
  try {
    setImmediate(() => {
      scheduleOpeningChatSequence(matchId, locale).catch((e) => {
        failOpenOpeningChat(matchId, e).catch(() => {});
      });
    });
  } catch (e) {
    failOpenOpeningChat(matchId, e).catch(() => {});
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
  const locale = opts.locale === 'en' ? 'en' : 'ko';
  try {
    console.log('[bot][start] locale resolved=' + locale);
  } catch (e) {}

  if (opts.restart) {
    const playerRestart = await playerStore.getPlayer(playerId);
    if (playerRestart?.match_id) {
      const oldMid = playerRestart.match_id;
      try {
        console.log('[bot][restart] waiting previous timeout persist match_id=' + oldMid);
      } catch (e) {}
      await applyMatchClockTick(oldMid);
      const mRestart = await matchStore.getMatch(oldMid);
      if (mRestart?.game_state?.game_over) {
        await ensureGameOverPersistedToDb(oldMid, mRestart);
      }
      try {
        console.log('[bot][restart] previous timed-out match persisted before fresh start');
      } catch (e) {}
      await playerStore.setPlayer(playerId, {
        match_id: null,
        role: playerRestart.role || 'captain',
        joined_at: playerRestart.joined_at || new Date().toISOString()
      });
    }
  }
  let player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;

  let needNewMatch = !matchId;
  let existingMatchPre = null;
  if (matchId) {
    existingMatchPre = await matchStore.getMatch(matchId);
    try {
      console.log('[bot][start] existing match detected id=' + matchId + ' found=' + !!existingMatchPre);
    } catch (e) {}
    if (!existingMatchPre) needNewMatch = true;
    if (existingMatchPre?.game_state?.game_over) needNewMatch = true;
  }
  const oldMatchIdApi = matchId;
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
    try {
      if (oldMatchIdApi && oldMatchIdApi !== matchId) {
        console.log(
          '[bot][start] stale/game_over match replaced with fresh match id=' + matchId + ' old=' + oldMatchIdApi
        );
      }
      console.log(
        '[bot][start] player current match reassigned old=' + (oldMatchIdApi || 'null') + ' new=' + matchId
      );
    } catch (e) {}
  }
  if (needNewMatch) {
    await kickOpeningChatForNewMatch(matchId, locale);
  }
  const match = await matchStore.getMatch(matchId);
  const nowStart = opts.now instanceof Date ? opts.now : opts.now != null ? new Date(opts.now) : new Date();
  const tensionStart = await persistTimerTensionForMatch(matchId, match, locale, nowStart);
  const matchForStart = tensionStart.match || match;
  const timer = ep1Engine.getTimerStatus ? ep1Engine.getTimerStatus(matchForStart, nowStart) : { remaining_sec: 420 };
  const gs = matchForStart?.game_state || {};
  let displayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(matchForStart?.events || [], { locale }), locale);
  displayLogs = ensureInitialSystemDisplayLogs(displayLogs, matchForStart, locale);
  const out = {
    ok: true,
    match_id: matchId,
    remaining_sec: timer.remaining_sec ?? 420,
    game_state: gs,
    deadline_at: matchForStart?.deadline_at,
    events: displayLogs
  };
  if (gs.game_over) {
    attachActualImposterIfGameOverResult(out, matchForStart);
    const evs = matchForStart?.events || [];
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
    await kickOpeningChatForNewMatch(matchId, locale);
  }
  let match = await matchStore.getMatch(matchId);
  if (!match) return { ok: false, error: 'Match not found' };

  const tensionNow =
    opts.now instanceof Date ? opts.now : opts.now != null ? new Date(opts.now) : new Date();
  const tension = await persistTimerTensionForMatch(matchId, match, locale, tensionNow);
  match = tension.match || match;

  const now = opts.now;
  await maybeRecoverStuckOpeningChat(matchId);
  match = (await matchStore.getMatch(matchId)) || match;
  if (isOpeningChatLocked(match.game_state)) {
    const timerOg = ep1Engine.getTimerStatus(match, now);
    const remOg = Math.max(0, Math.floor(timerOg.remaining_sec ?? 0));
    const gsOg = match.game_state || {};
    const throttledOg = shouldThrottleOpeningNotice(playerId, matchId);
    const noticeOg =
      locale === 'en'
        ? '[SYSTEM] Command channel opens after crew status check completes.'
        : '[시스템] 승무원 상태 확인이 끝난 뒤 지휘 채널이 열립니다.';
    if (throttledOg) {
      return {
        ok: true,
        summary: '',
        remaining_sec: remOg,
        game_over: false,
        outcome: null,
        events: [],
        recent_events: [],
        match_state: { ...gsOg },
        free_input_intent_meta: { message_kind: 'opening_chat_blocked', consumes_free_prompt: false }
      };
    }
    const rawOg = [{ type: 'CREW_DIALOGUE', role: 'system', dialogue: noticeOg }];
    let dispOg = dedupeDisplayLogs(toPlayerDisplayLogs(rawOg, { locale }), locale);
    dispOg = mergePrependedTensionDisplayLogs(tension, dispOg, locale);
    const sumOg = summaryFromDisplayLogs(dispOg, locale);
    return {
      ok: true,
      summary: sumOg,
      remaining_sec: remOg,
      game_over: false,
      outcome: null,
      events: dispOg,
      recent_events: dispOg,
      match_state: { ...gsOg },
      free_input_intent_meta: { message_kind: 'opening_chat_blocked', consumes_free_prompt: false }
    };
  }

  const resolvedApi = await resolveMiniappFreeClassification(text, locale);
  let cls = resolvedApi.cls;
  let parsed = resolvedApi.parsed;
  const routedFollowApi = applyRolelessDialogueFollowupRouting(text, locale, cls, parsed, match);
  cls = routedFollowApi.cls;
  parsed = routedFollowApi.parsed;
  const freeInputIntentMeta = buildFreeInputIntentMetaSnapshot(cls, parsed, text, resolvedApi.route);
  const withMeta = (o) => (o && typeof o === 'object' ? { ...o, free_input_intent_meta: freeInputIntentMeta } : o);

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
    let newDisplayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(rawEvents, { locale }), locale);
    newDisplayLogs = mergePrependedTensionDisplayLogs(tension, newDisplayLogs, locale);
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
    return withMeta(ret);
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
    return withMeta(ret);
  }

  if (cls.kind === 'free_input_clarification') {
    const line =
      cls.clarificationText || defaultFreeInputClarificationLine(locale);
    const rawEv = { type: 'CREW_DIALOGUE', role: 'system', dialogue: line };
    try {
      await matchStore.appendEvent(matchId, rawEv);
      console.log('[bot][free_input_clarification] appended event match_id=' + String(matchId));
    } catch (e) {
      try {
        console.warn('[bot][free_input_clarification] appendEvent warn ' + String(e?.message || e));
      } catch (e2) {}
    }
    const matchAfterCl = await matchStore.getMatch(matchId);
    let mergedDisplay = dedupeDisplayLogs(
      toPlayerDisplayLogs(matchAfterCl?.events || [], { locale }),
      locale
    );
    mergedDisplay = mergePrependedTensionDisplayLogs(tension, mergedDisplay, locale);
    mergedDisplay = compactClarificationDisplayLogs(mergedDisplay, locale);
    try {
      console.log(
        '[bot][free_input_clarification] merged events len=' +
          String((matchAfterCl?.events || []).length) +
          ' display len=' +
          String(mergedDisplay.length)
      );
    } catch (e) {}
    const timerCl = ep1Engine.getTimerStatus(matchAfterCl || match, now);
    const remCl = Math.max(0, Math.floor(timerCl.remaining_sec ?? 0));
    const summaryText = summaryFromDisplayLogs(mergedDisplay, locale);
    return withMeta({
      ok: true,
      summary: summaryText,
      remaining_sec: remCl,
      game_over: false,
      outcome: null,
      events: mergedDisplay,
      recent_events: mergedDisplay,
      match_state: { ...(matchAfterCl?.game_state || match.game_state) }
    });
  }

  const consumesFreePromptApi = shouldConsumeFreePromptForMessageKind(cls, parsed, text);
  logIntentPromptDecision(cls, parsed, consumesFreePromptApi);
  let freePromptConsumedThisApi = false;
  let loreFreePromptUsedAfterConsume = null;
  if (consumesFreePromptApi) {
    const userKey = resolveUserKey(playerId, matchId);
    const pr = await consumeFreePromptIfAllowed(userKey, { locale });
    if (!pr.allowed) {
      const limB = pr.entitlement ? getEntitlementLimits(pr.entitlement).daily_free_prompt_limit : '?';
      const uB = pr.entitlement != null ? pr.entitlement.daily_free_prompt_used ?? '?' : '?';
      try {
        console.log('[bot][message] lore request blocked before response used=' + uB + ' limit=' + limB);
        console.log('[bot][entitlement] prompt final decision block');
      } catch (e) {}
      const timer = ep1Engine.getTimerStatus(match, now);
      const rem = Math.max(0, Math.floor(timer.remaining_sec ?? 0));
      const evBlock = mergePrependedTensionDisplayLogs(tension, [], locale);
      return withMeta(
        buildEntitlementBlockedResponse(locale, 'daily_free_prompt_limit_reached', pr.entitlement, {
          remaining_sec: rem,
          game_over: false,
          outcome: null,
          events: evBlock,
          recent_events: evBlock,
          match_state: { ...match.game_state }
        })
      );
    }
    freePromptConsumedThisApi = true;
    loreFreePromptUsedAfterConsume = pr.entitlement != null ? pr.entitlement.daily_free_prompt_used : null;
    try {
      console.log('[bot][entitlement] prompt final decision allow');
    } catch (e) {}
  }

  if (cls.kind === 'role_opinion_question') {
    console.log('[bot] message kind=role_opinion_question target=' + parsed.target);
    await clearPostOpeningWaitingForFirstCommanderInput(matchId);
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
    newDisplayLogs = mergePrependedTensionDisplayLogs(tension, newDisplayLogs, locale);
    const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
    return withMeta({
      ok: true,
      summary: summaryText,
      remaining_sec: rem,
      game_over: false,
      outcome: null,
      events: newDisplayLogs,
      recent_events: newDisplayLogs,
      match_state: updated?.game_state || {}
    });
  }

  if (cls.kind === 'group_question') {
    const sub = cls.groupSubkind || 'suspicion';
    console.log('[bot] message kind=group_question sub=' + sub);
    await clearPostOpeningWaitingForFirstCommanderInput(matchId);
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
    newDisplayLogs = mergePrependedTensionDisplayLogs(tension, newDisplayLogs, locale);
    if (sub === 'name') {
      newDisplayLogs = sanitizeNameQuestionDisplayLogs(newDisplayLogs, locale);
    }
    const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
    return withMeta({
      ok: true,
      summary: summaryText,
      remaining_sec: rem,
      game_over: false,
      outcome: null,
      events: newDisplayLogs,
      recent_events: newDisplayLogs,
      match_state: updated?.game_state || {}
    });
  }

  if (cls.kind === 'suspicion_question') {
    console.log('[bot] message kind=suspicion_question');
    await clearPostOpeningWaitingForFirstCommanderInput(matchId);
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
    newDisplayLogs = mergePrependedTensionDisplayLogs(tension, newDisplayLogs, locale);
    const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
    return withMeta({
      ok: true,
      summary: summaryText,
      remaining_sec: rem,
      game_over: false,
      outcome: null,
      events: newDisplayLogs,
      recent_events: newDisplayLogs,
      match_state: updated?.game_state || {}
    });
  }

  if (cls.kind === 'lore_question') {
    await clearPostOpeningWaitingForFirstCommanderInput(matchId);
    try {
      const tq = String(text || '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, ' ')
        .slice(0, 220);
      console.log('[bot][message] classified kind=lore_question text="' + tq + '"');
    } catch (e) {}
    console.log('[bot] message kind=lore_question');
    try {
      console.log('[bot][route] lore pipeline selected');
    } catch (e) {}

    try {
      const gateApi = evaluateLoreUnknownTermGate('lore_question', String(text || ''), locale);
      if (gateApi.block) {
        await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
        const lineUnk = buildUnknownLoreTermSystemLine(locale, gateApi.term);
        const rawEvUnk = [{ type: 'CREW_DIALOGUE', role: 'system', dialogue: lineUnk }];
        const newDisplayLogsUnkBase = dedupeDisplayLogs(toPlayerDisplayLogs(rawEvUnk, { locale }), locale);
        const toStoreUnk = displayLogsToCrewDialogueEvents(newDisplayLogsUnkBase, locale);
        for (const ev of toStoreUnk) await matchStore.appendEvent(matchId, ev);
        const newDisplayLogsUnk = mergePrependedTensionDisplayLogs(tension, newDisplayLogsUnkBase, locale);
        const updatedUnk = await matchStore.getMatch(matchId);
        const timerUnk = ep1Engine.getTimerStatus(updatedUnk, now);
        const remUnk = Math.max(0, Math.floor(timerUnk.remaining_sec ?? 0));
        const summaryTextUnk = summaryFromDisplayLogs(newDisplayLogsUnk, locale);
        try {
          console.log(
            '[bot][message] lore response emitted blocked=false ok=true used=' +
              String(loreFreePromptUsedAfterConsume ?? '?')
          );
        } catch (e) {}
        return attachFreePromptConsumedMetadata(
          withMeta({
            ok: true,
            summary: summaryTextUnk,
            remaining_sec: remUnk,
            game_over: false,
            outcome: null,
            events: newDisplayLogsUnk,
            recent_events: newDisplayLogsUnk,
            match_state: updatedUnk?.game_state || {}
          }),
          freePromptConsumedThisApi
        );
      }
      await matchStore.updateMatch(matchId, { turn: (match.turn || 1) + 1 });
      const newDisplayLogsLoreBase = buildLoreQuestionSystemOnlyDisplayLogs(locale, text);
      const toStore = displayLogsToCrewDialogueEvents(newDisplayLogsLoreBase, locale);
      for (const ev of toStore) await matchStore.appendEvent(matchId, ev);
      const newDisplayLogs = mergePrependedTensionDisplayLogs(tension, newDisplayLogsLoreBase, locale);
      const updated = await matchStore.getMatch(matchId);
      const timer = ep1Engine.getTimerStatus(updated, now);
      const rem = Math.max(0, Math.floor(timer.remaining_sec ?? 0));
      const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
      try {
        console.log(
          '[bot][message] lore response emitted blocked=false ok=true used=' +
            String(loreFreePromptUsedAfterConsume ?? '?')
        );
      } catch (e) {}
      return attachFreePromptConsumedMetadata(
        withMeta({
          ok: true,
          summary: summaryText,
          remaining_sec: rem,
          game_over: false,
          outcome: null,
          events: newDisplayLogs,
          recent_events: newDisplayLogs,
          match_state: updated?.game_state || {}
        }),
        freePromptConsumedThisApi
      );
    } catch (err) {
      try {
        console.log('[bot][error] lore pipeline failed err=' + String(err?.message || err));
      } catch (e2) {}
      const mFb = await matchStore.getMatch(matchId);
      const timerFb = ep1Engine.getTimerStatus(mFb, now);
      const remFb = Math.max(0, Math.floor(timerFb.remaining_sec ?? 0));
      const fbSum =
        locale === 'en'
          ? '[System] The lore archive line could not be generated.'
          : '[시스템] 로어 기록 응답을 생성하지 못했습니다.';
      try {
        console.log(
          '[bot][message] lore response emitted blocked=false ok=true used=' +
            String(loreFreePromptUsedAfterConsume ?? '?')
        );
      } catch (e3) {}
      return attachFreePromptConsumedMetadata(
        withMeta({
          ok: true,
          blocked: false,
          summary: fbSum,
          remaining_sec: remFb,
          game_over: false,
          outcome: null,
          events: mergePrependedTensionDisplayLogs(tension, [], locale),
          recent_events: mergePrependedTensionDisplayLogs(tension, [], locale),
          match_state: mFb?.game_state || {},
          lore_pipeline_error_fallback: true
        }),
        freePromptConsumedThisApi
      );
    }
  }

  if (cls.kind === 'brief_question') {
    console.log('[bot] message kind=brief_question');
    console.log('[bot] brief_question deterministic=true');
    try {
      console.log('[bot][route] crew pipeline selected');
    } catch (e) {}
    await clearPostOpeningWaitingForFirstCommanderInput(matchId);
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
    newDisplayLogs = mergePrependedTensionDisplayLogs(tension, newDisplayLogs, locale);
    const summaryText = summaryFromDisplayLogs(newDisplayLogs, locale);
    return withMeta({
      ok: true,
      summary: summaryText,
      remaining_sec: rem,
      game_over: false,
      outcome: null,
      events: newDisplayLogs,
      recent_events: newDisplayLogs,
      match_state: updated?.game_state || {}
    });
  }

  if (cls.kind === 'targeted_question') {
    console.log('[bot] message kind=targeted_question target=' + parsed.target);
  }

  const captainBodyForTq =
    cls.kind === 'targeted_question'
      ? stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) ||
        String(text || '').trim()
      : '';

  const mappedThreatIntentApi = (() => {
    const it = String(parsed.intent_type || '').toLowerCase();
    return it === 'threaten' || it === 'threat';
  })();
  if (mappedThreatIntentApi) {
    try {
      console.log('[bot][intent] message kind=mapped:threaten');
    } catch (e) {}
  }

  const action = { actor: 'captain', role: 'captain', action: parsed.intent_type, target: parsed.target };
  const result = await ep1Engine.applyAction(match, action, opts);
  if (!result.ok) return withMeta({ ok: false, error: result.error || 'unknown' });

  await matchStore.updateMatch(matchId, { ...result.next_state, turn: (match.turn || 1) + 1 });
  await clearPostOpeningWaitingForFirstCommanderInput(matchId);
  let eventsForStoreApi = result.events || [];
  if (cls.kind === 'targeted_question' && parsed.target) {
    eventsForStoreApi = filterQuestionEventsForTargetedSingleSpeaker(eventsForStoreApi, parsed.target);
    try {
      console.log('[bot][intent] targeted question isolated targetRole=' + String(parsed.target).toLowerCase());
    } catch (e) {}
  }
  if (eventsForStoreApi.length > 0) {
    for (const ev of eventsForStoreApi) await matchStore.appendEvent(matchId, ev);
  }

  const updated = await matchStore.getMatch(matchId);
  const gameOver = result.game_over || updated?.game_state?.game_over;
  const isCheckLogMsg = String(parsed.intent_type || '').toLowerCase() === 'check_log';
  const deterministicLogs = dedupeDisplayLogs(
    toPlayerDisplayLogs(eventsForStoreApi, {
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
      rawEvents: eventsForStoreApi,
      deterministicLogs,
      match: updated,
      playerText: String(text || '').trim(),
      clueTextFromEvent,
      locale,
      forcedCaptainTextOverride:
        cls.kind === 'targeted_question' && captainBodyForTq ? captainBodyForTq : undefined,
      targetedQuestionSideReactionRules: false,
      targetedNameQuestion: targetedNameQ,
      targetedQuestionSingleSpeaker: cls.kind === 'targeted_question',
      isSelfDefenseQuestion: !!cls.isSelfDefenseQuestion,
      isTargetedAccusation: !!(cls.isTargetedAccusation || parsed.isTargetedAccusation)
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
  newDisplayLogs = mergePrependedTensionDisplayLogs(tension, newDisplayLogs, locale);
  try {
    const ev0p = eventsForStoreApi && eventsForStoreApi[0];
    const dkP = getDialogueLlmKind(eventsForStoreApi);
    const tgtP = ev0p?.target ? String(ev0p.target).toLowerCase() : null;
    if (tgtP && (dkP === 'QUESTION' || dkP === 'THREATEN')) {
      const capPersist =
        cls.kind === 'targeted_question' && captainBodyForTq
          ? captainBodyForTq
          : stripLeadingCaptainBracketFromUserLine(String(text || '').trim(), locale) || String(text || '').trim();
      const rr = extractCrewDialogueBodyFromDisplayLogs(newDisplayLogs, tgtP, locale);
      await persistDialogueFocusMemory(matchId, {
        targetRole: tgtP,
        dialogueKind: dkP,
        captainText: capPersist,
        roleReply: rr
      });
    }
  } catch (e) {}
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
  return withMeta(ret);
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
  let match = await matchStore.getMatch(matchId);
  if (!match) return { ok: false, error: 'Match not found' };

  const tensionNowAcc =
    opts.now instanceof Date ? opts.now : opts.now != null ? new Date(opts.now) : new Date();
  const tensionAcc = await persistTimerTensionForMatch(matchId, match, locale, tensionNowAcc);
  match = tensionAcc.match || match;

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
  await clearPostOpeningWaitingForFirstCommanderInput(matchId);
  if (result.events?.length > 0) {
    for (const ev of result.events) await matchStore.appendEvent(matchId, ev);
  }

  const updated = await matchStore.getMatch(matchId);
  const gameOver = result.game_over || updated?.game_state?.game_over;
  let newDisplayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(result.events || [], { locale }), locale);
  newDisplayLogs = mergePrependedTensionDisplayLogs(tensionAcc, newDisplayLogs, locale);
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
 * @param {string} actionRaw - ep1Engine.intentToAction after alias resolve: question, pistol, threat, clue, execute→accuse, cctv|engine→check_log, …
 * @param {string} [targetRaw] - optional
 * @param {object} [opts] - { now? }
 * @returns {Promise<object>}
 */
async function processActionApi(playerId, actionRaw, targetRaw, opts = {}) {
  const locale = opts.locale === 'en' ? 'en' : 'ko';
  const rawKey = String(actionRaw || '').toLowerCase().trim();
  const resolvedActionKey =
    rawKey === 'execute'
      ? 'accuse'
      : rawKey === 'cctv'
        ? 'check_log'
        : rawKey === 'engine'
          ? 'check_log'
          : rawKey === 'clue'
            ? 'find_clue'
            : rawKey;

  const targetNorm =
    targetRaw != null && String(targetRaw).trim() !== '' ? String(targetRaw).toLowerCase().trim() : null;

  const mapped = ep1Engine.intentToAction(resolvedActionKey, targetNorm);

  if (mapped.action === 'THREATEN') {
    const t = targetNorm || '';
    if (!ACCUSE_API_TARGETS.has(t)) {
      return { ok: false, error: 'target required (doctor|engineer|navigator|pilot)' };
    }
    try {
      console.log('[bot][intent] message kind=mapped:threaten');
    } catch (e) {}
  }

  const action = {
    actor: 'captain',
    role: 'captain',
    action: mapped.action,
    target: mapped.target
  };

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
  let match = await matchStore.getMatch(matchId);
  if (!match) return { ok: false, error: 'Match not found' };

  await clearPostOpeningWaitingForFirstCommanderInput(matchId);
  match = await matchStore.getMatch(matchId);
  if (!match) return { ok: false, error: 'Match not found' };

  const tensionNowAct =
    opts.now instanceof Date ? opts.now : opts.now != null ? new Date(opts.now) : new Date();
  const tensionAct = await persistTimerTensionForMatch(matchId, match, locale, tensionNowAct);
  match = tensionAct.match || match;

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

  const result = await ep1Engine.applyAction(match, action, opts);
  if (!result.ok) return { ok: false, error: result.error || 'unknown' };

  await matchStore.updateMatch(matchId, { ...result.next_state, turn: (match.turn || 1) + 1 });
  if (result.events?.length > 0) {
    for (const ev of result.events) await matchStore.appendEvent(matchId, ev);
  }

  const updated = await matchStore.getMatch(matchId);
  const gameOver = result.game_over || updated?.game_state?.game_over;
  const actU = String(mapped.action || '').toUpperCase();
  let checkLogCaptainInputLine;
  if (actU === 'CHECK_LOG' && rawKey === 'cctv') {
    checkLogCaptainInputLine = locale === 'en' ? 'Checking CCTV logs' : 'CCTV 로그를 확인한다';
  } else if (actU === 'CHECK_LOG' && rawKey === 'engine') {
    checkLogCaptainInputLine = locale === 'en' ? 'Checking the engine room' : '엔진실을 확인한다';
  }
  const deterministicLogs = dedupeDisplayLogs(
    toPlayerDisplayLogs(result.events || [], {
      locale,
      ...(checkLogCaptainInputLine != null ? { captainInputLine: checkLogCaptainInputLine } : {})
    }),
    locale
  );
  const clueEv = (result.events || []).find((e) => e && String(e.type).toUpperCase() === 'FIND_CLUE');
  const clueTextFromEvent = clueEv && clueEv.clue_text ? String(clueEv.clue_text) : undefined;
  const actionHint =
    actU === 'THREATEN'
      ? locale === 'en'
        ? `[threaten action] target=${String(targetRaw || '').toLowerCase()}`
        : `[위협 action] target=${String(targetRaw || '').toLowerCase()}`
      : actU === 'TAKE_PISTOL'
        ? locale === 'en'
          ? `[take_pistol action]`
          : `[권총 획득 action]`
      : actU === 'FIND_CLUE'
        ? locale === 'en'
          ? `[collect_clue action]`
          : `[단서수집 action]`
        : checkLogCaptainInputLine != null
          ? checkLogCaptainInputLine
          : locale === 'en'
            ? `[${actU.toLowerCase()} action]`
            : `[${actU.toLowerCase()} action]`;
  let newDisplayLogs;
  if (actU === 'QUESTION') {
    let qLogs = dedupeDisplayLogs(deterministicLogs, locale);
    await ensureCrewPersonalNamesPersisted(matchId);
    const mNames = await matchStore.getMatch(matchId);
    const crewPersonalNames = mNames?.game_state?.crew_names || {};
    qLogs = sanitizeActionResponseNoPersonalNames(qLogs, locale, {
      dialogueLlmKind: 'QUESTION',
      crewPersonalNames,
      threatTargetRole: null
    });
    qLogs = sanitizeActionResponseHonorificKo(qLogs, locale, {
      dialogueLlmKind: 'QUESTION',
      threatTargetRole: null
    });
    newDisplayLogs = dedupeDisplayLogs(qLogs, locale);
  } else {
    newDisplayLogs = dedupeDisplayLogs(
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
  }
  newDisplayLogs = mergePrependedTensionDisplayLogs(tensionAct, newDisplayLogs, locale);
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
  await clearPostOpeningWaitingForFirstCommanderInput(matchId);
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
      await persistMatchShutdownToDb(matchId, {
        source: 'timeout',
        outcome: String(result.outcome != null ? result.outcome : 'TIMEOUT'),
        gameOver: true
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
    if (outcome) {
      await persistMatchShutdownToDb(matchId, {
        source: 'game_over_kill',
        outcome: String(outcome),
        gameOver: true
      });
      break;
    }
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
  const lang = String(msg.from?.language_code || '').trim();
  const routeOpts = { locale: /^en/i.test(lang) ? 'en' : 'ko' };
  try {
    const reply = await routeMessage(playerId, text, routeOpts);
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
        try {
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
          await maybeRecoverStuckOpeningChat(matchId);
          match = await matchStore.getMatch(matchId);
          const pollNow = new Date();
          const tensionPoll = await persistTimerTensionForMatch(matchId, match, locale, pollNow);
          match = await matchStore.getMatch(matchId);
          const timer = ep1Engine.getTimerStatus(match, pollNow);
          const gs = match?.game_state || {};
          let displayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(match?.events || [], { locale }), locale);
          displayLogs = ensureInitialSystemDisplayLogs(displayLogs, match, locale);
          if (gs.captain_phase === 'opening_chat') {
            let visibleOpeningCount = 0;
            const evsOpen = match?.events || [];
            for (let oi = 0; oi < evsOpen.length; oi++) {
              const eo = evsOpen[oi];
              if (eo && eo.event_source === OPENING_SCRIPT_EVENT_SOURCE) visibleOpeningCount++;
            }
            try {
              console.log(
                '[bot][opening_chat] state_visible count=' + visibleOpeningCount + ' matchId=' + matchId
              );
            } catch (eVis) {}
          }
          const recentDisplay = dedupeDisplayLogs(
            toPlayerDisplayLogs([...(tensionPoll.newRawEvents || []), ...deltaRaw], { locale }),
            locale
          );
          let recentEventsPayload = recentDisplay;
          if (gs.captain_phase === 'opening_chat' && gs.opening_sequence_completed !== true) {
            const openingRaw = (match?.events || []).filter(
              (e) => e && e.event_source === OPENING_SCRIPT_EVENT_SOURCE
            );
            recentEventsPayload = dedupeDisplayLogs(toPlayerDisplayLogs(openingRaw, { locale }), locale);
          }
          const statePayload = {
            ok: true,
            match_id: matchId,
            remaining_sec: timer.remaining_sec ?? 0,
            game_state: gs,
            match_state: gs,
            events: displayLogs,
            recent_events: recentEventsPayload,
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
        } catch (err) {
          const stackLines = err && err.stack ? String(err.stack).split(/\r?\n/) : [];
          const stackFirst = stackLines.length > 1 ? stackLines[1].trim() : stackLines[0] || '';
          console.error(
            '[bot][state-error] ' +
              String(err && err.message != null ? err.message : err) +
              ' stack=' +
              stackFirst
          );
          res.writeHead(500);
          res.end(JSON.stringify({ ok: false, error: String(err && err.message != null ? err.message : err) }));
          return;
        }
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
      const lang = String(msg.from?.language_code || '').trim();
      const routeOpts = { locale: /^en/i.test(lang) ? 'en' : 'ko' };
      try {
        const reply = await routeMessage(playerId, text, routeOpts);
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
  appendMatchEvent,
  OPENING_STORY_LINES
};

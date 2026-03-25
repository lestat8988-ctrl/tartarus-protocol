/**
 * telegram/bot/bot.js - 텔레그램 봇 진입점
 * bot → parser → engine → state 저장 흐름 연결.
 * BOT TOKEN 없이도 handleTextMessage()로 로컬 테스트 가능.
 * 로컬 개발용 HTTP API (포트 8788) 지원.
 */

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

const API_PORT = 8788;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const LOG = process.env.BOT_LOG !== '0';

/** LLM dialogue (non-terminal actions only). Rules/timer/kills stay in ep1Engine. */
const TELEGRAM_DIALOGUE_MODEL = process.env.TELEGRAM_DIALOGUE_MODEL || 'gpt-4o-mini';
const TELEGRAM_DIALOGUE_TIMEOUT_MS = Math.min(
  Math.max(parseInt(process.env.TELEGRAM_DIALOGUE_TIMEOUT_MS || '10000', 10) || 10000, 4000),
  60000
);
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';

function isDeepSeekDialogueModel(model) {
  const m = String(model || '').toLowerCase().trim();
  return m === 'deepseek-chat' || m === 'deepseek-reasoner' || m.startsWith('deepseek-');
}

function isDialogueLlmConfigured() {
  const model = TELEGRAM_DIALOGUE_MODEL;
  if (isDeepSeekDialogueModel(model)) return !!process.env.DEEPSEEK_API_KEY;
  return !!process.env.OPENAI_API_KEY;
}

/**
 * non-terminal 배치만: QUESTION / SUSPECT / CHECK_LOG / THREATEN / FIND_CLUE(단서 확보)
 * 에러용 CREW_DIALOGUE 단독 배치는 null
 */
function getDialogueLlmKind(events) {
  const ev0 = events && events[0];
  if (!ev0) return null;
  const t = String(ev0.type || '').toUpperCase();
  if (t === 'QUESTION' && ev0.target) return 'QUESTION';
  if (t === 'SUSPECT' && ev0.target) return 'SUSPECT';
  if (t === 'CHECK_LOG') return 'CHECK_LOG';
  if (t === 'THREATEN' && ev0.target) return 'THREATEN';
  if (t === 'FIND_CLUE' && (ev0.clue_text || ev0.clue_id)) return 'FIND_CLUE';
  return null;
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
  if (kind === 'CHECK_LOG') {
    const order = [];
    for (const ev of rawEvents || []) {
      if (String(ev.type) !== 'CREW_DIALOGUE') continue;
      const r = String(ev.role || '').toLowerCase();
      if (!['doctor', 'engineer', 'navigator', 'pilot'].includes(r)) continue;
      if (dead.has(r)) continue;
      if (!order.includes(r)) order.push(r);
    }
    return order.length ? order : alive;
  }
  if (kind === 'FIND_CLUE') return alive;
  return alive;
}

const LLM_ROLE_HEADERS = {
  captain: '[함장]',
  doctor: '[닥터]',
  engineer: '[엔지니어]',
  navigator: '[네비게이터]',
  pilot: '[파일럿]'
};

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

/** deterministic display에서 [함장] 직후 본문 — 사용자 액션/엔진 고정 문장 유지용 */
function extractCaptainSpokenFromDisplayLogs(displayLogs) {
  const d = displayLogs || [];
  if (d.length >= 2 && String(d[0].type || '').trim() === '[함장]') {
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

/** 승무원 narration: 짧고 액션 연관만 (과장·중복 내레이션 억제) */
const MAX_CREW_NARRATION_CHARS = 72;

function crewNarrationAcceptable(sorted) {
  for (const b of sorted) {
    const role = String(b.role || '').toLowerCase();
    if (role === 'captain') continue;
    const narr = String(b.narration || '').trim();
    if (!narr) continue;
    if (narr.length > MAX_CREW_NARRATION_CHARS) return false;
    if (/^(?:그|저|음)\s*[,，]?$/i.test(narr)) return false;
  }
  return true;
}

/**
 * QUESTION/SUSPECT/THREATEN: 타깃이 아닌 승무원 발화에 타깃 역할명(한글)이 들어가야 함.
 * CHECK_LOG: 로그·기록·시스템 등 함선 조사 맥락 키워드 1개 이상.
 * FIND_CLUE: 단서/정보/로그 등 수집 맥락.
 */
function crewLinesSituationAnchored(sorted, kind, target) {
  const LOG_HINT_RES = /로그|기록|타임스탬프|접근|CCTV|버퍼|시스템|패널|동기화|항로|데이터|쿼리|센서|터미널|동기|구역/;
  const CLUE_HINT_RES = /단서|정보|기록|로그|데이터|확보|분석|패널|파일|스캔/;

  const targetKo = roleNameKo(target);

  for (const b of sorted) {
    const role = String(b.role || '').toLowerCase();
    if (role === 'captain') continue;
    const pack = combinedBlockText(b);

    if (kind === 'CHECK_LOG') {
      if (!LOG_HINT_RES.test(pack)) return false;
      continue;
    }
    if (kind === 'FIND_CLUE') {
      if (!CLUE_HINT_RES.test(pack)) return false;
      continue;
    }
    if ((kind === 'QUESTION' || kind === 'SUSPECT' || kind === 'THREATEN') && targetKo) {
      if (role === String(target || '').toLowerCase()) continue;
      if (!pack.includes(targetKo)) return false;
    }
  }
  return true;
}

/** 함장 블록은 LLM 대신 deterministic 본문으로 고정, 함장 narration 제거 */
function applyForcedCaptainToSorted(sorted, forcedCaptainText) {
  const ft = String(forcedCaptainText || '').trim();
  const rest = sorted.filter((b) => String(b.role || '').toLowerCase() !== 'captain');
  if (ft) {
    rest.unshift({
      role: 'captain',
      header: '[함장]',
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

function validateLlmDialogueBlocks(parsed, kind, expectedCrew, opts) {
  opts = opts || {};
  const forcedCaptainText = String(opts.forcedCaptainText || '').trim();
  const target = opts.target != null ? String(opts.target).toLowerCase() : null;

  if (!parsed || typeof parsed !== 'object') return null;
  const blocks = parsed.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  let sorted = sortLlmBlocksByExpected(blocks, expectedCrew);
  sorted = applyForcedCaptainToSorted(sorted, forcedCaptainText);

  const cap = sorted.find((b) => String(b.role || '').toLowerCase() === 'captain');
  if (!cap || !String(cap.text || '').trim()) return null;
  if (String(cap.narration || '').trim()) return null;

  for (const r of expectedCrew) {
    const b = sorted.find((x) => String(x.role || '').toLowerCase() === r);
    if (!b || !String(b.text || '').trim()) return null;
  }
  const allowed = new Set(['captain', ...expectedCrew]);
  for (const b of sorted) {
    const r = String(b.role || '').toLowerCase();
    if (!allowed.has(r)) return null;
  }

  if (hasBannedCrewOrCaptainPatterns(sorted)) return null;
  if (!crewNarrationAcceptable(sorted)) return null;
  if (!crewLinesSituationAnchored(sorted, kind, target)) return null;

  const allTexts = [];
  for (const b of sorted) {
    allTexts.push(String(b.text || ''));
    if (b.narration) allTexts.push(String(b.narration));
  }
  if (!koreanHeavyEnoughForDialogue(allTexts, 0.38)) return null;
  if (hasExcessiveLineRepetition(sorted, 2)) return null;
  return sorted;
}

function llmBlocksToDisplayLogs(sortedBlocks, batchKey) {
  const out = [];
  let i = 0;
  for (const b of sortedBlocks) {
    const role = String(b.role || '').toLowerCase();
    const header = String(b.header || LLM_ROLE_HEADERS[role] || '').trim() || LLM_ROLE_HEADERS[role];
    const text = String(b.text || '').trim();
    const narr = b.narration != null ? String(b.narration).trim() : '';
    const keyBase = `${batchKey}|${i++}`;
    if (header) out.push({ type: header, role: 'system', target: null, _key: `${keyBase}|h` });
    if (text) out.push({ type: text, role: 'system', target: null, _key: `${keyBase}|t` });
    if (narr) out.push({ type: narr, role: 'system', target: null, _key: `${keyBase}|n` });
  }
  return out;
}

/** FIND_CLUE: 단서 본문은 엔진 값만 사용 (LLM이 사실 조작 불가) */
function mergeFindClueDeterministicClue(displayLogs, clueText, batchKey) {
  const clue = String(clueText || '').trim();
  if (!clue) return displayLogs;
  const filtered = (displayLogs || []).filter((item) => item.type !== '[시스템]');
  const k = `${batchKey}|engine-clue`;
  return [
    ...filtered,
    { type: '[시스템]', role: 'system', target: null, _key: `${k}|h` },
    { type: clue, role: 'system', target: null, _key: `${k}|b` }
  ];
}

function buildDialogueSystemPrompt() {
  return [
    'You write Korean in-universe dialogue for USSC Tartarus (Episode 1), 베르셀 성공본 톤: 구체적·함선 내 상황에 박힌 대사만.',
    'You NEVER decide rules, outcomes, deaths, clue facts, timers, or impostor identity.',
    'Output: one JSON object with key "blocks" (array) only. No markdown.',
    'Block shape: { "role", "header", "text", "narration?" }. Headers exactly: [함장] [닥터] [엔지니어] [네비게이터] [파일럿].',
    '',
    'HARD RULES:',
    '- Every line must tie to the current action and (if given) focusTargetRole. No generic life advice, sermons, morals, or abstract warnings.',
    '- FORBIDDEN vibes/phrases (non-exhaustive): "모두 진정", "신중해야", "침착하게", "우리는 함께", "서로 믿", "훈계", "교훈", empty reassurance.',
    '- No vague "teamwork" talk. Replace with concrete ship facts: logs, timestamps, zones, biometrics, routes, cockpit readings.',
    '',
    'ROLE LOCKS (spoken "text" must follow):',
    '- doctor: biometrics, stress, vitals, psychological tells, medical observation of crew.',
    '- engineer: logs, access records, system glitches, CCTV buffers, sync anomalies.',
    '- navigator: routes, timestamps, alibi holes, bridge/helm position challenges.',
    '- pilot: atmosphere in cockpit/bridge, gut feel, subtle environmental wrongness.',
    '- captain: copy captainSpokenLineVerbatim from user JSON EXACTLY into captain.text; captain.narration MUST be empty string "" always.',
    '',
    'CREW narration:',
    '- At most ONE short third-person line per crew block; omit narration if unnecessary.',
    '- narration must describe a concrete physical/technical action tied to that line (max ~35 Korean syllables worth).',
    '- No duplicate stock narration across crew. No "…삼켰다" chains for everyone.',
    '',
    'TARGET FOCUS:',
    '- QUESTION / SUSPECT / THREATEN: every non-target crew block must explicitly name the focus target in Korean (e.g. 네비게이터) in text or narration.',
    '- Target crew\'s own block may use first-person defense; still about the accusation/question.',
    '- CHECK_LOG: all crew lines must reference logs, records, CCTV, timestamps, or ship systems — no off-topic small talk.',
    '- FIND_CLUE: reactions to gathering intel; do not invent the clue text (server injects [시스템]).',
    '',
    'Respond with JSON only.'
  ].join('\n');
}

function buildDialogueUserPayload(ctx) {
  return JSON.stringify(
    {
      action: ctx.kind,
      focusTargetRole: ctx.target || null,
      focusTargetKorean: ctx.targetKo || null,
      crewSpeakingOrder: ctx.expectedCrew,
      deadRoles: ctx.deadRoles || [],
      captainPlayerInput: ctx.playerText || '',
      captainSpokenLineVerbatim: ctx.captainSpokenLineVerbatim || null,
      clueTextToQuoteVerbatim: ctx.clueText || null,
      instructionCaptain:
        ctx.captainSpokenLineVerbatim
          ? 'Set captain.text EXACTLY equal to captainSpokenLineVerbatim (character-for-character). Set captain.narration to "".'
          : 'Captain.text short and decisive; captain.narration must be "".',
      note:
        ctx.clueText != null
          ? 'FIND_CLUE: never put the real clue sentence in JSON; server appends [시스템] clue. Only crew reactions to collecting intel.'
          : undefined
    },
    null,
    0
  );
}

async function callChatCompletionsJson({ system, user }) {
  const { OpenAI } = require('openai');
  const model = TELEGRAM_DIALOGUE_MODEL;
  const useDeepSeek = isDeepSeekDialogueModel(model);
  const apiKey = useDeepSeek ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('no_api_key');

  const client = new OpenAI({
    apiKey,
    baseURL: useDeepSeek ? DEEPSEEK_BASE_URL : undefined,
    timeout: TELEGRAM_DIALOGUE_TIMEOUT_MS,
    maxRetries: 0
  });

  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.42,
    max_tokens: 2500
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
  const { kind, rawEvents, match, playerText, clueText, forcedCaptainText } = ctx;
  const gs = match?.game_state || {};
  const deadRoles = gs.dead_roles || [];
  const ev0 = rawEvents && rawEvents[0];
  const target = ev0?.target ? String(ev0.target).toLowerCase() : null;
  const expectedCrew = expectedCrewOrderForLlm(kind, target, deadRoles, rawEvents);
  const batchKey = `llm|${kind}|${Date.now()}`;
  const captainForced = String(forcedCaptainText || '').trim();

  const system = buildDialogueSystemPrompt();
  const userBase = buildDialogueUserPayload({
    kind,
    target,
    targetKo: roleNameKo(target),
    expectedCrew,
    deadRoles,
    playerText: playerText || '',
    clueText: kind === 'FIND_CLUE' ? clueText : null,
    captainSpokenLineVerbatim: captainForced || null
  });
  const strictRetry =
    '\n\n[STRICT_RETRY] 검증 실패. 금지: 진정/신중/침착/함께/훈계/교훈/공허한 조언. QUESTION·SUSPECT·THREATEN에서는 focusTargetKorean을 타깃이 아닌 모든 승무원 블록에 반드시 포함. CHECK_LOG는 매 승무원 블록에 로그·기록·CCTV·타임스탬프·접근·시스템 중 하나. narration은 짧게, 같은 패턴 반복 금지.';

  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = userBase + (attempt ? strictRetry : '');
    let raw;
    try {
      raw = await callChatCompletionsJson({ system, user });
    } catch (err) {
      log('LLM_DIALOGUE', 'call_failed', { kind, attempt, err: String(err && err.message) });
      return null;
    }
    lastRaw = raw;
    const parsed = extractJsonObjectFromLlmText(raw);
    const valid = validateLlmDialogueBlocks(parsed, kind, expectedCrew, {
      forcedCaptainText: captainForced,
      target
    });
    if (valid) {
      let logs = llmBlocksToDisplayLogs(valid, batchKey);
      if (kind === 'FIND_CLUE' && clueText) {
        logs = mergeFindClueDeterministicClue(logs, clueText, batchKey);
      }
      return logs.length ? logs : null;
    }
    log('LLM_DIALOGUE', 'validate_failed', { kind, attempt });
  }
  log('LLM_DIALOGUE', 'aborted_after_retry', { kind, rawHead: String(lastRaw).slice(0, 120) });
  return null;
}

async function maybeDialogueLogsFromLlmOrDeterministic({
  rawEvents,
  deterministicLogs,
  match,
  playerText,
  clueTextFromEvent
}) {
  const kind = getDialogueLlmKind(rawEvents);
  if (!kind) return deterministicLogs;
  const forcedCaptainText = extractCaptainSpokenFromDisplayLogs(deterministicLogs);
  const llmLogs = await tryGenerateLlmDialogueLogs({
    kind,
    rawEvents,
    match,
    playerText: playerText || '',
    clueText: clueTextFromEvent != null ? clueTextFromEvent : undefined,
    forcedCaptainText
  });
  if (llmLogs && llmLogs.length) return llmLogs;
  return deterministicLogs;
}

function log(tag, msg, data) {
  if (LOG) console.log('[bot]', tag, msg, data != null ? JSON.stringify(data) : '');
}

const ROLE_NAMES_KO = { doctor: '닥터', engineer: '엔지니어', navigator: '네비게이터', pilot: '파일럿', captain: '함장' };
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
 * @returns {object[]} { type: string, role?, target?: null, _key?: string } - 표시용
 */
function toPlayerDisplayLogs(rawEvents, opts = {}) {
  if (!rawEvents || !Array.isArray(rawEvents)) return [];
  const captainInputLine = String(opts.captainInputLine || '').trim();
  const out = [];

  for (const ev of rawEvents) {
    const t = String(ev?.type || '').toUpperCase();
    const role = ev?.role || 'captain';
    const target = ev?.target ? String(ev.target).toLowerCase() : null;
    const baseKey = [ev?.ts ?? '', t, role, target ?? ''].join('|');

    if (t === 'QUESTION' && target) {
      const qBody = `${roleNameKo(target)}, 그때 어디 있었지?`;
      const body = (qBody || ev.dialogue || ev.text || '함장이 질문했다.').trim();
      if (body) {
        out.push({ type: '[함장]', role: 'system', target: null, _key: baseKey + '|hdr' });
        out.push({ type: body, role: 'system', target: null, _key: baseKey + '|body' });
      }
      continue;
    }
    if (t === 'SUSPECT' && target) {
      const sBody = `${roleWithObjectParticle(target)} 의심한다`;
      const body = (sBody || ev.dialogue || ev.text || `${roleNameKo(target)}를 의심한다`).trim();
      if (body) {
        out.push({ type: '[함장]', role: 'system', target: null, _key: baseKey + '|hdr' });
        out.push({ type: body, role: 'system', target: null, _key: baseKey + '|body' });
      }
      continue;
    }
    if (t === 'CHECK_LOG') {
      const fromUser = (ev.dialogue || ev.text || '').trim();
      const body =
        fromUser ||
        captainInputLine ||
        (target ? `${roleNameKo(target)} 구역 로그를 확인한다` : '시스템 로그를 확인한다');
      if (body) {
        out.push({ type: '[함장]', role: 'system', target: null, _key: baseKey + '|hdr' });
        out.push({ type: body, role: 'system', target: null, _key: baseKey + '|body' });
      }
      continue;
    }
    if (t === 'THREATEN' && target) {
      const obj = roleWithObjectParticle(target);
      const body = `${obj} 위협한다`.replace(/\s+/g, ' ').trim();
      const tk = [ev?.ts ?? '', t, role, target].join('|');
      out.push({ type: '[함장]', role: 'system', target: null, _key: tk + '|hdr' });
      out.push({ type: body, role: 'system', target: null, _key: tk + '|body' });
      continue;
    }
    if (t === 'FIND_CLUE') {
      const clueId = ev.clue_id ? String(ev.clue_id) : '';
      const clueKey = clueId || [ev?.ts ?? '', t, role, target ?? ''].join('|');
      const sysBody = (ev.clue_text || '').trim();
      const capBody = (ev.captain_action || '단서를 수집한다').trim();
      if (sysBody) {
        out.push({ type: '[함장]', role: 'system', target: null, _key: clueKey + '|hdr' });
        out.push({ type: capBody, role: 'system', target: null, _key: clueKey + '|body' });
        out.push({ type: '[시스템]', role: 'system', target: null, _key: clueKey + '|sys-hdr' });
        out.push({ type: sysBody, role: 'system', target: null, _key: clueKey + '|sys-body' });
      } else {
        out.push({ type: '함장이 단서를 수집했다.', role: 'system', target: null, _key: clueKey });
      }
      continue;
    }

    let text = null;
    if (t === 'OBSERVE') {
      text = '함장이 교량을 관찰했다.';
    } else if (t === 'ACCUSE' && target) {
      text = `함장이 ${roleWithObjectParticle(target)} 처형했다.`;
    } else if (t === 'DEATH') {
      const victim = roleNameKo(ev.role || target);
      text = victim ? `[시스템] ${victim} 생체 신호 소실.` : '[시스템] 생체 신호 소실.';
    } else if (t === 'TIMEOUT') {
      text = '[시스템] 시간 종료.';
    } else if (t === 'TAKE_PISTOL') {
      text = '함장이 권총을 획득했다.';
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
  return out;
}

/** 내부 요약/debug 문장 패턴 (플레이어 로그에서 제외) */
const INTERNAL_SUMMARY_PATTERN = /^(Captain acted\.?|Crew acted\.?|함장이 행동했다\.?|.+\s+acted\.?|.+\s+processed\.?)$/i;

/** 표시 문자열 정규화 (공백·트림) — 연속/턴 내 중복 비교용 */
function normalizeDisplayLine(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 함장 로그 확인 과거형 서술 (구 CHECK_LOG fallback). [함장]+현재형 본문 직후면 제거 */
const CAPTAIN_LOG_PAST_NARRATION = /^함장이 (?:시스템|닥터|엔지니어|네비게이터|파일럿)(?: 구역)? 로그를 확인했다\.?$/;

/**
 * 같은 이벤트가 여러 번 내려가지 않도록 _key(ts+type+role+target) 기준 dedupe.
 * 내부 요약 문장(Captain acted., Crew acted. 등)은 제거.
 * 연속으로 동일한 표시 문장(normalize 기준)은 한 번만 유지.
 * [함장] + 로그 확인 본문 다음에 오는 동일 의미의 함장 과거형 서술은 제거.
 * @param {object[]} displayLogs - toPlayerDisplayLogs 출력
 */
function dedupeDisplayLogs(displayLogs) {
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
    if (norm && CAPTAIN_LOG_PAST_NARRATION.test(norm) && final.length >= 2) {
      const prev = final[final.length - 1];
      const hdr = final[final.length - 2];
      if (hdr && hdr.type === '[함장]' && prev && prev.type && /확인/.test(String(prev.type))) {
        continue;
      }
    }
    prevNorm = norm;
    final.push(item);
  }
  return final;
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

  let needNewMatch = !matchId;
  if (matchId) {
    const existingMatch = await matchStore.getMatch(matchId);
    if (existingMatch?.game_state?.game_over) needNewMatch = true;
  }
  if (needNewMatch) {
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
  let player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  if (!matchId) {
    const match = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }

  const match = await matchStore.getMatch(matchId);
  if (!match) return 'Match not found. Send /start to begin.';

  if (match.game_state?.game_over) {
    log('GAME_OVER', 'blocked', { playerId, matchId, outcome: match.game_state.outcome });
    return 'Game over. Outcome: ' + (match.game_state.outcome || 'unknown') + '. Send /start for new game.';
  }

  // 2. parse intent
  const parsed = intentParser.parse(text);
  const action = {
    actor: 'captain',
    role: 'captain',
    action: parsed.intent_type,
    target: parsed.target
  };

  // 3. engine apply (opts.now for test)
  const result = await ep1Engine.applyAction(match, action, opts);
  if (!result.ok) {
    return 'Error: ' + (result.error || 'unknown');
  }

  // 4. state 저장
  await matchStore.updateMatch(matchId, {
    ...result.next_state,
    turn: (match.turn || 1) + 1
  });
  if (result.events && result.events.length > 0) {
    for (const ev of result.events) {
      await matchStore.appendEvent(matchId, ev);
    }
  }

  // 5. 응답 조립 (remaining_sec, game_over, outcome 포함)
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
      captainInputLine: isCheckLogMsg ? String(text || '').trim() : ''
    })
  );
  const clueEv = (result.events || []).find((e) => e && String(e.type).toUpperCase() === 'FIND_CLUE');
  const clueTextFromEvent = clueEv && clueEv.clue_text ? String(clueEv.clue_text) : undefined;
  const recentDisplay = dedupeDisplayLogs(
    await maybeDialogueLogsFromLlmOrDeterministic({
      rawEvents: result.events || [],
      deterministicLogs,
      match: updated,
      playerText: String(text || '').trim(),
      clueTextFromEvent
    })
  );
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
  if (t === '/start') return handleStart(playerId, opts);
  return handleTextMessage(playerId, t, opts);
}

/**
 * API용 /start 상태 반환
 * actual_imposter: game_over=true일 때만 match.impostor_role을 포함. game_over=false면 미포함.
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

  let needNewMatch = !matchId;
  if (matchId) {
    const existingMatch = await matchStore.getMatch(matchId);
    if (existingMatch?.game_state?.game_over) needNewMatch = true;
  }
  if (needNewMatch) {
    const match = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  const match = await matchStore.getMatch(matchId);
  const timer = ep1Engine.getTimerStatus ? ep1Engine.getTimerStatus(match) : { remaining_sec: 420 };
  const gs = match?.game_state || {};
  const displayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(match?.events || []));
  const out = {
    ok: true,
    match_id: matchId,
    remaining_sec: timer.remaining_sec ?? 420,
    game_state: gs,
    deadline_at: match?.deadline_at,
    events: displayLogs
  };
  if (gs.game_over) {
    const imp = match?.impostor_role ?? match?.hidden_host_role;
    if (imp) out.actual_imposter = imp;
    const evs = match?.events || [];
    if (evs.some((e) => e && e.type === 'TIMEOUT')) out.is_timeout = true;
  }
  return out;
}

/**
 * API용 메시지 처리 (구조화된 결과 반환)
 * actual_imposter: game_over=true일 때만 match.impostor_role을 포함. game_over=false면 미포함.
 * @param {string} playerId
 * @param {string} text
 * @param {object} opts - { now? }
 * @returns {Promise<object>}
 */
async function processMessageApi(playerId, text, opts = {}) {
  let player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  if (!matchId) {
    const match = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  const match = await matchStore.getMatch(matchId);
  if (!match) return { ok: false, error: 'Match not found' };

  if (match.game_state?.game_over) {
    const ret = {
      ok: true,
      summary: `Game over. Outcome: ${match.game_state.outcome || 'unknown'}`,
      game_over: true,
      outcome: match.game_state.outcome,
      remaining_sec: 0,
      events: [],
      match_state: { ...match.game_state }
    };
    if (match.impostor_role != null) ret.actual_imposter = match.impostor_role;
    const evs = match?.events || [];
    if (evs.some((e) => e && e.type === 'TIMEOUT')) ret.is_timeout = true;
    return ret;
  }

  const parsed = intentParser.parse(text);
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
      captainInputLine: isCheckLogMsg ? String(text || '').trim() : ''
    })
  );
  const clueEv = (result.events || []).find((e) => e && String(e.type).toUpperCase() === 'FIND_CLUE');
  const clueTextFromEvent = clueEv && clueEv.clue_text ? String(clueEv.clue_text) : undefined;
  const newDisplayLogs = dedupeDisplayLogs(
    await maybeDialogueLogsFromLlmOrDeterministic({
      rawEvents: result.events || [],
      deterministicLogs,
      match: updated,
      playerText: String(text || '').trim(),
      clueTextFromEvent
    })
  );
  const isCaptainBlock = newDisplayLogs.length >= 2 && newDisplayLogs[0].type === '[함장]';
  const captainBody = isCaptainBlock ? (newDisplayLogs[1].type || '').trim() : '';
  const hasCompleteCaptainBlock = isCaptainBlock && captainBody.length > 0;
  const summaryText = hasCompleteCaptainBlock
    ? '\u200b'
    : (newDisplayLogs.length ? newDisplayLogs[0].type : '\u200b');
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
    if (updated?.impostor_role != null) ret.actual_imposter = updated.impostor_role;
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
  const target = String(targetRaw || '').toLowerCase().trim();
  if (!ACCUSE_API_TARGETS.has(target)) {
    return { ok: false, error: 'Invalid target' };
  }

  let player = await playerStore.getPlayer(playerId);
  let matchId = player?.match_id;
  if (!matchId) {
    const match = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  const match = await matchStore.getMatch(matchId);
  if (!match) return { ok: false, error: 'Match not found' };

  if (match.game_state?.game_over) {
    const ret = {
      ok: true,
      summary: `Game over. Outcome: ${match.game_state.outcome || 'unknown'}`,
      game_over: true,
      outcome: match.game_state.outcome,
      remaining_sec: 0,
      events: [],
      recent_events: [],
      match_state: { ...match.game_state }
    };
    if (match.impostor_role != null) ret.actual_imposter = match.impostor_role;
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
  const newDisplayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(result.events || [], {}));
  const isCaptainBlock = newDisplayLogs.length >= 2 && newDisplayLogs[0].type === '[함장]';
  const captainBody = isCaptainBlock ? (newDisplayLogs[1].type || '').trim() : '';
  const hasCompleteCaptainBlock = isCaptainBlock && captainBody.length > 0;
  const summaryText = hasCompleteCaptainBlock
    ? '\u200b'
    : (newDisplayLogs.length ? newDisplayLogs[0].type : '\u200b');
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
    if (updated?.impostor_role != null) ret.actual_imposter = updated.impostor_role;
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
    const match = await matchStore.getOrCreateMatch('match_' + playerId + '_' + Date.now(), {});
    matchId = match.match_id;
    await playerStore.setPlayer(playerId, { match_id: matchId, role: 'captain' });
  }
  const match = await matchStore.getMatch(matchId);
  if (!match) return { ok: false, error: 'Match not found' };

  if (match.game_state?.game_over) {
    const ret = {
      ok: true,
      summary: `Game over. Outcome: ${match.game_state.outcome || 'unknown'}`,
      game_over: true,
      outcome: match.game_state.outcome,
      remaining_sec: 0,
      events: [],
      recent_events: [],
      match_state: { ...match.game_state }
    };
    if (match.impostor_role != null) ret.actual_imposter = match.impostor_role;
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
  const deterministicLogs = dedupeDisplayLogs(toPlayerDisplayLogs(result.events || [], {}));
  const clueEv = (result.events || []).find((e) => e && String(e.type).toUpperCase() === 'FIND_CLUE');
  const clueTextFromEvent = clueEv && clueEv.clue_text ? String(clueEv.clue_text) : undefined;
  const actionHint =
    actionKey === 'threaten'
      ? `[위협 action] target=${String(targetRaw || '').toLowerCase()}`
      : `[단서수집 action]`;
  const newDisplayLogs = dedupeDisplayLogs(
    await maybeDialogueLogsFromLlmOrDeterministic({
      rawEvents: result.events || [],
      deterministicLogs,
      match: updated,
      playerText: actionHint,
      clueTextFromEvent
    })
  );
  const isCaptainBlock = newDisplayLogs.length >= 2 && newDisplayLogs[0].type === '[함장]';
  const captainBody = isCaptainBlock ? (newDisplayLogs[1].type || '').trim() : '';
  const hasCompleteCaptainBlock = isCaptainBlock && captainBody.length > 0;
  const summaryText = hasCompleteCaptainBlock
    ? '\u200b'
    : (newDisplayLogs.length ? newDisplayLogs[0].type : '\u200b');
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
    if (updated?.impostor_role != null) ret.actual_imposter = updated.impostor_role;
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
 */
function createLocalApiServer() {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
    res.setHeader('Content-Type', 'application/json');

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    await new Promise((resolve) => req.on('end', resolve));

    const url = new URL(req.url || '/', 'http://localhost');
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
        const state = await getStartStateApi(playerId, { restart });
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, playerId, ...state }));
        return;
      }

      if (route === '/api/state' && req.method === 'GET') {
        const playerId = url.searchParams.get('playerId');
        if (!playerId) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'playerId required' }));
          return;
        }
        const player = await playerStore.getPlayer(playerId);
        const matchId = player?.match_id;
        if (!matchId) {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, match_id: null, game_state: null }));
          return;
        }
        let match = await matchStore.getMatch(matchId);
        if (!match) {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, match_id: null, game_state: null }));
          return;
        }
        const deltaRaw = await applyMatchClockTick(matchId);
        match = await matchStore.getMatch(matchId);
        const timer = ep1Engine.getTimerStatus(match, new Date());
        const gs = match?.game_state || {};
        const displayLogs = dedupeDisplayLogs(toPlayerDisplayLogs(match?.events || []));
        const recentDisplay = dedupeDisplayLogs(toPlayerDisplayLogs(deltaRaw));
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
          if (match.impostor_role != null) statePayload.actual_imposter = match.impostor_role;
          const evs = match?.events || [];
          if (evs.some((e) => e && e.type === 'TIMEOUT')) statePayload.is_timeout = true;
        }
        res.writeHead(200);
        res.end(JSON.stringify(statePayload));
        return;
      }

      if (route === '/api/message' && req.method === 'POST') {
        const data = body ? JSON.parse(body) : {};
        const playerId = data.playerId;
        const text = data.text || '';
        if (!playerId) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'playerId required' }));
          return;
        }
        const result = await processMessageApi(playerId, text);
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (route === '/api/accuse' && req.method === 'POST') {
        const data = body ? JSON.parse(body) : {};
        const playerId = data.playerId;
        const target = data.target;
        if (!playerId) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'playerId required' }));
          return;
        }
        if (target == null || String(target).trim() === '') {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'target required' }));
          return;
        }
        const result = await processAccuseApi(playerId, target);
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (route === '/api/action' && req.method === 'POST') {
        const data = body ? JSON.parse(body) : {};
        const playerId = data.playerId;
        const actionName = data.action;
        const targetOpt = data.target;
        if (!playerId) {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'playerId required' }));
          return;
        }
        if (actionName == null || String(actionName).trim() === '') {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'action required' }));
          return;
        }
        const result = await processActionApi(playerId, actionName, targetOpt);
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
 * 실행 진입점: node telegram/bot/bot.js
 * 로컬 API 서버 항상 시작, Telegram polling은 토큰 있을 때만.
 */
if (require.main === module) {
  require('dotenv').config();
  const token = process.env.TELEGRAM_BOT_TOKEN;

  const apiServer = createLocalApiServer();
  apiServer.listen(API_PORT, () => {
    console.log('[bot] local API server listening on http://localhost:' + API_PORT);
  });

  let bot = null;
  if (token) {
    const TelegramBot = require('node-telegram-bot-api');
    bot = new TelegramBot(token, { polling: true });
    console.log('[bot] bot runtime starting');
    console.log('[bot] token detected');
    console.log('[bot] polling started');

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
  processActionApi
};

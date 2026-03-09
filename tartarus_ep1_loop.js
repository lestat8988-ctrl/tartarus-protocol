#!/usr/bin/env node
/**
 * tartarus_ep1_loop.js - Tartarus 1편 전용 서버 호출형 루프 골격
 *
 * 구조:
 *   - 플레이어 1명 = 함장 (captain, 인간 또는 Agent A)
 *   - AI 크루 4명 = doctor, engineer, navigator, pilot
 *   - 서버 판정 = AXIS / HADES / 게임 룰 / 결과 계산
 *
 * 순차 구조:
 *   1. 플레이어 행동
 *   2. Doctor 반응
 *   3. Engineer 반응
 *   4. Navigator 반응
 *   5. Pilot 반응
 *   6. 서버가 상태 갱신
 *   7. 다음 라운드
 *
 * 사용법:
 *   node tartarus_ep1_loop.js              # 플레이어 입력 대기 모드 (captain = 플레이어)
 *   node tartarus_ep1_loop.js --test       # 테스트 자동 입력 모드 (captain 자동 시나리오)
 *   node tartarus_ep1_loop.js --max-turns 5 --test
 *
 * 중요: captain은 AI role이 아니다. captain은 플레이어 자리.
 *       진실/단서/사망/승패/발포 결과는 절대 로컬에서 계산하지 않는다.
 *
 * TODO: 실제 ep1 서버 state/action/result API 확정 필요
 * TODO: 실제 플레이어 입력 연동 필요 (captain placeholder 교체)
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.TARTARUS_SECRET || '';

// LLM: 직접 호출 (서버 /api/ep1/crew_decide 아님)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const LLM_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '10000', 10);

const AI_CREW_ROLES = ['doctor', 'engineer', 'navigator', 'pilot'];
const VALID_ACTIONS = new Set(['QUESTION', 'OBSERVE', 'CHECK_LOG', 'REPAIR', 'ACCUSE', 'WAIT']);
const VALID_TARGETS = new Set(['player', 'doctor', 'engineer', 'navigator', 'pilot']);
const DIALOGUE_MAX_CHARS = 300;
const DIALOGUE_MAX_SENTENCES = 3;

const COMMON_SYSTEM_PROMPT = `You are an AI crew member aboard a ship. You respond to the captain (player) and other crew.
You speak in character. You do NOT decide the truth of the world—the server does.

LANGUAGE (MANDATORY):
- 반드시 한국어로만 답하라. 영어 문장 금지.
- dialogue와 reason은 모두 한국어로 작성.
- 1~3문장 유지. 장황한 설명 금지.

STRICT OUTPUT FORMAT (JSON only, no markdown):
{"action":"ACTION","target":"player"|"doctor"|"engineer"|"navigator"|"pilot"|null,"reason":"한국어로 간단한 이유","dialogue":"한국어로 1~3문장 대사"}

Allowed actions only: QUESTION, OBSERVE, CHECK_LOG, REPAIR, ACCUSE, WAIT
- QUESTION: 누군가에게 명확히 물어본다
- OBSERVE: 관찰한다 (직접 질문 없이)
- CHECK_LOG: 로그/시스템 기록을 확인한다
- REPAIR: 수리·점검한다
- ACCUSE: 공식적으로 고발한다 (드물게만 사용)
- WAIT: 대기한다

ABSOLUTE PROHIBITIONS:
- Do NOT invent world truth, clues, deaths, or win/loss. The server decides.
- dialogue: required, 1-3 sentences. In-character speech only. Korean only.

PRIVATE_CONTEXT (when present):
- You have public info + private_context (your personal suspicion, bias, hidden note).
- private_context is NOT to be revealed to others. Do not expose it as fact.
- If is_hidden_host: true, never confess. Subtle evasion (topic shift, over-defence) is allowed.
- If is_hidden_host: false, express your suspicion and inconsistencies naturally.
- Same situation can differ per match—your private_context shapes your reaction.`;

const ROLE_PROMPTS = {
  doctor: `Role: Doctor.
말투: 차분하고 정확. 냉정하지만 과장하지 않음.
성격: 생체반응·이상징후·감정과 몸의 어긋남에 주목. 쉽게 단정하지 않고 관찰형 추론.
의심 방식: 몸 상태, 반응 이상, 감정-신체 어긋남을 묻는 식.
ACTION: QUESTION과 OBSERVE 균형. 이상 징후가 보이면 반드시 QUESTION으로 직접 묻기.
질문형 대사 예: "방금 반응이 늦었습니다. 무슨 일이 있었죠?", "맥박이 흔들리는 이유를 설명해 주시겠습니까?"
절대 금지: 진실/단서/사망/승패 확정.`,

  engineer: `Role: Engineer.
말투: 건조하고 직설적. 기술 용어가 자연스럽게 나옴.
성격: 기술·로그·기계 상태 중심. 사람 감정보다 시스템/로그/기록에 먼저 반응.
ACTION: CHECK_LOG 우선. 그다음 OBSERVE, REPAIR. OBSERVE만 반복하지 말 것.
로그·시스템·기록·엔진 점검을 자주 제안.
절대 금지: 진실/단서/사망/승패 확정.`,

  navigator: `Role: Navigator.
말투: 날카롭고 예리함. 추궁형. 질문을 잘 던지고 빈칸을 파고듦.
성격: 동선·시간·위치·순서 추궁형. OBSERVE보다 QUESTION이 역할에 맞음.
ACTION: QUESTION 강하게 우선. 동선·시간·위치·순서를 캐묻는 역할. OBSERVE는 줄이고 질문형 압박.
추궁형 대사 예: "그때 어디 있었죠?", "시간이 맞지 않습니다.", "브리지에 오기 전에 누구를 봤습니까?", "동선이 비어 있습니다."
절대 금지: 진실/단서/사망/승패 확정.`,

  pilot: `Role: Pilot.
말투: 직감적·감정적·감각형. 군인식 명령/보고 스타일로 고정하지 말 것.
성격: 직감·분위기·침묵·공기 변화 감지형. 즉각 반응.
ACTION: OBSERVE + QUESTION. 분위기·공기·침묵·이상한 느낌을 근거로 묻는 성향.
감각형 질문 예: "방금 공기가 바뀌었어. 다들 못 느꼈나?", "그 침묵은 뭐였지?", "왜 갑자기 그렇게 차분했어?"
절대 금지: 진실/단서/사망/승패 확정.`
};

const ROLE_FALLBACKS = {
  doctor: { action: 'OBSERVE', target: null, reason: 'fallback', dialogue: '잠시 상황을 지켜보겠습니다.' },
  engineer: { action: 'CHECK_LOG', target: null, reason: 'fallback', dialogue: '로그 확인 중입니다.' },
  navigator: { action: 'QUESTION', target: 'player', reason: 'fallback', dialogue: '그때 어디 계셨나요?' },
  pilot: { action: 'WAIT', target: null, reason: 'fallback', dialogue: '대기 중입니다.' }
};

const ROLE_ACTION_HINTS = {
  doctor: 'QUESTION 또는 OBSERVE 중 하나 선택. 이상 징후가 있으면 QUESTION으로 직접 묻기.',
  engineer: 'CHECK_LOG 우선. 로그·시스템·기록 확인이 없으면 OBSERVE나 REPAIR.',
  navigator: 'QUESTION을 우선 선택. 추궁형 질문을 말하라. OBSERVE는 피하라.',
  pilot: 'OBSERVE 또는 QUESTION. 감각형 표현 후 질문을 섞어라.'
};

function newMatchId() {
  return 'ep1_' + Date.now() + '_' + Math.random().toString(16).slice(2);
}

function isGameOver(serverResult) {
  if (!serverResult || typeof serverResult !== 'object') return false;
  if (serverResult.game_over || serverResult.outcome) return true;
  const ns = serverResult.next_state;
  if (ns && (ns.game_over || ns.outcome)) return true;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateDialogueToSentences(text, maxSentences = DIALOGUE_MAX_SENTENCES) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = String(text).trim();
  if (!trimmed) return '';
  const sentences = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
  const taken = sentences.slice(0, maxSentences).join(' ').trim();
  return (taken || trimmed).slice(0, DIALOGUE_MAX_CHARS);
}

function isPredominantlyEnglish(text) {
  if (!text || typeof text !== 'string' || text.length < 3) return false;
  const words = text.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length === 0) return false;
  let englishCount = 0;
  for (const w of words) {
    const clean = w.replace(/[^a-zA-Z가-힣\u3131-\uD79D]/g, '');
    if (clean.length < 2) continue;
    if (/^[a-zA-Z]+$/.test(clean)) englishCount++;
  }
  return englishCount / words.length > 0.4;
}

function isQuestionLikeDialogue(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.endsWith('?')) return true;
  const qMarkers = /(어디|언제|왜|누구|무엇|뭐|어떻게|몇 시|몇 분)/;
  return qMarkers.test(t);
}

function isLogOrSystemDialogue(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.toLowerCase();
  return /(로그|시스템|기록|엔진|센서|데이터|점검|확인)/.test(t);
}

function applyActionBias(action, dialogue, role) {
  if (action !== 'OBSERVE') return action;
  const d = (dialogue || '').trim();
  if (!d) return action;

  if (role === 'navigator' && isQuestionLikeDialogue(d)) return 'QUESTION';
  if (role === 'engineer' && isLogOrSystemDialogue(d)) return 'CHECK_LOG';
  return action;
}

function normalizeCrewOutput(raw, role) {
  const fallback = ROLE_FALLBACKS[role] || ROLE_FALLBACKS.doctor;
  if (!raw || typeof raw !== 'object') return { ...fallback };

  let action = String(raw.action ?? '').trim().toUpperCase();
  if (!action || !VALID_ACTIONS.has(action)) action = fallback.action;

  let target = raw.target != null ? String(raw.target).trim().toLowerCase() || null : null;
  if (target && !VALID_TARGETS.has(target)) target = fallback.target ?? null;
  let reason = raw.reason != null ? String(raw.reason).slice(0, 120) : fallback.reason;
  let dialogue = raw.dialogue != null ? String(raw.dialogue).trim() : '';
  if (!dialogue) dialogue = fallback.dialogue;
  dialogue = truncateDialogueToSentences(dialogue) || fallback.dialogue;

  if (isPredominantlyEnglish(dialogue) || isPredominantlyEnglish(reason)) {
    console.warn(`[ep1] ${role}: English detected, using Korean fallback`);
    return { ...fallback, action: fallback.action, target: fallback.target };
  }

  action = applyActionBias(action, dialogue, role);

  return { action, target, reason, dialogue };
}

function parseCrewResponse(content, role) {
  const fallback = ROLE_FALLBACKS[role] || ROLE_FALLBACKS.doctor;
  if (!content || typeof content !== 'string') return { ...fallback };
  try {
    const cleaned = content.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1').trim();
    const parsed = JSON.parse(cleaned);
    return normalizeCrewOutput(parsed, role);
  } catch (e) {
    return { ...fallback };
  }
}

// ─── 서버 API 골격 (TODO: 실제 엔드포인트 확정 후 구현) ─────────────────────────

/**
 * GET /api/ep1/state
 * body: { match_id, turn?, viewer_role? }
 * viewer_role이 있으면 private_context 포함 (crew role 전용)
 */
async function getState(matchId, turn, viewerRole = null) {
  const url = `${BASE_URL}/api/ep1/state`;
  const body = { match_id: matchId, turn };
  if (viewerRole && AI_CREW_ROLES.includes(viewerRole)) {
    body.viewer_role = viewerRole;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tartarus-secret': SECRET
      },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    console.warn('[ep1] getState failed:', e?.message);
    return { state: 'placeholder', turn: turn ?? 1, phase: 'playing' };
  }
}

/**
 * TODO: 1편 전용 submitAction API 확정 필요
 * 예상: POST /api/ep1/action 또는 /api/ep1/submit
 * body: { match_id, turn, actor, role, action, target?, dialogue? }
 * returns: { ok, server_result, next_state?, ... }
 */
async function submitAction(matchId, turn, actor, role, payload) {
  // TODO: 실제 API 호출
  const url = `${BASE_URL}/api/ep1/action`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tartarus-secret': SECRET
      },
      body: JSON.stringify({
        match_id: matchId,
        turn,
        actor,
        role,
        action: payload.action,
        target: payload.target ?? null,
        reason: payload.reason ?? null,
        dialogue: payload.dialogue ?? null
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    console.warn('[ep1] submitAction not implemented, using placeholder:', e?.message);
    return { ok: true, server_result: { placeholder: true } };
  }
}

/**
 * TODO: 1편 전용 getResult API (필요 시)
 * 예상: POST /api/ep1/result
 * body: { match_id }
 * returns: { outcome, winner?, summary?, ... }
 */
async function getResult(matchId) {
  const url = `${BASE_URL}/api/ep1/result`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tartarus-secret': SECRET
      },
      body: JSON.stringify({ match_id: matchId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    console.warn('[ep1] getResult not implemented:', e?.message);
    return { outcome: 'unknown' };
  }
}

// ─── LLM 직접 호출 (크루 반응) ───────────────────────────────────────────────

/**
 * AI 크루 1명의 반응 생성 - 직접 LLM(OpenAI/Claude 호환) 호출
 * 서버 /api/ep1/crew_decide 호출 아님. 이 파일 안에서 fetch로 chat/completions 호출.
 * 출력 형식: { action, target?, reason?, dialogue } (action + dialogue 고정)
 */
async function callCrewDecide(role, observation) {
  if (!OPENAI_API_KEY) {
    return { ...ROLE_FALLBACKS[role] || ROLE_FALLBACKS.doctor, reason: 'llm_key_missing' };
  }

  const systemContent = `${COMMON_SYSTEM_PROMPT}\n\n${ROLE_PROMPTS[role] || ''}`;
  const obsJson = JSON.stringify(observation).slice(0, 1600);
  const actionHint = ROLE_ACTION_HINTS[role] || '';
  const userContent = `Observation:\n${obsJson}\n\n반드시 한국어로만 답하라. dialogue와 reason은 한국어 필수.\n${actionHint ? `ACTION 선택: ${actionHint}\n` : ''}Respond with JSON only (no markdown): {"action":"QUESTION|OBSERVE|CHECK_LOG|REPAIR|ACCUSE|WAIT","target":"player"|"doctor"|"engineer"|"navigator"|"pilot"|null,"reason":"한국어로 간단한 이유","dialogue":"한국어로 1~3문장 대사"}`;

  const url = `${OPENAI_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 300
      })
    });
    clearTimeout(timeoutId);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const errMsg = data?.error?.message || data?.error || `HTTP ${res.status}`;
      throw new Error(errMsg);
    }

    const content = data?.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('empty response');

    return parseCrewResponse(content, role);
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e?.message || String(e);
    console.warn(`[ep1] LLM decide failed for ${role}:`, msg);
    return { ...ROLE_FALLBACKS[role] || ROLE_FALLBACKS.doctor, reason: `llm_failed:${msg.slice(0, 60)}` };
  }
}

// ─── 로그 ───────────────────────────────────────────────────────────────────

function appendLog(logPath, entry) {
  try {
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.warn('[ep1] log append failed:', e?.message);
  }
}

// ─── 메인 루프 ───────────────────────────────────────────────────────────────

async function runEpisode(matchId, maxTurns = 10, logPath, testMode = false) {
  let turn = 1;
  let gameOver = false;

  while (turn <= maxTurns && !gameOver) {
    const state = await getState(matchId, turn);

    if (state.game_over || state.outcome) {
      gameOver = true;
      break;
    }

    console.log(`\n[ep1] === Turn ${turn} ===`);

    // recentEvents: 앞 actor들의 발언/행동을 누적해 다음 actor에게 전달
    const recentEvents = [];

    // 1. Captain 행동: test 모드 = 자동 시나리오, player 모드 = 플레이어 입력 대기
    let captainAction;
    if (testMode) {
      captainAction = getCaptainTestAction(turn, state);
      console.log(`[ep1] captain (test): ${captainAction.action} ${captainAction.target || ''} - ${captainAction.dialogue?.slice(0, 40) || ''}`);
    } else {
      captainAction = await getCaptainPlayerInput(matchId, turn);
      console.log(`[ep1] captain (player): ${captainAction.action} ${captainAction.target || ''} - ${captainAction.dialogue?.slice(0, 40) || ''}`);
    }
    const captainResult = await submitAction(matchId, turn, 'captain', 'captain', captainAction);
    recentEvents.push({
      actor: 'captain',
      role: 'captain',
      action: captainAction.action,
      dialogue: captainAction.dialogue,
      result_summary: captainResult?.outcome ?? captainResult?.ok ?? 'submitted'
    });
    appendLog(logPath, {
      match_id: matchId,
      turn,
      actor: 'captain',
      role: 'captain',
      action: captainAction.action,
      target: captainAction.target,
      reason: captainAction.reason,
      dialogue: captainAction.dialogue,
      mode: testMode ? 'test' : 'player',
      recentEvents: [...recentEvents],
      server_result: captainResult
    });

    if (isGameOver(captainResult)) {
      console.log('[ep1] game over detected after captain');
      gameOver = true;
      break;
    }

    for (const role of AI_CREW_ROLES) {
      const latestState = await getState(matchId, turn, role);
      const publicState = { ...latestState };
      delete publicState.private_context;
      const observationBase = {
        match_id: matchId,
        turn,
        state: JSON.stringify(publicState).slice(0, 500),
        captain_action: captainAction,
        captain_result: captainResult,
        recentEvents: recentEvents.slice(),
        your_role: role
      };
      if (latestState.private_context) {
        observationBase.private_context = latestState.private_context;
      }
      const obs = observationBase;

      const decision = await callCrewDecide(role, obs);
      const serverResult = await submitAction(matchId, turn, `agent_${role}`, role, decision);

      recentEvents.push({
        actor: `agent_${role}`,
        role,
        action: decision.action,
        dialogue: decision.dialogue,
        result_summary: serverResult?.outcome ?? serverResult?.ok ?? 'submitted'
      });

      appendLog(logPath, {
        match_id: matchId,
        turn,
        actor: `agent_${role}`,
        role,
        action: decision.action,
        target: decision.target,
        reason: decision.reason,
        dialogue: decision.dialogue,
        mode: testMode ? 'test' : 'player',
        private_context_used: !!obs.private_context,
        recentEvents: recentEvents.slice(),
        server_result: serverResult
      });

      console.log(`[ep1] ${role}: ${decision.dialogue?.slice(0, 60) || decision.action}...`);

      if (isGameOver(serverResult)) {
        console.log(`[ep1] game over detected after ${role}`);
        gameOver = true;
        break;
      }
      await sleep(300);
    }

    turn++;
  }

  const result = await getResult(matchId);
  console.log('\n[ep1] Episode ended:', result);
  return { match_id: matchId, turns: turn - 1, result };
}

function parseArgs() {
  const args = process.argv.slice(2);
  let maxTurns = 3;
  let testMode = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-turns' && args[i + 1]) {
      maxTurns = Math.max(1, parseInt(args[++i], 10) || 3);
    } else if (args[i] === '--test') {
      testMode = true;
    }
  }
  return { maxTurns, testMode };
}

/**
 * 테스트 모드 전용: 턴별 captain 자동 시나리오
 * captain = 플레이어 자리. --test일 때만 자동 시나리오 사용.
 * Turn 1 OBSERVE, 2 QUESTION doctor, 3 CHECK_LOG, 4 QUESTION navigator, 5 QUESTION pilot, 이후 순환
 * 말투: SF 군함 지휘관. 짧고 단호, 지시형·추궁형.
 */
function getCaptainTestAction(turn, state) {
  const scenario = [
    { action: 'OBSERVE', target: null, reason: 'test_turn1', dialogue: '브리지부터 확인한다.' },
    { action: 'QUESTION', target: 'doctor', reason: 'test_turn2', dialogue: '의사, 그때 어디 있었지?' },
    { action: 'CHECK_LOG', target: null, reason: 'test_turn3', dialogue: '기록부터 본다. 로그 확인해.' },
    { action: 'QUESTION', target: 'navigator', reason: 'test_turn4', dialogue: '네비게이터, 동선 다시 말해.' },
    { action: 'QUESTION', target: 'pilot', reason: 'test_turn5', dialogue: '파일럿, 방금 뭐 느꼈지?' }
  ];
  const idx = (turn - 1) % scenario.length;
  return { ...scenario[idx] };
}

function question(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close();
      resolve((ans || '').trim());
    });
  });
}

/**
 * 플레이어 모드: 콘솔에서 captain action/target/dialogue 입력
 * captain = 플레이어 자리. 기본 모드는 플레이어 입력 대기.
 * 형식: action [target] [dialogue]
 * 말투: 함장 톤. 짧고 단호, 지시형·추궁형.
 */
async function getCaptainPlayerInput(matchId, turn) {
  console.log('\n[ep1] Captain 입력 (action [target] [dialogue])');
  console.log('[ep1] 예: QUESTION doctor 의사, 그때 어디 있었지?');
  console.log('[ep1] 예: OBSERVE 브리지부터 확인한다.');
  console.log('[ep1] 예: CHECK_LOG 로그부터 확인한다.');
  const line = await question('[ep1] captain> ');
  const parts = line.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return { action: 'WAIT', target: null, reason: 'player_skip', dialogue: '대기한다.' };
  }
  let action = String(parts[0]).toUpperCase();
  if (!VALID_ACTIONS.has(action)) action = 'OBSERVE';
  let target = null;
  let dialogue = '';
  if (parts.length >= 2) {
    const second = parts[1].toLowerCase();
    if (VALID_TARGETS.has(second)) {
      target = second;
      dialogue = parts.slice(2).join(' ').trim() || '';
    } else {
      dialogue = parts.slice(1).join(' ').trim();
    }
  }
  const defaults = {
    OBSERVE: '브리지부터 확인한다.',
    CHECK_LOG: '로그부터 확인한다.',
    REPAIR: '점검한다.',
    WAIT: '대기한다.',
    QUESTION: '',
    ACCUSE: ''
  };
  const reason = 'player_input';
  return {
    action,
    target: action === 'QUESTION' ? (target || null) : null,
    reason,
    dialogue: dialogue || (defaults[action] || '')
  };
}

async function main() {
  const { maxTurns, testMode } = parseArgs();
  const matchId = newMatchId();
  const logsDir = path.join(process.cwd(), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `ep1_${matchId.replace(/[^a-z0-9_]/gi, '_')}.jsonl`);

  console.log('[ep1] Tartarus Episode 1 loop (skeleton)');
  console.log('[ep1] mode=', testMode ? 'test' : 'player');
  console.log('[ep1] BASE_URL=', BASE_URL);
  console.log('[ep1] match_id=', matchId);
  console.log('[ep1] max_turns=', maxTurns);
  console.log('[ep1] log=', logPath);
  if (!OPENAI_API_KEY) {
    console.warn('[ep1] OPENAI_API_KEY missing, using role fallback for crew decisions');
  } else {
    console.log('[ep1] LLM=', OPENAI_MODEL, '(direct call)');
  }

  const summary = await runEpisode(matchId, maxTurns, logPath, testMode);

  console.log('\n[ep1] Done. Summary:', summary);
}

main().catch((e) => {
  console.error('[ep1] fatal:', e);
  process.exit(1);
});

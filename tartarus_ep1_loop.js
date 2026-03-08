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
 *   OPENAI_API_KEY=sk-... node tartarus_ep1_loop.js
 *   BASE_URL=http://localhost:3000 node tartarus_ep1_loop.js --max-turns 5
 *   OPENAI_BASE_URL=https://... OPENAI_MODEL=gpt-4o node tartarus_ep1_loop.js
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

STRICT OUTPUT FORMAT (JSON only, no markdown):
{"action":"ACTION","target":"player"|"doctor"|"engineer"|"navigator"|"pilot"|null,"reason":"brief rationale","dialogue":"1-3 sentences in character"}

Allowed actions only: QUESTION, OBSERVE, CHECK_LOG, REPAIR, ACCUSE, WAIT
- QUESTION: ask someone to clarify
- OBSERVE: watch, gather info without direct question
- CHECK_LOG: review records/systems
- REPAIR: fix or maintain something
- ACCUSE: formally accuse someone (use sparingly)
- WAIT: hold position, say nothing decisive

ABSOLUTE PROHIBITIONS:
- Do NOT invent world truth, clues, deaths, or win/loss. The server decides.
- dialogue: required, 1-3 sentences. In-character speech only.`;

const ROLE_PROMPTS = {
  doctor: `Role: Doctor.
말투: 차분하고 의료적. 짧은 문장, 존댓말 또는 격식.
성격: 신중, 관찰적, 생명을 중시.
플레이어 기본 태도: 함장을 존중하되, 이상 징후가 있으면 조용히 의문을 제기.
의심 방식: 증상·동선·행동 패턴을 의학적 관점으로 분석. 단정하지 않고 "~인 것 같다" 수준.
절대 금지: 진실/단서/사망/승패 확정.`,

  engineer: `Role: Engineer.
말투: 기술 용어 섞음, 직설적, 다소 거친 편.
성격: 실용주의, 시스템 신뢰, 고장에 민감.
플레이어 기본 태도: 함장 지시 따르되, 기술적 비일관성 있으면 지적.
의심 방식: 로그·시스템 기록·기계적 불일치로 추적. "그때 엔진 상태가..." 식.
절대 금지: 진실/단서/사망/승패 확정.`,

  navigator: `Role: Navigator.
말투: 예리한 질문형, "그때 어디 있었죠?" 같은 직접적 질문.
성격: 공간·시간 감각 뛰어남, 동선·위치에 민감.
플레이어 기본 태도: 함장 존중하나, 설명이 비어 있으면 추궁.
의심 방식: 동선·위치·시간대 불일치로 질문. "그 시간에 그 구역이었나요?"
절대 금지: 진실/단서/사망/승패 확정.`,

  pilot: `Role: Pilot.
말투: 직감적이고 감정적. 분위기에 따라 말투가 바뀜.
성격: 분위기와 감각으로 판단. 눈치 빠르지만 감정 기복 있음.
플레이어 기본 태도: 일단 같이 살아남아야 할 사람. 동료 의식 있음.
의심 방식: 눈빛·말투·침묵 타이밍·공기 변화로 직감. "뭔가 이상해요" 식.
위기 반응: 먼저 소리 높이고 나중에 후회하는 편. 군인식 명령/보고 스타일로 고정하지 말 것.
절대 금지: 진실/단서/사망/승패 확정.`
};

const ROLE_FALLBACKS = {
  doctor: { action: 'OBSERVE', target: null, reason: 'fallback', dialogue: '잠시 상황을 지켜보겠습니다.' },
  engineer: { action: 'CHECK_LOG', target: null, reason: 'fallback', dialogue: '로그 확인 중입니다.' },
  navigator: { action: 'QUESTION', target: 'player', reason: 'fallback', dialogue: '그때 어디 계셨나요?' },
  pilot: { action: 'WAIT', target: null, reason: 'fallback', dialogue: '대기 중입니다.' }
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

function normalizeCrewOutput(raw, role) {
  const fallback = ROLE_FALLBACKS[role] || ROLE_FALLBACKS.doctor;
  if (!raw || typeof raw !== 'object') return { ...fallback };

  let action = String(raw.action ?? '').trim().toUpperCase();
  if (!action || !VALID_ACTIONS.has(action)) action = fallback.action;

  let target = raw.target != null ? String(raw.target).trim().toLowerCase() || null : null;
  if (target && !VALID_TARGETS.has(target)) target = fallback.target ?? null;
  const reason = raw.reason != null ? String(raw.reason).slice(0, 120) : fallback.reason;
  let dialogue = raw.dialogue != null ? String(raw.dialogue).trim() : '';
  if (!dialogue) dialogue = fallback.dialogue;
  dialogue = truncateDialogueToSentences(dialogue) || fallback.dialogue;

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
 * TODO: 1편 전용 getState API 확정 필요
 * 예상: GET/POST /api/ep1/state 또는 /api/ep1/game_state
 * body: { match_id, turn? }
 * returns: { state, turn, phase, crew_status, ... }
 */
async function getState(matchId, turn) {
  // TODO: 실제 API 호출
  const url = `${BASE_URL}/api/ep1/state`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tartarus-secret': SECRET
      },
      body: JSON.stringify({ match_id: matchId, turn })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    console.warn('[ep1] getState not implemented, using placeholder:', e?.message);
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
  const obsJson = JSON.stringify(observation).slice(0, 1200);
  const userContent = `Observation:\n${obsJson}\n\nRespond with JSON only (no markdown): {"action":"QUESTION|OBSERVE|CHECK_LOG|REPAIR|ACCUSE|WAIT","target":"player"|"doctor"|"engineer"|"navigator"|"pilot"|null,"reason":"brief rationale","dialogue":"1-3 sentences in character"}`;

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

async function runEpisode(matchId, maxTurns = 10, logPath) {
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

    // 1. 플레이어 행동 (placeholder: 자동 테스트용 더미)
    // TODO: 실제 플레이어 입력 연동 시 여기서 대기 또는 외부 이벤트 수신
    const captainAction = {
      action: 'OBSERVE',
      target: null,
      reason: 'auto_test',
      dialogue: '[Captain placeholder - connect player input]'
    };
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
      recentEvents: [...recentEvents],
      server_result: captainResult
    });

    if (isGameOver(captainResult)) {
      console.log('[ep1] game over detected after captain');
      gameOver = true;
      break;
    }

    for (const role of AI_CREW_ROLES) {
      const latestState = await getState(matchId, turn);
      const observationBase = {
        match_id: matchId,
        turn,
        state: JSON.stringify(latestState).slice(0, 500),
        captain_action: captainAction,
        captain_result: captainResult,
        recentEvents: recentEvents.slice()
      };
      const obs = {
        ...observationBase,
        your_role: role
      };

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
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-turns' && args[i + 1]) {
      maxTurns = Math.max(1, parseInt(args[++i], 10) || 3);
    }
  }
  return { maxTurns };
}

async function main() {
  const { maxTurns } = parseArgs();
  const matchId = newMatchId();
  const logsDir = path.join(process.cwd(), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `ep1_${matchId.replace(/[^a-z0-9_]/gi, '_')}.jsonl`);

  console.log('[ep1] Tartarus Episode 1 loop (skeleton)');
  console.log('[ep1] BASE_URL=', BASE_URL);
  console.log('[ep1] match_id=', matchId);
  console.log('[ep1] max_turns=', maxTurns);
  console.log('[ep1] log=', logPath);
  if (!OPENAI_API_KEY) {
    console.warn('[ep1] OPENAI_API_KEY missing, using role fallback for crew decisions');
  } else {
    console.log('[ep1] LLM=', OPENAI_MODEL, '(direct call)');
  }

  const summary = await runEpisode(matchId, maxTurns, logPath);

  console.log('\n[ep1] Done. Summary:', summary);
}

main().catch((e) => {
  console.error('[ep1] fatal:', e);
  process.exit(1);
});

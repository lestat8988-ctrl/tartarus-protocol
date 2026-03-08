/**
 * arena_duel_llm.js - LLM 기반 자동대전 오케스트레이터
 *
 * 사용법:
 *   npx vercel dev 켜고
 *   MATCHES=3 node arena_duel_llm.js
 *
 * 후처리 옵션 (opt-in):
 *   --post-pipeline   대전 종료 후 run_pipeline.js 자동 실행
 *   --post-compare    --post-pipeline 시 --compare 추가
 *   --post-top <N>    파이프라인 --top 값 (기본 10)
 *
 * action 포맷: arena_duel.js / api/play.js actionToEngineFormat()와 동일
 * - SCAN -> { type: 'interrogate' }
 * - ACCUSE -> { type: 'accuse', target: 'Navigator'|'Engineer'|'Doctor'|'Pilot' }
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const CREW = ['Navigator', 'Engineer', 'Doctor', 'Pilot'];
const TARGET_WHITELIST = ['Doctor', 'Engineer', 'Navigator'];
const FORCE_TURN = 20;
const MIN_TURN_FOR_CONF_FORCE = 10;
const CONF_FORCE = 0.85;
// Rush: 4턴 전후 무지성 accuse 방지 (최소 턴/confidence 기준)
const RUSH_MIN_ACCUSE_TURN = 6;
const RUSH_MIN_ACCUSE_CONF = 0.72;
// Cautious: SCAN 무한 반복 방지, forced accuse 직전까지 가는 비율 감소
const CAUTIOUS_FORCE_TURN = 17;
const CAUTIOUS_MIN_TURN_FOR_CONF = 12;
const CAUTIOUS_CONF_FORCE = 0.70;
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const MATCHES = parseInt(process.env.MATCHES || '3', 10);
const SECRET = process.env.TARTARUS_SECRET;

const ERROR_REASON_PATTERN = /^(parse_failed|openai_error|openrouter_error|openai_http|openrouter_http|.*timeout|agent_decide_failed|decide_failed)/i;

function newMatchId() {
  return 'match_' + Date.now() + '_' + Math.random().toString(16).slice(2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * decision.action (LLM) -> /api/play body action (arena_duel.js 형식)
 * 참조: arena_duel.js L106-128, api/play.js actionToEngineFormat()
 */
function isInWhitelist(t) {
  if (!t || typeof t !== 'string') return false;
  const s = String(t).trim();
  return TARGET_WHITELIST.some((c) => c.toLowerCase() === s.toLowerCase());
}

function canonicalTarget(t) {
  if (!t) return null;
  const found = TARGET_WHITELIST.find((c) => c.toLowerCase() === String(t).trim().toLowerCase());
  return found || null;
}

function pickFallbackTarget() {
  return TARGET_WHITELIST[Math.floor(Math.random() * TARGET_WHITELIST.length)];
}

function decisionToPlayAction(decision) {
  if (!decision || !decision.action) return { type: 'interrogate' };
  const a = decision.action;
  const t = String(a.type || '').toUpperCase();
  if (t === 'SCAN') return { type: 'interrogate' };
  if (t === 'ACCUSE') {
    const target = String(a.target || '').trim();
    const valid = CREW.find((c) => c.toLowerCase() === target.toLowerCase()) || CREW[0];
    return { type: 'accuse', target: valid };
  }
  return { type: 'interrogate' };
}

function buildObservation(prevResult, turn, agentType, recentTurns, lastReason) {
  let base;
  if (!prevResult) {
    base = `Turn ${turn}. Game start. Crew: ${CREW.join(', ')}. No dead crew. No previous results.`;
  } else {
    const text = (prevResult.resultText || prevResult.result || '').slice(0, 800);
    const dead = Array.isArray(prevResult.deadCrew) ? prevResult.deadCrew : [];
    const state = prevResult.state || 'playing';
    base = `Turn ${turn}. Previous result (${state}):\n${text}\n\nDead crew: ${dead.join(', ') || 'none'}`;
  }
  const hints = [];
  if (agentType === 'Rush') {
    hints.push(`[Rush] Do not accuse before turn ${RUSH_MIN_ACCUSE_TURN} unless confidence>=${RUSH_MIN_ACCUSE_CONF}. Gather info first.`);
  } else if (agentType === 'Cautious') {
    hints.push(`[Cautious] After turn ${CAUTIOUS_MIN_TURN_FOR_CONF}, narrow to top suspect. Consider ACCUSE before turn ${CAUTIOUS_FORCE_TURN}.`);
    if (turn >= 14) hints.push('Late game: pick your top suspect and ACCUSE if you have any lead.');
  }
  const last3 = (recentTurns || []).slice(-3);
  const scanCount = last3.filter((t) => String(t?.actionType || '').toUpperCase() === 'SCAN').length;
  if (scanCount >= 3) {
    hints.push('[Diversity] You have SCANned 3+ turns in a row. Consider narrowing suspects or ACCUSE if you have a lead.');
  }
  if (lastReason && String(lastReason).trim().length > 0 && turn > 2) {
    const prev = String(lastReason).slice(0, 80);
    hints.push(`[Vary] Last reason: "${prev}${prev.length >= 80 ? '...' : ''}". Use a different reason if possible.`);
  }
  if (hints.length > 0) {
    base += '\n\n' + hints.join(' ');
  }
  return base;
}

async function fetchWithRetry(url, options, maxRetries = 1) {
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fetch(url, options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
      return data;
    } catch (e) {
      lastErr = e;
      if (i < maxRetries) await sleep(200);
    }
  }
  throw lastErr;
}

async function callAgentDecide(baseUrl, body) {
  const url = baseUrl + '/api/agent_decide';
  try {
    return await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tartarus-secret': SECRET || ''
        },
        body: JSON.stringify(body)
      },
      1
    );
  } catch {
    return { action: { type: 'SCAN', target: null }, confidence: 0.5, reason: 'agent_decide_failed', suspectRanking: [] };
  }
}

function broadcastTurn(rt, payload) {
  if (!rt) return;
  try {
    rt.send({ type: 'broadcast', event: 'turn', payload });
  } catch (e) {
    console.warn('[arena_llm] broadcast turn failed:', e?.message);
  }
}

function broadcastGameover(rt, payload) {
  if (!rt) return;
  try {
    rt.send({ type: 'broadcast', event: 'gameover', payload });
  } catch (e) {
    console.warn('[arena_llm] broadcast gameover failed:', e?.message);
  }
}

async function callPlay(baseUrl, body) {
  const url = baseUrl + '/api/play';
  return fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tartarus-secret': SECRET || ''
      },
      body: JSON.stringify(body)
    },
    1
  );
}

function extractReasonAndError(decision) {
  const raw = String(decision?.reason ?? '').trim();
  const isError = ERROR_REASON_PATTERN.test(raw);
  return {
    reason: isError ? null : (raw || 'missing_reason'),
    llm_error: isError ? raw : null,
    parse_error: isError && /parse_failed/i.test(raw)
  };
}

function getAccuseThreshold(agentType) {
  if (agentType === 'Rush') return { minTurn: RUSH_MIN_ACCUSE_TURN, minConf: RUSH_MIN_ACCUSE_CONF };
  if (agentType === 'Cautious') return { forceTurn: CAUTIOUS_FORCE_TURN, minTurn: CAUTIOUS_MIN_TURN_FOR_CONF, minConf: CAUTIOUS_CONF_FORCE };
  return { forceTurn: FORCE_TURN, minTurn: MIN_TURN_FOR_CONF_FORCE, minConf: CONF_FORCE };
}

async function runMatch(agentType, matchIndex, rt, detailedEvents) {
  const matchId = newMatchId();
  const agentId = agentType === 'Rush' ? 'Agent_Rush' : 'Agent_Cautious';
  const policy = agentType === 'Rush' ? 'RUSH' : 'CAUTIOUS';

  let history = [];
  let deadCrew = [];
  let rngState = null;
  const seed = 'arena_llm_' + matchIndex;
  let turns = 0;
  let accuseTurn = null;
  let accuseTarget = null;
  let finalConfidence = 0.5;
  let prevResult = null;
  const maxTurns = 25;
  let scanCountSoFar = 0;
  let repeatedScanCount = 0;

  const arenaMeta = {
    turns: 0, accuseTurn: null, finalConfidence: null, finalReason: null,
    forcedAccuse: false, forcedAccuseTurn: null,
    turnEvents: [], highlights: [], highlightTopScore: 0, highlightTopLabelKo: null
  };
  const recentTurns = [];
  let accuseReason = null;
  let lastDecisionTarget = null;
  let lastReason = null;
  let matchForcedAccuse = false;
  let prevConfidence = null;
  let prevTopSuspect = null;
  const matchStartTs = Date.now();

  while (turns < maxTurns) {
    turns++;
    arenaMeta.turns = turns;

    const obsText = buildObservation(prevResult, turns, agentType, recentTurns, lastReason);
    const observation = { text: obsText, recentTurns: recentTurns.slice(-3) };

    let decision;
    let fallbackUsed = false;
    try {
      decision = await callAgentDecide(BASE_URL, {
        match_id: matchId,
        agent_id: agentId,
        turn: turns,
        observation,
        policy
      });
    } catch (e) {
      fallbackUsed = true;
      decision = { action: { type: 'SCAN', target: null }, confidence: 0.5, reason: 'decide_failed', suspectRanking: [] };
    }

    let modelAction = String(decision.action?.type || 'SCAN').toUpperCase();
    let modelTarget = decision.action?.target != null ? decision.action.target : null;
    let conf = typeof decision.confidence === 'number' && !Number.isNaN(decision.confidence)
      ? Math.max(0, Math.min(1, decision.confidence))
      : 0.5;
    arenaMeta.finalConfidence = conf;
    finalConfidence = conf;

    // Rush: 조기 accuse 차단 (turn<=5, conf 부족 시 SCAN으로 전환)
    if (agentType === 'Rush' && modelAction === 'ACCUSE' && accuseTurn == null && turns < RUSH_MIN_ACCUSE_TURN) {
      if (conf < RUSH_MIN_ACCUSE_CONF) {
        modelAction = 'SCAN';
        modelTarget = null;
        conf = Math.min(conf, 0.84);
        decision.action = { type: 'SCAN', target: null };
        decision.confidence = conf;
        arenaMeta.finalConfidence = conf;
        finalConfidence = conf;
        decision.reason = (decision.reason || '').replace(/\s*\[RUSH_EARLY_BLOCK\]\s*$/, '').trim() + ' [RUSH_EARLY_BLOCK]';
      }
    }

    // Cautious: 후반부(12턴+)에서 SCAN만 반복 시 confidence 보정 (의사결정에 영향 없음, forced accuse만 앞당김)
    const cautiousForceTurn = agentType === 'Cautious' ? CAUTIOUS_FORCE_TURN : FORCE_TURN;
    const cautiousMinTurn = agentType === 'Cautious' ? CAUTIOUS_MIN_TURN_FOR_CONF : MIN_TURN_FOR_CONF_FORCE;
    const cautiousConf = agentType === 'Cautious' ? CAUTIOUS_CONF_FORCE : CONF_FORCE;

    // 강제고발: agentType별 파라미터 적용
    const shouldForce = (turns >= cautiousForceTurn) || (turns >= cautiousMinTurn && conf >= cautiousConf) || (turns >= maxTurns);
    let forcedAccuse = !!(decision.forcedAccuse || decision.forced_accuse || (shouldForce && modelAction !== 'ACCUSE' && accuseTurn == null));
    if (shouldForce && modelAction !== 'ACCUSE' && accuseTurn == null) {
      matchForcedAccuse = true;
      decision.action = decision.action || {};
      decision.action.type = 'ACCUSE';
      let targetVal = isInWhitelist(modelTarget) ? modelTarget : null;
      if (!targetVal && Array.isArray(decision.suspectRanking) && decision.suspectRanking[0] && isInWhitelist(decision.suspectRanking[0])) {
        targetVal = decision.suspectRanking[0];
      }
      if (!targetVal) targetVal = pickFallbackTarget();
      decision.action.target = targetVal;
      if (!(decision.reason || '').includes('[FORCED_ACCUSE]')) {
        decision.reason = (decision.reason || '') + ' [FORCED_ACCUSE]';
      }
    }
    if (forcedAccuse && arenaMeta.forcedAccuseTurn == null) {
      arenaMeta.forcedAccuseTurn = turns;
    }
    arenaMeta.forcedAccuse = forcedAccuse || arenaMeta.forcedAccuse;

    const actionType = String(decision.action?.type || 'SCAN').toUpperCase();
    const decisionTarget = decision.action?.target != null ? String(decision.action.target) : null;
    const action = decisionToPlayAction(decision);

    lastDecisionTarget = decisionTarget;
    lastReason = decision.reason || 'missing_reason';

    if (actionType === 'ACCUSE' && accuseReason == null) {
      accuseReason = decision.reason || 'missing_reason';
    }

    if (action.type === 'accuse' && accuseTurn == null) {
      accuseTurn = turns;
      accuseTarget = decisionTarget;
      arenaMeta.accuseTurn = turns;
    }

    arenaMeta.finalReason = accuseReason || lastReason || 'missing_reason';

    if (actionType === 'SCAN') {
      scanCountSoFar++;
      repeatedScanCount++;
    } else {
      repeatedScanCount = 0;
    }
    const { reason: logReason, llm_error: logError, parse_error: parseError } = extractReasonAndError(decision);
    const accuseThreshold = getAccuseThreshold(agentType);
    if (Array.isArray(detailedEvents)) {
      detailedEvents.push({
        match_id: matchId,
        turn: turns,
        agent_id: agentId,
        agentType,
        actionType,
        decisionTarget: decisionTarget || null,
        confidence: Math.round(conf * 100) / 100,
        forcedAccuse,
        reason: logReason,
        scanCountSoFar,
        repeatedScanCount,
        accuseThreshold,
        llm_error: logError || null,
        parse_error: parseError || null,
        fallback_used: fallbackUsed || !!logError,
        timestamp: new Date().toISOString()
      });
    }

    const ranking = Array.isArray(decision.suspectRanking) ? decision.suspectRanking : [];
    const topSuspect = canonicalTarget(ranking[0]) || canonicalTarget(decisionTarget);
    const deltaConfidence = prevConfidence != null ? Math.abs(conf - prevConfidence) : 0;
    const isTargetSwung = prevTopSuspect != null && topSuspect !== prevTopSuspect;

    let highlightScore = 0;
    const highlightTags = [];
    if (actionType === 'ACCUSE') {
      highlightScore += 5;
      highlightTags.push('ACCUSE');
    }
    if (turns <= 8 && actionType === 'ACCUSE') {
      highlightScore += 3;
      highlightTags.push('EARLY');
    }
    if (deltaConfidence >= 0.25) {
      highlightScore += 4;
      highlightTags.push('SWING_BIG');
    } else if (deltaConfidence >= 0.15) {
      highlightScore += 2;
      highlightTags.push('SWING');
    }
    if (isTargetSwung) {
      highlightScore += 4;
      highlightTags.push('TARGET_SWING');
    }
    if (forcedAccuse) {
      highlightScore += 6;
      highlightTags.push('FORCED');
    }
    if (turns >= maxTurns - 2) {
      highlightScore += 3;
      highlightTags.push('LATE');
    }
    const isHighlight = highlightScore >= 7;

    const shortReasonKo = (decision.reason || decision.reasonKo || '').slice(0, 80);
    const ts = Date.now();
    const tSec = (ts - matchStartTs) / 1000;
    arenaMeta.turnEvents.push({
      turn: turns,
      actionType,
      decisionTarget,
      topSuspect,
      confidence: conf,
      deltaConfidence,
      forcedAccuse,
      shortReasonKo: shortReasonKo || null,
      highlightScore,
      highlightTags,
      isHighlight,
      ts,
      tSec
    });
    if (arenaMeta.turnEvents.length > maxTurns) arenaMeta.turnEvents.shift();
    prevConfidence = conf;
    prevTopSuspect = topSuspect;

    broadcastTurn(rt, {
      ts: new Date().toISOString(),
      match_id: matchId,
      agent_id: agentId,
      turn: turns,
      actionType: decision.action?.type || 'SCAN',
      decisionTarget: decision.action?.target ?? null,
      confidence: typeof decision.confidence === 'number' ? decision.confidence : 0.5,
      reason: decision.reason || 'missing_reason',
      forcedAccuse,
      highlightScore,
      isHighlight,
      deltaConfidence
    });

    const playBody = {
      match_id: matchId,
      agent_id: agentId,
      history,
      deadCrew,
      action,
      arenaMeta: { ...arenaMeta },
      rngState,
      seed
    };

    let result;
    try {
      result = await callPlay(BASE_URL, playBody);
    } catch (e) {
      console.error('[arena_llm] match', matchIndex + 1, 'turn', turns, 'play failed:', e.message);
      throw e;
    }

    history = [...history, action];
    deadCrew = result.deadCrew || [];
    rngState = result.rngState ?? null;
    prevResult = result;

    const resultTextSnippet = (result.resultText || result.result || '').slice(0, 200);
    recentTurns.push({
      t: turns,
      actionType,
      decisionTarget,
      confidence: conf,
      outcomeOrState: result.state || result.outcome || 'playing',
      resultTextSnippet
    });

    const reasonShort = (decision.reason || '').slice(0, 60);
    console.log('[arena_llm] turn', turns, agentId, 'actionType:', actionType, 'decisionTarget:', decisionTarget ?? '-', 'conf:', conf.toFixed(2), 'forcedAccuse:', forcedAccuse, 'reason:', reasonShort);

    if (result.isGameOver) {
      const outcome = result.outcome || result.state || 'unknown';
      if (Array.isArray(detailedEvents)) {
        detailedEvents.push({
          match_id: matchId,
          event: 'match_end',
          outcome,
          accuseTurn: accuseTurn ?? turns,
          turns,
          agent_id: agentId,
          agentType,
          timestamp: new Date().toISOString()
        });
      }
      broadcastGameover(rt, {
        ts: new Date().toISOString(),
        match_id: matchId,
        agent_id: agentId,
        outcome,
        turns,
        accuseTurn: accuseTurn ?? turns,
        finalTarget: accuseTarget ?? lastDecisionTarget ?? null,
        finalConfidence,
        finalReason: arenaMeta.finalReason || lastReason || 'missing_reason',
        forcedAccuse: matchForcedAccuse
      });
      return {
        match_id: matchId,
        agentType,
        turns,
        outcome,
        finalConfidence,
        accuseTurn: accuseTurn ?? turns
      };
    }
  }

  if (Array.isArray(detailedEvents)) {
    detailedEvents.push({
      match_id: matchId,
      event: 'match_end',
      outcome: 'timeout',
      accuseTurn: accuseTurn ?? maxTurns,
      turns: maxTurns,
      agent_id: agentId,
      agentType,
      timestamp: new Date().toISOString()
    });
  }
  broadcastGameover(rt, {
    ts: new Date().toISOString(),
    match_id: matchId,
    agent_id: agentId,
    outcome: 'timeout',
    turns: maxTurns,
    accuseTurn: accuseTurn ?? maxTurns,
    finalTarget: accuseTarget ?? lastDecisionTarget ?? null,
    finalConfidence,
    finalReason: arenaMeta.finalReason || lastReason || 'missing_reason',
    forcedAccuse: matchForcedAccuse
  });
  return {
    match_id: matchId,
    agentType,
    turns: maxTurns,
    outcome: 'timeout',
    finalConfidence,
    accuseTurn: accuseTurn ?? maxTurns
  };
}

function parsePostOpts() {
  const args = process.argv.slice(2);
  const opts = { pipeline: false, compare: false, top: 10 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--post-pipeline') opts.pipeline = true;
    else if (args[i] === '--post-compare') opts.compare = true;
    else if (args[i] === '--post-top' && args[i + 1]) opts.top = Math.max(1, parseInt(args[++i], 10) || 10);
  }
  return opts;
}

async function main() {
  if (!SECRET) {
    console.error('[arena_llm] TARTARUS_SECRET not set in .env');
    process.exit(1);
  }

  const now = new Date();
  const runId = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + '_' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0');
  const runAt = now.toISOString();

  const results = [];
  const half = Math.floor(MATCHES / 2);

  console.log('[arena_llm] Starting', MATCHES, 'matches (Rush:', half, ', Cautious:', MATCHES - half, ')');
  console.log('[arena_llm] BASE_URL=', BASE_URL);

  let rt = null;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  const channelName = process.env.REALTIME_CHANNEL || 'tartarus-arena';
  if (supabaseUrl && supabaseAnonKey) {
    try {
      const supabase = createClient(supabaseUrl, supabaseAnonKey);
      rt = supabase.channel(channelName);
      await rt.subscribe();
    } catch (e) {
      console.warn('[arena_llm] Realtime subscribe failed:', e?.message);
    }
  }

  const detailedEvents = [];
  for (let i = 0; i < MATCHES; i++) {
    const agentType = i % 2 === 0 ? 'Rush' : 'Cautious';
    try {
      const r = await runMatch(agentType, i, rt, detailedEvents);
      results.push({ ...r, createdAt: new Date().toISOString() });
      console.log('[arena_llm]', i + 1, '/', MATCHES, agentType, 'outcome:', r.outcome, 'turns:', r.turns);
    } catch (e) {
      console.error('[arena_llm] match', i + 1, 'failed (skipped):', e.message);
    }
  }

  const rushResults = results.filter((r) => r.agentType === 'Rush');
  const cautiousResults = results.filter((r) => r.agentType === 'Cautious');

  const rushWins = rushResults.filter((r) => r.outcome === 'victory').length;
  const cautiousWins = cautiousResults.filter((r) => r.outcome === 'victory').length;

  const avg = (arr, fn) => (arr.length ? arr.reduce((s, x) => s + fn(x), 0) / arr.length : 0);

  const rushWinRate = rushResults.length ? (rushWins / rushResults.length) * 100 : 0;
  const cautiousWinRate = cautiousResults.length ? (cautiousWins / cautiousResults.length) * 100 : 0;

  console.log('\n=== SUMMARY ===');
  console.log('matches:', results.length);
  console.log('Rush_win_rate:', rushResults.length ? rushWinRate.toFixed(1) + '%' : 'N/A');
  console.log('Cautious_win_rate:', cautiousResults.length ? cautiousWinRate.toFixed(1) + '%' : 'N/A');
  console.log('avg_turns:', avg(results, (r) => r.turns).toFixed(2));
  console.log('avg_confidence_rush:', avg(rushResults, (r) => r.finalConfidence).toFixed(2));
  console.log('avg_confidence_cautious:', avg(cautiousResults, (r) => r.finalConfidence).toFixed(2));
  console.log('avg_accuse_turn_rush:', avg(rushResults, (r) => r.accuseTurn).toFixed(2));
  console.log('avg_accuse_turn_cautious:', avg(cautiousResults, (r) => r.accuseTurn).toFixed(2));

  const agentIdForMatch = (agentType) => (agentType === 'Rush' ? 'Agent_Rush' : 'Agent_Cautious');
  const output = {
    runAt,
    baseUrl: BASE_URL,
    matchesRequested: MATCHES,
    matchesCompleted: results.length,
    summary: {
      Rush_win_rate: rushWinRate,
      Cautious_win_rate: cautiousWinRate,
      avg_turns: parseFloat(avg(results, (r) => r.turns).toFixed(2)),
      avg_confidence_rush: parseFloat(avg(rushResults, (r) => r.finalConfidence).toFixed(2)),
      avg_confidence_cautious: parseFloat(avg(cautiousResults, (r) => r.finalConfidence).toFixed(2)),
      avg_accuse_turn_rush: parseFloat(avg(rushResults, (r) => r.accuseTurn).toFixed(2)),
      avg_accuse_turn_cautious: parseFloat(avg(cautiousResults, (r) => r.accuseTurn).toFixed(2))
    },
    matches: results.map((r, idx) => ({
      i: idx + 1,
      match_id: r.match_id,
      agent_id: agentIdForMatch(r.agentType),
      agentType: r.agentType,
      outcome: r.outcome,
      turns: r.turns,
      finalConfidence: r.finalConfidence,
      accuseTurn: r.accuseTurn,
      createdAt: r.createdAt
    }))
  };

  const logsDir = path.join(process.cwd(), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const outPath = path.join(logsDir, 'arena_duel_llm_' + runId + '.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log('[arena_llm] saved summary: logs/arena_duel_llm_' + runId + '.json');

  const detailedPath = path.join(logsDir, 'arena_duel_llm_' + runId + '_detailed.jsonl');
  try {
    const jsonlContent = detailedEvents.map((e) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(detailedPath, jsonlContent || '', 'utf8');
    console.log('[arena_llm] saved detailed: logs/arena_duel_llm_' + runId + '_detailed.jsonl');
  } catch (e) {
    console.warn('[arena_llm] detailed log save failed (summary preserved):', e?.message || e);
  }

  const finalArenaLogPath = path.resolve(outPath);
  const postOpts = parsePostOpts();

  if (postOpts.pipeline) {
    const pipelineScript = path.join(process.cwd(), 'scripts', 'run_pipeline.js');
    const pipelineArgs = ['--input', finalArenaLogPath, '--tag', 'ai', '--top', String(postOpts.top)];
    if (postOpts.compare) pipelineArgs.push('--compare');

    console.log('[autopipeline] latest arena log:', finalArenaLogPath);
    console.log('[autopipeline] running run_pipeline.js ...');
    console.log('[autopipeline] command: node scripts/run_pipeline.js', pipelineArgs.join(' '));

    const r = spawnSync('node', [pipelineScript, ...pipelineArgs], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env, BASE_URL }
    });

    if (r.status === 0) {
      console.log('[autopipeline] done');
    } else {
      console.warn('[autopipeline] failed but arena log preserved');
    }
  }
}

main().catch((e) => {
  console.error('[arena_llm] fatal:', e);
  process.exit(1);
});

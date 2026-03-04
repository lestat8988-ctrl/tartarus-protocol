/**
 * arena_duel_llm.js - LLM 기반 자동대전 오케스트레이터
 *
 * 사용법:
 *   npx vercel dev 켜고
 *   MATCHES=3 node arena_duel_llm.js
 *
 * action 포맷: arena_duel.js / api/play.js actionToEngineFormat()와 동일
 * - SCAN -> { type: 'interrogate' }
 * - ACCUSE -> { type: 'accuse', target: 'Navigator'|'Engineer'|'Doctor'|'Pilot' }
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const CREW = ['Navigator', 'Engineer', 'Doctor', 'Pilot'];
const TARGET_WHITELIST = ['Doctor', 'Engineer', 'Navigator'];
const FORCE_TURN = 20;
const MIN_TURN_FOR_CONF_FORCE = 10;
const CONF_FORCE = 0.85;
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const MATCHES = parseInt(process.env.MATCHES || '3', 10);
const SECRET = process.env.TARTARUS_SECRET;

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

function buildObservation(prevResult, turn) {
  if (!prevResult) {
    return `Turn ${turn}. Game start. Crew: ${CREW.join(', ')}. No dead crew. No previous results.`;
  }
  const text = (prevResult.resultText || prevResult.result || '').slice(0, 800);
  const dead = Array.isArray(prevResult.deadCrew) ? prevResult.deadCrew : [];
  const state = prevResult.state || 'playing';
  return `Turn ${turn}. Previous result (${state}):\n${text}\n\nDead crew: ${dead.join(', ') || 'none'}`;
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

async function runMatch(agentType, matchIndex, rt) {
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

    const obsText = buildObservation(prevResult, turns);
    const observation = { text: obsText, recentTurns: recentTurns.slice(-3) };

    let decision;
    try {
      decision = await callAgentDecide(BASE_URL, {
        match_id: matchId,
        agent_id: agentId,
        turn: turns,
        observation,
        policy
      });
    } catch (e) {
      decision = { action: { type: 'SCAN', target: null }, confidence: 0.5, reason: 'decide_failed', suspectRanking: [] };
    }

    const modelAction = String(decision.action?.type || 'SCAN').toUpperCase();
    const modelTarget = decision.action?.target != null ? decision.action.target : null;
    const conf = typeof decision.confidence === 'number' && !Number.isNaN(decision.confidence)
      ? Math.max(0, Math.min(1, decision.confidence))
      : 0.5;
    arenaMeta.finalConfidence = conf;
    finalConfidence = conf;

    // 강제고발: Rush/Cautious 공통, 매 턴 실행. Agent_Rush도 turn 20/25에서 forcedAccuse:true
    const shouldForce = (turns >= FORCE_TURN) || (turns >= MIN_TURN_FOR_CONF_FORCE && conf >= CONF_FORCE) || (turns >= maxTurns);
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

  for (let i = 0; i < MATCHES; i++) {
    const agentType = i % 2 === 0 ? 'Rush' : 'Cautious';
    try {
      const r = await runMatch(agentType, i, rt);
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
  console.log('[arena_llm] saved: logs/arena_duel_llm_' + runId + '.json');
}

main().catch((e) => {
  console.error('[arena_llm] fatal:', e);
  process.exit(1);
});

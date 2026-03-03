const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const engineMod = require('../src/engine/TartarusEngine');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;
const TartarusEngine = engineMod.TartarusEngine || engineMod.default?.TartarusEngine || engineMod;
const GAME_DATA = engineMod.GAME_DATA || engineMod.default?.GAME_DATA;

// Response should not reveal imposter unless EXPOSE_IMPOSTER=1
// Logs may include imposter for debugging
function normalizeToV1(engineResult) {
  let resultText = engineResult.resultText ?? engineResult.result ?? engineResult.text ?? '';
  const isGameOver = !!engineResult.isGameOver;

  if (process.env.EXPOSE_IMPOSTER !== '1') {
    resultText = resultText
      .split('\n')
      .filter(function (line) {
        const l = line.toUpperCase();
        return l.indexOf('[REAL_IMPOSTER:') === -1 && l.indexOf('REAL_IMPOSTER:') === -1 && l.indexOf('REAL IMPOSTER IDENTITY CODE') === -1;
      })
      .join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  let state = engineResult.state;
  let outcome = engineResult.outcome ?? null;

  if (!isGameOver) {
    state = 'playing';
    outcome = null;
  } else if (!state || state === 'playing') {
    const lower = String(resultText).toLowerCase();
    if (lower.includes('victory') || lower.includes('white fluid') || lower.includes('[result: victory]')) {
      state = 'victory';
      outcome = 'victory';
    } else if (lower.includes('defeat') || lower.includes('innocent') || lower.includes('[result: defeat]') || lower.includes('total system failure')) {
      state = 'defeat';
      outcome = 'defeat';
    } else {
      state = 'defeat';
      outcome = 'defeat';
    }
  } else if (state === 'victory') {
    outcome = outcome ?? 'victory';
  } else if (state === 'defeat') {
    outcome = outcome ?? 'defeat';
  }

  return {
    ok: true,
    protocolVersion: '1.0',
    resultText,
    isGameOver,
    state,
    outcome,
    deadCrew: Array.isArray(engineResult.deadCrew) ? engineResult.deadCrew : [],
    rngState: engineResult.rngState ?? null,
    ...engineResult,
    resultText,
    actualImposter: process.env.EXPOSE_IMPOSTER === '1' ? (engineResult.actualImposter ?? null) : null
  };
}

function actionToEngineFormat(act) {
  if (!act || typeof act !== 'object') return null;
  const t = act.type || 'message';
  if (t === 'accuse') return { type: 'accuse', target: act.target || '' };
  if (t === 'cctv') return { type: 'message', text: 'CCTV' };
  if (t === 'interrogate') return { type: 'message', text: 'INTERROGATE' };
  if (t === 'message') return { type: 'message', text: act.value || act.text || '' };
  return { type: 'message', text: act.value || '' };
}

function handleAutoKill(action, bodyDeadCrew) {
  const target = (action.target || '').trim();
  const crew = GAME_DATA?.crew || ['Navigator', 'Engineer', 'Doctor', 'Pilot'];
  let deadCrew = Array.isArray(bodyDeadCrew) ? bodyDeadCrew.slice() : [];
  if (target && !deadCrew.includes(target)) deadCrew.push(target);

  let resultText = (GAME_DATA?.killDescriptions && GAME_DATA.killDescriptions[target]) || `System: [EMERGENCY ALERT] ${target} terminated. [End of execution]`;

  const alive = crew.filter((c) => !deadCrew.includes(c) && c !== target);
  if (alive.length > 0 && Math.random() < 0.6) {
    const witness = alive[Math.floor(Math.random() * alive.length)];
    const testimonies = GAME_DATA?.witnessTestimonies?.[witness];
    if (testimonies && testimonies.length > 0) {
      resultText += '\n' + testimonies[Math.floor(Math.random() * testimonies.length)];
    }
  }

  return { resultText, deadCrew, isGameOver: false, state: 'playing', outcome: null, actualImposter: null, rngState: null };
}

function handleWitness(action) {
  const witness = action.witness || '';
  const testimonies = GAME_DATA?.witnessTestimonies?.[witness];
  let resultText = (testimonies && testimonies.length > 0)
    ? testimonies[Math.floor(Math.random() * testimonies.length)]
    : (action.value ? String(action.value) : 'System: No testimony available.');
  return { resultText, deadCrew: [], isGameOver: false, state: 'playing', outcome: null, actualImposter: null, rngState: null };
}

let _logPathLogged = false;

function buildLabelKo(tags, actionType) {
  if (tags && tags.includes('FORCED')) return '강제 고발 발동';
  if (tags && tags.includes('EARLY') && actionType === 'ACCUSE') return '초반 결단 고발';
  if (tags && tags.includes('TARGET_SWING')) return '1순위 스윙';
  if (tags && tags.includes('SWING_BIG')) return '확신도 대스윙';
  if (tags && tags.includes('SWING')) return '확신도 스윙';
  if (actionType === 'ACCUSE') return '고발';
  return '스캔';
}

function buildHighlights(turnEvents, outcome) {
  if (!Array.isArray(turnEvents) || turnEvents.length === 0) return [];
  const sorted = [...turnEvents].sort((a, b) => (b.highlightScore || 0) - (a.highlightScore || 0));
  const peaks = sorted.slice(0, 3);
  const used = new Set();
  const highlights = [];
  for (const p of peaks) {
    const peakTurn = p.turn;
    if (used.has(peakTurn)) continue;
    for (let t = Math.max(1, peakTurn - 1); t <= peakTurn + 1; t++) used.add(t);
    const fromTurn = Math.max(1, peakTurn - 1);
    const toTurn = peakTurn + 1;
    const evt = turnEvents.find((e) => e.turn === peakTurn) || p;
    highlights.push({
      peakTurn,
      peakScore: evt.highlightScore || 0,
      fromTurn,
      toTurn,
      labelKo: buildLabelKo(evt.highlightTags, evt.actionType),
      card: {
        titleKo: `턴 ${peakTurn}`,
        target: evt.decisionTarget || evt.topSuspect || null,
        confidence: evt.confidence ?? null,
        shortReasonKo: evt.shortReasonKo || null,
        stampSec: evt.tSec ?? null,
        outcome: outcome || null
      }
    });
  }
  return highlights;
}

function buildSafeArenaMeta(inMeta, outcome) {
  const m = inMeta && typeof inMeta === 'object' ? inMeta : {};
  const forcedAccuse = !!(m.forcedAccuse ?? m.forced_accuse ?? false);
  const rawTurn = m.forcedAccuseTurn ?? m.forced_accuse_turn;
  const forcedAccuseTurn = (typeof rawTurn === 'number' && !Number.isNaN(rawTurn)) ? rawTurn : null;
  const turnEvents = Array.isArray(m.turnEvents) ? m.turnEvents : [];
  const highlights = buildHighlights(turnEvents, outcome);
  const top = highlights[0];
  const highlightTopScore = top ? top.peakScore : (m.highlightTopScore ?? 0);
  const highlightTopLabelKo = top ? top.labelKo : (m.highlightTopLabelKo ?? null);
  return { ...m, forcedAccuse, forcedAccuseTurn, highlights, highlightTopScore, highlightTopLabelKo };
}

async function saveMatchIfGameOver(body, result) {
  if (!supabase || !result || result.isGameOver !== true) return;
  const matchId = body?.match_id ?? body?.matchId ?? 'match_' + Date.now() + '_' + Math.random().toString(16).slice(2);
  const agentId = body?.agent_id ?? body?.agentId ?? 'unknown';
  const outcome = result.outcome || result.state || null;
  const safeArenaMeta = buildSafeArenaMeta(body.arenaMeta ?? {}, outcome);
  const payload = { savedAt: new Date().toISOString(), response: result, arenaMeta: safeArenaMeta };

  console.log('[api/play] game over -> save match', matchId);
  const { error } = await supabase.from('match_logs').upsert([{ match_id: matchId, agent_id: agentId, payload }], { onConflict: 'match_id' });
  if (error) throw error;
}

async function appendLog(entry) {
  try {
    const logsDir = path.join(process.cwd(), 'logs');
    await fs.promises.mkdir(logsDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const logPath = path.join(logsDir, 'tartarus_' + dateStr + '.jsonl');
    if (!_logPathLogged) {
      console.log('[log] file=', logPath);
      _logPathLogged = true;
    }
    const line = JSON.stringify(entry) + '\n';
    await fs.promises.appendFile(logPath, line);
  } catch (e) {
    console.error('[api/play] log append failed:', e?.message);
  }
}

module.exports = async (req, res) => {
  // (선택) CORS 프리플라이트 대응
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-tartarus-secret');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Method Not Allowed' } });
  }

  const secret = req.headers['x-tartarus-secret'];
  if (!secret || secret !== process.env.TARTARUS_SECRET) {
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
  }

  try {
    let body = {};

    // 중요: req.body 접근 자체가 throw 할 수 있으므로 try 내부에서 1회만 접근
    try {
      const raw = req.body;

      if (raw == null) {
        body = {};
      } else if (Buffer.isBuffer(raw)) {
        body = JSON.parse(raw.toString('utf8'));
      } else if (typeof raw === 'string') {
        body = JSON.parse(raw);
      } else if (typeof raw === 'object') {
        body = raw;
      } else {
        body = {};
      }
    } catch (e) {
      console.error('[api/play] invalid json body:', e?.message || e);
      return res.status(400).json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } });
    }

    const history = Array.isArray(body.history) ? body.history : [];
    const rngState = body.rngState ?? null;
    const action = body.action ?? null;
    const seed = body.seed ?? 'default';
    const bodyDeadCrew = Array.isArray(body.deadCrew) ? body.deadCrew : [];

    let rawResult;

    if (action && action.type === 'auto-kill') {
      rawResult = handleAutoKill(action, bodyDeadCrew);
    } else if (action && action.type === 'witness') {
      rawResult = handleWitness(action);
      rawResult.deadCrew = bodyDeadCrew;
    } else {
      const engineHistory = history.map(actionToEngineFormat).filter(Boolean);
      const engineAction = action ? actionToEngineFormat(action) : null;
      const nextHistory = engineAction ? [...engineHistory, engineAction] : engineHistory;

      const engine = new TartarusEngine({ seed, rngState });
      rawResult = engine.calculateNextState({ history: nextHistory, rngState });

      const mergedDeadCrew = [...new Set([...(rawResult.deadCrew || []), ...bodyDeadCrew])];
      rawResult.deadCrew = mergedDeadCrew;
    }

    const result = normalizeToV1(rawResult);

    // Logs may include imposter for debugging
    await appendLog({
      serverTimestamp: new Date().toISOString(),
      roomId: body.roomId,
      gameId: body.gameId,
      turnId: body.turnId,
      seed: body.seed,
      agent: body.agent,
      reason: body.reason,
      confidence: body.confidence,
      suspectRanking: body.suspectRanking,
      action: action ?? null,
      state: result.state,
      outcome: result.outcome,
      isGameOver: result.isGameOver,
      deadCrew: result.deadCrew,
      rngState: result.rngState,
      actualImposterLog: rawResult.actualImposter ?? null,
      resultTextLog: rawResult.resultText ?? rawResult.result ?? ''
    });

    try {
      if (result && result.isGameOver) await saveMatchIfGameOver(body, result);
    } catch (e) {
      console.error('[api/play] saveMatchIfGameOver failed:', e);
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('[api/play] internal error:', err);
    return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: err?.message || 'Internal Server Error' } });
  }
};
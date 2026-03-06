const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const engineMod = require('../src/engine/TartarusEngine');
const { generateMatchConfig } = require('../src/engine/evidence/generate_match_config');
const { buildFreeQuestionResponse } = require('../src/engine/evidence/free_question'); // PATCH
const { getPackById } = require('../src/engine/evidence/incident_packs');
const { lineMentionsDeadRoles, filterTestimoniesForAlive, simpleHash } = require('../src/engine/evidence/suspect_utils');
console.log('[free_question] version =', buildFreeQuestionResponse?.__version || 'UNKNOWN'); // PATCH

// PATCH [1] ROLE_MAP / normalizeRole - 대문자(NAVIGATOR/ENGINEER/DOCTOR/PILOT) 반환
const ROLE_MAP = { NAVIGATOR: 'NAVIGATOR', ENGINEER: 'ENGINEER', DOCTOR: 'DOCTOR', PILOT: 'PILOT' };
function normalizeRole(r) {
  if (!r || typeof r !== 'string') return 'ENGINEER'; // PATCH
  const key = String(r).trim().toUpperCase().replace(/\s+/g, '').replace(/_/g, '');
  if (ROLE_MAP[key]) return ROLE_MAP[key]; // PATCH
  const match = Object.keys(ROLE_MAP).find((k) => k.startsWith(key) || key.startsWith(k));
  return match ? ROLE_MAP[match] : 'ENGINEER'; // PATCH
}

// PATCH hint_command 표시용 (Interrogate/CCTV/Engine -> sync/nav/time)
const HINT_TO_CMD = { Interrogate: 'sync', CCTV: 'nav', Engine: 'time' }; // PATCH

function normalize(text) { return String(text || '').trim().toLowerCase(); } // PATCH
function isEvidenceCommand(text, cfg) { // PATCH
  const n = normalize(text);
  const first = (n.split(/\s+/)[0] || '');
  const fixed = ['interrogate', 'cctv', 'engine', 'nav', 'time', 'sync'];
  if (fixed.includes(first)) return true;
  const cfgCmds = (cfg?.commands || []).map((c) => normalize(c));
  if (cfgCmds.includes(first)) return true;
  return false;
}

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

function normalizeCfgForPlay(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  const c = { ...cfg };
  if (c.primary && c.primary.text) c.primary = { ...c.primary, lines: [c.primary.text] };
  if (c.evidence) {
    const e = c.evidence;
    const rh1 = e.Interrogate || e.rh1;
    const rh2 = e.CCTV || e.rh2;
    const ex = e.Engine || e.ex;
    c.evidence = {
      rh1: { lines: Array.isArray(rh1?.lines) ? rh1.lines : (rh1?.text ? [rh1.text] : []) },
      rh2: { lines: Array.isArray(rh2?.lines) ? rh2.lines : (rh2?.text ? [rh2.text] : []) },
      ex: { lines: Array.isArray(ex?.lines) ? ex.lines : (ex?.text ? [ex.text] : []) }
    };
  }
  c.commands = c.commands || ['Interrogate', 'CCTV', 'Engine'];
  return c;
}

// 6채널 분리: interrogate|sync|cctv|nav|engine|time (매핑 없이 그대로 사용)
function getEvidenceFromCfg(cfg, commandText, deadCrew, evidenceRequestCount) {
  if (!cfg) return null;
  const cmd = String(commandText || '').toLowerCase().trim();

  const toLines = (arr) => (Array.isArray(arr) ? arr : [arr].filter(Boolean)).map(String);

  // primary는 sync|nav|time만 (터미널 채널)
  const primaryCmd = String(cfg.primary?.command || '').toLowerCase();
  if (primaryCmd && (cmd === 'sync' || cmd === 'nav' || cmd === 'time') && cmd === primaryCmd) {
    const truePool = cfg.primary?.truePool;
    const redPool = cfg.primary?.redPool;
    const reqCount = Math.max(0, parseInt(evidenceRequestCount, 10) || 0);
    if (Array.isArray(truePool) && Array.isArray(redPool) && truePool.length > 0 && redPool.length > 0) {
      const trueIdx = reqCount % truePool.length;
      const redIdx = (reqCount + Math.floor(reqCount / truePool.length)) % redPool.length;
      const orderSwap = (reqCount >> 1) % 2;
      const trueLine = truePool[trueIdx];
      const redLine = redPool[redIdx];
      const lines = orderSwap ? [redLine, trueLine] : [trueLine, redLine];
      return toLines(lines).join('\n');
    }
    const lines = cfg.primary?.lines;
    if (lines && Array.isArray(lines) && lines.length > 0) return toLines(lines).join('\n');
    return cfg.primary?.text != null ? String(cfg.primary.text) : '';
  }
  // evidence.sync|cctv|nav|engine|time (Incident Pack 스키마)
  const ev = cfg.evidence?.[cmd];
  if (ev) {
    let lines = ev.lines || (ev.text ? [ev.text] : []);
    const reqCount = Math.max(0, parseInt(evidenceRequestCount, 10) || 0);
    const L = Array.isArray(lines) ? lines.length : 0;
    let outLines = lines;
    if (L > 1) {
      const i0 = reqCount % L;
      const i1 = (reqCount + 1) % L;
      outLines = i0 === i1 ? [lines[i0]] : [lines[i0], lines[i1]];
    }
    const rawText = Array.isArray(outLines) ? outLines[0] : outLines;
    const dead = Array.isArray(deadCrew) ? deadCrew : [];
    if (dead.length > 0 && rawText && lineMentionsDeadRoles(rawText, dead)) {
      const packId = cfg.packId || cfg.pack || 'A';
      try {
        const pack = getPackById(packId);
        const pool = [];
        for (const r of (pack.redHerringByRole && Object.keys(pack.redHerringByRole)) || []) {
          const arr = pack.redHerringByRole[r];
          if (Array.isArray(arr)) pool.push(...arr);
        }
        const ok = pool.filter((l) => !lineMentionsDeadRoles(l, dead));
        const pick = ok.length > 0 ? ok : pool;
        const idx = simpleHash(String(cfg.seed || '') + '|' + cmd + '|' + dead.join(',')) % pick.length;
        outLines = [pick[idx]];
      } catch (_) { /* fallback to original */ }
    }
    return toLines(outLines).join('\n');
  }
  const extKeys = Object.keys(cfg.extrasByCommand || {});
  const extKey = extKeys.find((k) => k.toLowerCase() === cmd);
  if (extKey) {
    const ext = cfg.extrasByCommand[extKey];
    return typeof ext === 'string' ? ext : (ext?.hint ? `[SYSTEM] Hint: ${ext.hint}` : JSON.stringify(ext));
  }
  return null;
}

function actionToEngineFormat(act) {
  if (!act || typeof act !== 'object') return null;
  const t = act.type || 'message';
  if (t === 'accuse') return { type: 'accuse', target: act.target || '' };
  if (t === 'cctv') return { type: 'message', text: 'CCTV' };
  if (t === 'interrogate') return { type: 'message', text: 'INTERROGATE' };
  if (t === 'engine') return { type: 'message', text: 'ENGINE' };
  if (t === 'message') return { type: 'message', text: act.value || act.text || '' };
  return { type: 'message', text: act.value || '' };
}

function handleAutoKill(action, bodyDeadCrew, lastWitnessLine) {
  const target = (action.target || '').trim();
  const crew = GAME_DATA?.crew || ['Navigator', 'Engineer', 'Doctor', 'Pilot'];
  let deadCrew = Array.isArray(bodyDeadCrew) ? bodyDeadCrew.slice() : [];
  if (target && !deadCrew.includes(target)) deadCrew.push(target);

  let resultText = (GAME_DATA?.killDescriptions && GAME_DATA.killDescriptions[target]) || `System: [EMERGENCY ALERT] ${target} terminated. [End of execution]`;

  const alive = crew.filter((c) => !deadCrew.includes(c) && c !== target);
  if (alive.length > 0 && Math.random() < 0.6) {
    const witness = alive[Math.floor(Math.random() * alive.length)];
    const raw = GAME_DATA?.witnessTestimonies?.[witness];
    const testimonies = filterTestimoniesForAlive(raw || [], deadCrew, lastWitnessLine);
    if (testimonies && testimonies.length > 0) {
      resultText += '\n' + testimonies[Math.floor(Math.random() * testimonies.length)];
    }
  }

  return { resultText, deadCrew, isGameOver: false, state: 'playing', outcome: null, actualImposter: null, rngState: null };
}

function handleWitness(action, bodyDeadCrew, lastWitnessLine) {
  const witness = action.witness || '';
  const deadCrew = Array.isArray(bodyDeadCrew) ? bodyDeadCrew : [];
  const raw = GAME_DATA?.witnessTestimonies?.[witness];
  const testimonies = filterTestimoniesForAlive(raw || [], deadCrew, lastWitnessLine);
  let resultText = (testimonies && testimonies.length > 0)
    ? testimonies[Math.floor(Math.random() * testimonies.length)]
    : (action.value ? String(action.value) : 'System: No testimony available.');
  return { resultText, deadCrew: bodyDeadCrew || [], isGameOver: false, state: 'playing', outcome: null, actualImposter: null, rngState: null };
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
    const action = body.action ?? body.actionType ?? null;
    const seed = body.seed ?? 'default';
    const bodyDeadCrew = Array.isArray(body.deadCrew) ? body.deadCrew : [];

    const query = req.query || {};
    const debug = query.debug === '1' || query.debug === 'true';
    const rawPack = debug ? (query.pack || query.packId || 'A') : (body.packId ?? body.pack ?? 'A');
    // pack=F_NAV_CLOCK_DRIFT → 그대로 packId; pack=F(한 글자) → PACKS 키 중 해당 글자로 매핑 // PATCH
    const packId = (String(rawPack).trim() || 'A');
    const impostorParam = debug ? (query.impostor || query.impostorRole) : (body.impostorRole ?? body.impostor ?? null);
    const seedOverride = debug ? (query.seed || body.seed) : body.seed;

    let cfg = body.match_config && typeof body.match_config === 'object' ? body.match_config : null;
    if (!cfg) {
      let impostorRole = 'Engineer';
      const effectiveSeed = (seedOverride || seed || 'default') + ':' + (body.match_id || body.matchId || '');
      if (impostorParam) {
        const role = String(impostorParam).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        impostorRole = ['Navigator', 'Engineer', 'Doctor', 'Pilot'].find((r) => r.toLowerCase() === role.toLowerCase()) || impostorRole;
      } else {
        const eng = new TartarusEngine({ seed: effectiveSeed });
        const pick = eng.calculateNextState({ history: [{ type: 'message', text: '_' }] });
        impostorRole = pick.actualImposter || impostorRole;
      }
      impostorRole = normalizeRole(impostorRole); // PATCH [1]
      cfg = generateMatchConfig({ seed: effectiveSeed, packId, impostorRole });
    }
    // cfg는 generateMatchConfig 결과 그대로 유지 (구 스키마 변환 제거) // PATCH
    if (cfg?.primary?.command) {
      const pnorm = String(cfg.primary.command).toLowerCase().trim(); // PATCH
      cfg.primary = { ...cfg.primary, command: pnorm }; // PATCH
      cfg.hint_command = pnorm; // PATCH: hint_command = primary.command
    }

    let rawResult;

    const lastWitnessLine = (body.lastWitnessLine || body.lastWitness || '').toString().trim();
    if (action && action.type === 'auto-kill') {
      rawResult = handleAutoKill(action, bodyDeadCrew, lastWitnessLine);
    } else if (action && action.type === 'witness') {
      rawResult = handleWitness(action, bodyDeadCrew, lastWitnessLine);
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

    let result = normalizeToV1(rawResult);

    // PATCH [3] cmd 파싱 단순/안전, engine 버튼 확실 처리
    const actType = (action?.type || action?.actionType || (typeof action === 'string' ? 'message' : '')).toString().toLowerCase();
    const actTextRaw = (action?.text ?? action?.value ?? action?.content ?? action?.message ?? (typeof action === 'string' ? action : body.message ?? body.userInput ?? body.text ?? '')).toString();
    const actText = actTextRaw.trim();

    let cmdForCfg = actType;
    if (actType === 'message') {
      const first = (actText.split(/\s+/)[0] || '').toLowerCase();
      if (/engine/i.test(actTextRaw)) cmdForCfg = 'engine';
      else if (/interrogate|status|report/i.test(actTextRaw)) cmdForCfg = 'interrogate';
      else if (/cctv/i.test(actTextRaw)) cmdForCfg = 'cctv';
      else cmdForCfg = first;
    } else if (actType === 'interrogate') {
      cmdForCfg = 'interrogate';
    } else if (actType === 'cctv') {
      cmdForCfg = 'cctv';
    } else if (actType === 'engine') {
      cmdForCfg = 'engine';
    }

    const isEvidenceCmd = (actType === 'interrogate' || actType === 'cctv' || actType === 'engine') || (actType === 'message' && isEvidenceCommand(actText, cfg)); // PATCH: message는 isEvidenceCommand일 때만 커맨드

    if (cfg && isEvidenceCmd && !result.isGameOver) {
      const mergedDead = result.deadCrew || bodyDeadCrew || [];
      const evidenceReqCount = parseInt(body.evidenceRequestCount, 10) || 0;
      const evidenceText = getEvidenceFromCfg(cfg, cmdForCfg, mergedDead, evidenceReqCount);
      if (evidenceText) {
        result = { ...result, resultText: evidenceText, result: evidenceText, text: evidenceText }; // PATCH
      }
    }

    const isFreeQuestion = actType === 'message' && !!actText && !isEvidenceCommand(actText, cfg);
    if (isFreeQuestion && cfg && !result.isGameOver) {
      const freeText = buildFreeQuestionResponse({
        cfg,
        question: actText,
        lang: body.lang || 'en',
        deadCrew: rawResult.deadCrew || [],
        turnId: body.turnId ?? 0
      });
      console.log('[free_question] hit', { question: actText.slice(0, 30), turnId: body.turnId, match_id: body.match_id });
      result = { ...result, resultText: freeText, result: freeText, text: freeText };
    }

    result.match_config = cfg; // PATCH: cfg 그대로 (commands=time/sync/nav, primary.command=sync|time|nav)

    // auto-kill/witness여도 actualImposterLog 항상 채움 (UI에는 노출 안 함) // PATCH
    const impostorForLog = rawResult.actualImposter || rawResult.actual_imposter || cfg?.impostorRole || cfg?.impostor_role || result.match_config?.impostorRole || result.match_config?.impostor_role || null; // PATCH

    // Logs may include imposter for debugging
    await appendLog({
      serverTimestamp: new Date().toISOString(),
      match_id: body.match_id ?? null, // PATCH: replay key
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
      actualImposterLog: impostorForLog, // PATCH
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
/**
 * api/agent_decide.js - LLM 의사결정 API (OpenAI 기본, OpenRouter 옵션)
 * POST body: { match_id, agent_id, turn, observation, policy }
 * 응답: { action, confidence, reason, suspectRanking }
 */
const provider = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
const SECRET = process.env.TARTARUS_SECRET;
const TIMEOUT_MS = 8000;

const CREW = ['Navigator', 'Engineer', 'Doctor', 'Pilot'];
const allowedTargets = ['Doctor', 'Engineer', 'Navigator'];

function fallback(reason) {
  return {
    action: { type: 'SCAN', target: null },
    confidence: 0.5,
    reason,
    suspectRanking: []
  };
}

function isAllowedTarget(t) {
  if (!t || typeof t !== 'string') return false;
  const s = String(t).trim();
  return allowedTargets.some((c) => c.toLowerCase() === s.toLowerCase());
}

function pickTarget(rawTarget, rankingNormalized) {
  const s = String(rawTarget || '').trim();
  const found = allowedTargets.find((c) => c.toLowerCase() === s.toLowerCase());
  if (found) return found;
  if (rankingNormalized[0]) return rankingNormalized[0];
  return 'Doctor';
}

function normalizeRanking(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  const valid = arr.filter((r) => isAllowedTarget(r));
  const seen = new Set();
  const result = [];
  for (const r of valid) {
    const canon = allowedTargets.find((c) => c.toLowerCase() === String(r || '').trim().toLowerCase());
    if (canon && !seen.has(canon)) {
      result.push(canon);
      seen.add(canon);
    }
  }
  for (const t of allowedTargets) {
    if (!seen.has(t)) result.push(t);
  }
  return result;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

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
  if (!secret || secret !== SECRET) {
    return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } });
  }

  let body = {};
  try {
    const raw = req.body;
    if (raw == null) body = {};
    else if (Buffer.isBuffer(raw)) body = JSON.parse(raw.toString('utf8'));
    else if (typeof raw === 'string') body = JSON.parse(raw);
    else if (typeof raw === 'object') body = raw;
  } catch {
    return res.status(400).json({ ok: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } });
  }

  const turn = body.turn ?? 1;
  const obsRaw = body.observation;
  const obsText = typeof obsRaw === 'string' ? obsRaw : (obsRaw?.text || obsRaw?.observation || '');
  const recentTurns = Array.isArray(obsRaw?.recentTurns) ? obsRaw.recentTurns : [];
  const recentTurnsText = recentTurns.length > 0
    ? '\n\nRecent turns:\n' + recentTurns.map((t) => `Turn ${t.t}: ${t.actionType}${t.decisionTarget ? ' ' + t.decisionTarget : ''} conf=${t.confidence} -> ${t.outcomeOrState || 'playing'}\n${t.resultTextSnippet || ''}`).join('\n---\n')
    : '';
  const observation = obsText + recentTurnsText;
  const policy = body.policy || 'CAUTIOUS';

  const rushRules = policy === 'RUSH' ? `

RUSH policy (MANDATORY - you MUST follow):
- Turn 1~3: SCAN is allowed.
- Turn 4~5: If confidence >= 0.70, PREFER ACCUSE over SCAN.
- Turn 6~7: ACCUSE is the DEFAULT choice unless you have a strong reason to SCAN.
- Turn >= 8: You MUST return ACCUSE. Never return SCAN. Pick your top suspect from whitelist. Set confidence >= 0.70.
- reason: max 120 chars, short and direct. Do NOT add [FORCED_ACCUSE] or similar tags.` : '';

  const systemPrompt = `You are an AI agent playing a deduction game. Crew: ${CREW.join(', ')}.
Your ONLY valid actions: SCAN (gather info) or ACCUSE (accuse a crew member).
Policy: ${policy}. RUSH = accuse sooner. CAUTIOUS = gather more info before accusing.
Output rules (STRICT):
- target MUST be one of ["Doctor","Engineer","Navigator"] only. Pilot is NOT a valid ACCUSE target.
- ACCUSE: target is REQUIRED, NEVER null or empty. Must be in whitelist.
- SCAN: confidence MUST be 0.00~0.84. target MUST be null.
- confidence >= 0.85: action.type MUST be ACCUSE.
- If you cannot specify a valid target, use SCAN. Do NOT output ACCUSE with target null.
- suspectRanking: array of role names. MUST include all 3: Doctor, Engineer, Navigator. Never empty.
Respond with STRICT JSON only, no markdown or extra text.${rushRules}`;

  const userPrompt = `Turn ${turn}. Observation:\n${observation}\n\nRespond with exactly this JSON (output JSON only):
{"action":{"type":"SCAN"|"ACCUSE","target":null for SCAN, or "Doctor"|"Engineer"|"Navigator" for ACCUSE},"confidence":0.00-0.84 for SCAN, 0.85-1.00 for ACCUSE,"reason":"brief reason","suspectRanking":["Doctor","Engineer","Navigator"]}`;

  const requestBody = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
    max_tokens: 250
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const prefix = provider === 'openrouter' ? 'openrouter' : 'openai';

  function parseAndReturn(content) {
    let resp;
    try {
      resp = JSON.parse(content);
    } catch {
      console.error('[agent_decide] parse_failed content:', (content || '').slice(0, 300));
      return res.status(200).json(fallback('parse_failed'));
    }
    if (!resp || typeof resp !== 'object') {
      return res.status(200).json(fallback('parse_failed'));
    }

    let actionType = (resp.action?.type || 'SCAN').toUpperCase();
    if (actionType !== 'ACCUSE') actionType = 'SCAN';
    const rawTarget = resp.action?.target ?? null;
    let conf = typeof resp.confidence === 'number' && !Number.isNaN(resp.confidence) ? resp.confidence : 0.5;
    const reason = String(resp.reason || '').slice(0, 120);
    const rankingRaw = Array.isArray(resp.suspectRanking) ? resp.suspectRanking : [];
    const rankingNormalized = normalizeRanking(rankingRaw);

    if (policy === 'RUSH' && turn >= 8) {
      actionType = 'ACCUSE';
      const target = pickTarget(rawTarget, rankingNormalized);
      conf = Math.max(Math.min(Math.max(Number(conf) || 0, 0), 1), 0.70);
      return res.status(200).json({
        action: { type: actionType, target },
        confidence: conf,
        reason,
        suspectRanking: rankingNormalized
      });
    }

    conf = Math.min(Math.max(Number(conf) || 0.5, 0), 1);
    const target = actionType === 'ACCUSE' ? pickTarget(rawTarget, rankingNormalized) : null;
    return res.status(200).json({
      action: { type: actionType, target },
      confidence: conf,
      reason,
      suspectRanking: rankingNormalized
    });
  }

  try {
    if (provider === 'openrouter') {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        return res.status(200).json(fallback('missing_openrouter_key'));
      }
      const base = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
      const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';
      const res2 = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...requestBody, model })
      });
      clearTimeout(timeoutId);

      if (!res2.ok) {
        const text = await res2.text().catch(() => '');
        console.error(`[agent_decide] openrouter HTTP ${res2.status}:`, text.slice(0, 300));
        return res.status(200).json(fallback(`openrouter_http_${res2.status}`));
      }

      const data = await res2.json().catch(() => ({}));
      const content = data?.choices?.[0]?.message?.content || '';
      return parseAndReturn(content);
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(200).json(fallback('missing_openai_key'));
    }
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const res2 = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ...requestBody, model })
    });
    clearTimeout(timeoutId);

    if (!res2.ok) {
      const text = await res2.text().catch(() => '');
      console.error(`[agent_decide] openai HTTP ${res2.status}:`, text.slice(0, 300));
      return res.status(200).json(fallback(`openai_http_${res2.status}`));
    }

    const data = await res2.json().catch(() => ({}));
    const content = data?.choices?.[0]?.message?.content || '';
    return parseAndReturn(content);
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      return res.status(200).json(fallback(`${prefix}_timeout`));
    }
    return res.status(200).json(fallback(`${prefix}_error`));
  }
};

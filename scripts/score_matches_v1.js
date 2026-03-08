#!/usr/bin/env node
/**
 * score_matches_v1.js - 자동대전/인간 플레이 로그에서 match별 재미 점수 계산
 *
 * 인간(WEB_UI) vs AI(Agent_*) 플레이 타입별로 점수 규칙 분기
 * AI 몰입 보너스: 추적형 질문, 채널 연계, 맥락 해석 등
 * 출력: outputs/fun_scores.json, outputs/fun_scores.csv, outputs/top_matches.json
 */
const fs = require('fs');
const path = require('path');

const USER_ACTION_TYPES = new Set(['message', 'interrogate', 'cctv', 'engine', 'accuse']);
const CHANNELS = new Set(['nav', 'sync', 'time', 'cctv', 'engine', 'interrogate']);
const ROLES = ['Navigator', 'Engineer', 'Doctor', 'Pilot'];

const TRACKING_PATTERN = /(누가|왜|역할|범인|정체|감시|who|imposter|why|watch|role|suspect|identity|traitor)/i;
const TENSION_PATTERN = /(긴장|두려움|무서워|끝|죽|die|fear|tension|ship|함선|코어|core|균열|rift)/i;
const RULE_NOISE = /^(규칙|뭐|어떻게|무슨|왜|뭔|뭐야|what|how|why|rule)\s*[?]?$/i;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: null, top: 20, min: null, allowNoMatchId: false };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--input' || args[i] === '--file') && args[i + 1]) opts.input = args[++i];
    else if (args[i] === '--top' && args[i + 1]) opts.top = Math.max(1, parseInt(args[++i], 10) || 20);
    else if (args[i] === '--min' && args[i + 1]) opts.min = parseInt(args[++i], 10);
    else if (args[i] === '--allow-no-match-id') opts.allowNoMatchId = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
score_matches_v1.js - match별 재미 점수 (human/agent 분기, AI 몰입 보너스)

Usage: node scripts/score_matches_v1.js [options]

Options:
  --input <path>          JSON/JSONL 로그 파일 경로 (없으면 logs/ 자동 탐색)
  --file <path>           --input과 동일
  --top <N>               상위 N개 출력 (기본 20)
  --min <score>           최소 점수 이상만 출력
  --allow-no-match-id     match_id 없는 매치도 포함 (기본: 제외)
  --help, -h              도움말
`);
      process.exit(0);
    }
  }
  return opts;
}

function resolveInputPath(userPath) {
  if (!userPath || String(userPath).trim() === '') return null;
  const p = String(userPath).trim();
  const cwd = process.cwd();
  if (path.isAbsolute(p)) return p;
  return path.resolve(cwd, p);
}

function readAndDetectFormat(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error('[score_matches_v1] 입력 파일이 존재하지 않습니다:', filePath);
    console.error('[score_matches_v1] 절대 경로 또는 프로젝트 루트 기준 상대 경로를 확인해 주세요.');
    process.exit(1);
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    console.error('[score_matches_v1] 경로가 파일이 아닙니다:', filePath);
    process.exit(1);
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error('[score_matches_v1] 파일 읽기 실패:', filePath, err.message);
    process.exit(1);
  }

  const trimmed = content.trim();
  if (!trimmed) return { format: 'detailed', data: [] };

  const firstChar = trimmed[0];
  if (firstChar === '{') {
    try {
      const obj = JSON.parse(content);
      if (obj && Array.isArray(obj.matches)) {
        return { format: 'arena_summary', data: obj };
      }
    } catch (_) {}
  }

  if (firstChar === '[') {
    try {
      const arr = JSON.parse(content);
      if (Array.isArray(arr)) {
        const lines = arr.map((item) => (typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item)));
        return { format: 'detailed', data: lines };
      }
    } catch (_) {}
  }

  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  return { format: 'detailed', data: lines };
}

function findLogFile() {
  const cwd = process.cwd();
  const logsDir = path.join(cwd, 'logs');
  if (fs.existsSync(logsDir) && fs.statSync(logsDir).isDirectory()) {
    const files = fs.readdirSync(logsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ path: path.join(logsDir, f), mtime: fs.statSync(path.join(logsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) return files[0].path;
  }
  function walk(dir, found) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && e.name !== '.git') walk(full, found);
        } else if (e.name.endsWith('.jsonl')) {
          found.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        }
      }
    } catch (_) {}
  }
  const found = [];
  walk(cwd, found);
  if (found.length === 0) return null;
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0].path;
}

function safeParseLine(line) {
  try {
    const s = String(line || '').trim();
    if (!s) return null;
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

function getMatchId(entry) {
  const id = entry?.match_id ?? entry?.matchId ?? null;
  return id != null && String(id).trim() !== '' ? String(id).trim() : null;
}

function getAgentFromEntry(entry) {
  const a = entry?.agent_id ?? entry?.agentId ?? entry?.agent ?? null;
  return a != null ? String(a).trim() : null;
}

function getPlayType(entries) {
  let webUi = 0;
  let agent = 0;
  for (const e of entries) {
    const a = getAgentFromEntry(e);
    if (!a) continue;
    if (a === 'WEB_UI') webUi++;
    else if (/^Agent_/i.test(a)) agent++;
  }
  if (webUi > agent) return 'human';
  if (agent > webUi) return 'agent';
  return 'human';
}

function getActionType(entry) {
  const act = entry?.action ?? entry?.actionType ?? null;
  if (!act) return null;
  return String(act.type ?? act.actionType ?? '').toLowerCase() || null;
}

function getActionText(entry) {
  const act = entry?.action ?? entry?.actionType ?? null;
  if (!act) return '';
  return String(act.text ?? act.value ?? '').toLowerCase().trim();
}

function getUserTurns(entries) {
  return entries
    .map((e) => getActionType(e))
    .filter((t) => t && USER_ACTION_TYPES.has(t));
}

function getChannelsUsed(entries) {
  const channels = new Set();
  for (const e of entries) {
    const type = getActionType(e);
    const text = getActionText(e);
    if (type === 'interrogate') channels.add('interrogate');
    if (type === 'cctv') channels.add('cctv');
    if (type === 'engine') channels.add('engine');
    if (type === 'message' && text) {
      const first = text.split(/\s+/)[0] || '';
      if (CHANNELS.has(first)) channels.add(first);
      if (['nav', 'sync', 'time'].includes(first)) channels.add(first);
    }
  }
  return Array.from(channels);
}

function getChannelSequence(entries) {
  const seq = [];
  for (const e of entries) {
    const type = getActionType(e);
    const text = getActionText(e);
    if (type === 'interrogate') seq.push('interrogate');
    else if (type === 'cctv') seq.push('cctv');
    else if (type === 'engine') seq.push('engine');
    else if (type === 'message' && text) {
      const first = text.split(/\s+/)[0] || '';
      if (CHANNELS.has(first)) seq.push(first);
    }
  }
  return seq;
}

function getAccused(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const act = entries[i]?.action ?? entries[i]?.actionType;
    if (act?.type === 'accuse' || act?.actionType === 'accuse') {
      const t = act.target ?? act.value ?? '';
      return String(t).trim() || null;
    }
  }
  return null;
}

function getWinner(entries) {
  const last = entries[entries.length - 1];
  const outcome = last?.outcome ?? last?.state ?? null;
  if (!outcome) return null;
  const s = String(outcome).toLowerCase();
  if (s === 'victory') return 'victory';
  if (s === 'defeat') return 'defeat';
  return outcome;
}

function countEvents(entries) {
  let death = 0;
  let witness = 0;
  let system = 0;
  for (const e of entries) {
    const text = e?.resultTextLog ?? e?.resultText ?? e?.result ?? '';
    const str = String(text || '');
    if (/\[EMERGENCY ALERT\]|TERMINATED|terminated/i.test(str)) death++;
    if (/\[WITNESS TESTIMONY\]|WITNESS TESTIMONY|witness/i.test(str)) witness++;
    if (/\[SYSTEM\]|\[ALERT\]/i.test(str)) system++;
  }
  return { death, witness, system, total: death + witness + system };
}

function getEarlySuspect(entries) {
  const half = Math.floor(entries.length / 2);
  const firstHalf = entries.slice(0, half);
  const counts = {};
  for (const r of ROLES) counts[r] = 0;
  for (const e of firstHalf) {
    const text = e?.resultTextLog ?? e?.resultText ?? e?.result ?? '';
    const str = String(text || '');
    for (const r of ROLES) {
      const re = new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const m = str.match(re);
      if (m) counts[r] += m.length;
    }
  }
  const sorted = ROLES.filter((r) => counts[r] > 0).sort((a, b) => counts[b] - counts[a]);
  return sorted[0] || null;
}

function countTrackingQuestions(entries) {
  let n = 0;
  for (const e of entries) {
    const text = getActionText(e);
    if (text && TRACKING_PATTERN.test(text)) n++;
  }
  return n;
}

function countTensionQuestions(entries) {
  let n = 0;
  for (const e of entries) {
    const text = getActionText(e);
    if (text && TENSION_PATTERN.test(text)) n++;
  }
  return n;
}

function hasEvidenceFlow(entries, channelSeq) {
  if (channelSeq.length < 2) return false;
  const uniqueChannels = [...new Set(channelSeq)];
  return uniqueChannels.length >= 2 && channelSeq.length >= 3;
}

function countSameQuestionRepeats(entries) {
  const texts = [];
  for (const e of entries) {
    const t = getActionText(e);
    if (t && getActionType(e) === 'message') texts.push(t);
  }
  const counts = {};
  for (const t of texts) {
    const k = t.slice(0, 30);
    counts[k] = (counts[k] || 0) + 1;
  }
  return Math.max(0, ...Object.values(counts).map((c) => c - 1));
}

function countRuleNoiseRepeats(entries) {
  let n = 0;
  for (const e of entries) {
    const text = getActionText(e);
    if (text && RULE_NOISE.test(text.trim())) n++;
  }
  return n;
}

function getChannelRepetitionCount(seq) {
  if (seq.length < 2) return 0;
  let maxSame = 1;
  let cur = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === seq[i - 1]) {
      cur++;
      if (cur > maxSame) maxSame = cur;
    } else cur = 1;
  }
  return maxSame;
}

function getMessageCount(entries) {
  return entries.filter((e) => getActionType(e) === 'message').length;
}

function isAccusedValid(accused) {
  if (accused === null || accused === undefined) return false;
  const s = String(accused).trim();
  if (s === '' || s === '?') return false;
  return ROLES.some((r) => r.toLowerCase() === s.toLowerCase());
}

function isTopEligible(meta) {
  const w = (meta.winner ?? '').toString().toLowerCase().trim();
  if (w !== 'victory' && w !== 'defeat') return false;
  return isAccusedValid(meta.accused);
}

function isTopEligibleArena(meta) {
  const w = (meta.winner ?? '').toString().toLowerCase().trim();
  return w === 'victory' || w === 'defeat';
}

function scoreArenaMatch(m) {
  const reasons = ['agent_summary_log'];
  let score = 0;

  const outcome = (m.outcome ?? '').toString().toLowerCase().trim();
  const agentType = (m.agentType ?? '').toString();
  const turns = parseInt(m.turns, 10) || 0;
  const accuseTurn = parseInt(m.accuseTurn, 10) || 0;
  const confidence = parseFloat(m.finalConfidence) || 0;

  if (outcome === 'victory') {
    score += 3;
    reasons.push('victory_bonus');
  } else if (outcome === 'defeat') {
    score -= 1;
    reasons.push('defeat_penalty');
  }

  if (agentType.toLowerCase() === 'rush') {
    if (turns <= 5 && accuseTurn <= 5) {
      if (outcome === 'victory') {
        score += 2;
        reasons.push('rush_fast_win');
      } else if (outcome === 'defeat') {
        score -= 1;
        reasons.push('rush_fast_defeat_penalty');
      }
    }
  } else if (agentType.toLowerCase() === 'cautious') {
    if (turns >= 18 && accuseTurn >= 18) {
      if (outcome === 'victory') {
        score += 2;
        reasons.push('cautious_long_win');
      } else if (outcome === 'defeat') {
        score -= 1;
        reasons.push('overlong_cautious_penalty');
      }
    }
  }

  if (confidence >= 0.8) {
    score += 1;
    reasons.push('confidence_bonus');
  }

  return { score, reasons, immersion_score: 0 };
}

function computeImmersionScore(entries, meta) {
  const { play_type, channels_used } = meta;
  let imm = 0;

  if (play_type === 'human') {
    if (countTrackingQuestions(entries) >= 1) imm++;
    if (countTensionQuestions(entries) >= 1) imm++;
    if (getMessageCount(entries) >= 2 && meta.turns >= 4) imm++;
    return Math.min(3, imm);
  }

  if (play_type === 'agent') {
    const channelCount = channels_used.length;
    const seq = getChannelSequence(entries);
    const repCount = getChannelRepetitionCount(seq);
    const sameQ = countSameQuestionRepeats(entries);
    const ruleNoise = countRuleNoiseRepeats(entries);
    const tracking = countTrackingQuestions(entries);
    const hasFlow = hasEvidenceFlow(entries, seq);

    if (channelCount >= 3) imm++;
    if (tracking >= 1 && repCount < 3) imm++;
    if (hasFlow && sameQ === 0 && ruleNoise <= 2) imm++;
    return Math.min(3, imm);
  }

  return 0;
}

function scoreMatch(entries, meta) {
  const reasons = [];
  let score = 0;
  const { turns, channels_used, accused, winner, event_count, play_type } = meta;
  const channelCount = channels_used.length;
  const seq = getChannelSequence(entries);
  const repCount = getChannelRepetitionCount(seq);

  if (!meta.completed) {
    score -= 2;
    reasons.push('incomplete_penalty');
  }

  if (winner === 'victory') {
    score += 3;
    reasons.push('victory_bonus');
  }
  if (winner === 'defeat') {
    score += 1;
    reasons.push('defeat_bonus');
  }

  if (!isAccusedValid(accused)) {
    score -= 5;
    reasons.push('no_accused_penalty');
  }

  if (turns <= 3) {
    score -= 2;
    reasons.push('too_short_penalty');
  } else if (turns >= 6 && turns <= 8) {
    score += 3;
    reasons.push('good_turn_length');
  } else if (turns >= 9 && turns <= 10) {
    score -= 1;
    reasons.push('turn_mild_penalty');
  } else if (turns >= 11) {
    score -= 5;
    reasons.push('turn_strong_penalty');
  }

  if (channelCount >= 4) {
    score += 2;
    reasons.push(play_type === 'agent' ? 'ai_multi_channel' : 'channel_diversity');
  } else if (channelCount >= 3) {
    score += 1;
    reasons.push(play_type === 'agent' ? 'ai_multi_channel' : 'channel_diversity_mild');
  }

  const userTurns = getUserTurns(entries);
  const accuseIdx = userTurns.lastIndexOf('accuse');
  const totalTurns = userTurns.length;
  if (accuseIdx >= 0 && totalTurns > 0) {
    const distFromEnd = totalTurns - 1 - accuseIdx;
    if (distFromEnd <= 1) {
      score += 2;
      reasons.push('late_accuse');
    } else if (distFromEnd <= 2) {
      score += 1;
      reasons.push('late_accuse_mild');
    }
  }

  const earlySuspect = getEarlySuspect(entries);
  if (accused && earlySuspect && String(accused).toLowerCase() !== String(earlySuspect).toLowerCase()) {
    score += 2;
    reasons.push('suspect_reversal');
  }

  const density = totalTurns > 0 ? event_count.total / totalTurns : 0;
  if (density >= 0.2 && density <= 0.8) {
    score += 1;
    reasons.push('event_density_ok');
  }

  if (play_type === 'human') {
    if (countTrackingQuestions(entries) >= 1) {
      score += 1;
      reasons.push('human_engagement');
    }
    if (countTensionQuestions(entries) >= 1) {
      score += 1;
      reasons.push('human_question_tension');
    }
    if (turns <= 2 && getMessageCount(entries) === 0) {
      score -= 1;
      reasons.push('human_no_interaction_penalty');
    }
  }

  if (play_type === 'agent') {
    if (repCount >= 3) {
      score -= 2;
      reasons.push('ai_repetition_penalty');
    } else if (repCount >= 2 && channelCount < 3) {
      score -= 1;
      reasons.push('ai_repetition_mild');
    }
    const msgCount = getMessageCount(entries);
    if (msgCount >= 6 && channelCount < 2) {
      score -= 1;
      reasons.push('ai_meaningless_repeat_penalty');
    }
    const sameQ = countSameQuestionRepeats(entries);
    if (sameQ >= 2) {
      score -= 1;
      reasons.push('ai_same_question_penalty');
    }
    const ruleNoise = countRuleNoiseRepeats(entries);
    if (ruleNoise >= 4) {
      score -= 1;
      reasons.push('ai_rule_noise_penalty');
    }

    const tracking = countTrackingQuestions(entries);
    const hasFlow = hasEvidenceFlow(entries, seq);
    if ((tracking >= 1 || hasFlow) && repCount < 3 && sameQ < 2) {
      score += 2;
      reasons.push('ai_immersion_bonus');
    }
  }

  const immersion_score = computeImmersionScore(entries, meta);

  return { score, reasons, immersion_score };
}

function groupMatches(lines) {
  const entries = [];
  for (const line of lines) {
    const entry = safeParseLine(line);
    if (!entry) continue;
    entries.push(entry);
  }

  const hasAnyMatchId = entries.some((e) => getMatchId(e));
  if (hasAnyMatchId) {
    const byId = new Map();
    for (const e of entries) {
      const mid = getMatchId(e) ?? '__no_id__';
      if (!byId.has(mid)) byId.set(mid, []);
      byId.get(mid).push(e);
    }
    const matches = [];
    for (const [mid, list] of byId) {
      if (mid === '__no_id__') continue;
      const completed = list.some((e) => e?.isGameOver === true || e?.result?.isGameOver === true);
      matches.push({ entries: list, completed, match_id: mid });
    }
    const noIdEntries = entries.filter((e) => !getMatchId(e));
    if (noIdEntries.length > 0) {
      const fallback = groupMatchesByGameOver(noIdEntries);
      matches.push(...fallback.map((m) => ({ ...m, match_id: null })));
    }
    return matches;
  }
  return groupMatchesByGameOver(entries);
}

function groupMatchesByGameOver(entries) {
  const matches = [];
  let current = [];
  for (const entry of entries) {
    current.push(entry);
    const isGameOver = entry?.isGameOver === true || entry?.result?.isGameOver === true;
    if (isGameOver) {
      matches.push({ entries: [...current], completed: true });
      current = [];
    }
  }
  if (current.length > 0) matches.push({ entries: current, completed: false });
  return matches;
}

function computeMatchMeta(m) {
  const entries = m.entries;
  const userTurns = getUserTurns(entries);
  const turns = userTurns.length;
  const channels_used = getChannelsUsed(entries);
  const accused = getAccused(entries);
  const winner = getWinner(entries);
  const event_count = countEvents(entries);
  const last = entries[entries.length - 1];
  const impostor = last?.actualImposterLog ?? last?.actualImposter ?? null;
  const play_type = getPlayType(entries);

  return {
    turns,
    channels_used,
    accused,
    winner,
    event_count,
    impostor,
    completed: m.completed,
    match_id: m.match_id,
    entryCount: entries.length,
    seed: last?.seed ?? null,
    serverTimestamp: last?.serverTimestamp ?? null,
    play_type
  };
}

function main() {
  const opts = parseArgs();

  let filePath = null;
  if (opts.input) {
    filePath = resolveInputPath(opts.input);
    if (!filePath) {
      console.error('[score_matches_v1] --input 경로가 비어 있습니다.');
      process.exit(1);
    }
  }

  if (!filePath) {
    filePath = findLogFile();
    if (!filePath) {
      console.error('[score_matches_v1] 로그 파일을 찾을 수 없습니다.');
      console.error('[score_matches_v1] --input <경로> 로 파일을 지정하거나, logs/ 폴더에 .jsonl 파일이 있는지 확인해 주세요.');
      process.exit(1);
    }
  }

  const { format: logFormat, data } = readAndDetectFormat(filePath);
  console.error('[score_matches_v1] Using:', path.resolve(filePath));
  console.error('[score_matches_v1] Format:', logFormat);

  let scored;
  let log_format;

  if (logFormat === 'arena_summary') {
    log_format = 'arena_summary';
    const matches = (data.matches || []).map((m) => ({
      entries: [m],
      completed: true,
      match_id: m.match_id ?? null
    }));

    scored = matches.map((m) => {
      const raw = m.entries[0];
      const meta = {
        turns: parseInt(raw.turns, 10) || 0,
        channels_used: [],
        accused: null,
        winner: (raw.outcome ?? '').toString().toLowerCase().trim() || null,
        event_count: { death: 0, witness: 0, system: 0, total: 0 },
        impostor: null,
        completed: true,
        match_id: m.match_id,
        play_type: 'agent',
        agentType: (raw.agentType ?? '').toString()
      };
      const result = scoreArenaMatch(raw);
      return { match: m, meta, score: result.score, reasons: result.reasons, immersion_score: result.immersion_score };
    });

    scored.forEach((s) => {
      s.meta.log_format = log_format;
    });
  } else {
    log_format = 'detailed';
    const lines = data;
    const matches = groupMatches(lines);
    scored = matches.map((m) => {
      const meta = computeMatchMeta(m);
      meta.log_format = log_format;
      const result = scoreMatch(m.entries, meta);
      return { match: m, meta, score: result.score, reasons: result.reasons, immersion_score: result.immersion_score };
    });
  }

  const isEligible = log_format === 'arena_summary' ? isTopEligibleArena : isTopEligible;
  let filtered = scored.filter((s) => isEligible(s.meta));
  if (opts.min != null && !isNaN(opts.min)) {
    filtered = filtered.filter((s) => s.score >= opts.min);
  }
  if (!opts.allowNoMatchId) {
    filtered = filtered.filter((s) => s.meta.match_id != null && s.meta.match_id !== '');
  }

  const top = filtered
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.top);

  console.log('\n=== Top', opts.top, 'fun scores ===\n');
  top.forEach((s, i) => {
    const m = s.meta;
    const mid = m.match_id ? ` match_id=${m.match_id}` : '';
    const pt = m.play_type ? ` [${m.play_type}]` : '';
    const imm = s.immersion_score != null ? ` imm=${s.immersion_score}` : '';
    const agentType = m.agentType ? ` ${m.agentType}` : '';
    const channelsLen = m.channels_used ? m.channels_used.length : 0;
    console.log(
      `${i + 1}. [score=${s.score}]${imm}${pt}${agentType} turns=${m.turns} channels=${channelsLen} accused=${m.accused || '?'} winner=${m.winner || '?'}${mid}`
    );
  });

  const outDir = path.join(process.cwd(), 'outputs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const funScoresPath = path.join(outDir, 'fun_scores.json');
  const funScoresArr = scored.map((s) => ({
    match_id: s.meta.match_id,
    score: s.score,
    play_type: s.meta.play_type || 'human',
    log_format: s.meta.log_format || log_format,
    immersion_score: s.immersion_score ?? 0,
    reasons: s.reasons || [],
    turns: s.meta.turns,
    channels_used: s.meta.channels_used || [],
    accused: s.meta.accused,
    winner: s.meta.winner,
    event_count: s.meta.event_count,
    completed: s.meta.completed,
    impostor: s.meta.impostor
  }));
  fs.writeFileSync(funScoresPath, JSON.stringify(funScoresArr, null, 2), 'utf8');
  console.log('\nSaved:', funScoresPath);

  const csvPath = path.join(outDir, 'fun_scores.csv');
  const headers = ['rank', 'score', 'play_type', 'log_format', 'immersion_score', 'reasons', 'match_id', 'turns', 'channels_count', 'accused', 'winner', 'completed', 'impostor'];
  const csvRows = [headers.join(',')];
  top.forEach((s, i) => {
    const m = s.meta;
    const reasonsStr = (s.reasons || []).join(';');
    const channelsLen = m.channels_used ? m.channels_used.length : 0;
    const row = [
      i + 1,
      s.score,
      m.play_type || 'human',
      m.log_format || log_format,
      s.immersion_score ?? 0,
      `"${String(reasonsStr).replace(/"/g, '""')}"`,
      m.match_id != null ? `"${String(m.match_id).replace(/"/g, '""')}"` : '',
      m.turns,
      channelsLen,
      m.accused != null ? `"${String(m.accused).replace(/"/g, '""')}"` : '',
      m.winner != null ? `"${String(m.winner).replace(/"/g, '""')}"` : '',
      m.completed,
      m.impostor != null ? `"${String(m.impostor).replace(/"/g, '""')}"` : ''
    ];
    csvRows.push(row.join(','));
  });
  fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
  console.log('Saved:', csvPath);

  const topMatchesPath = path.join(outDir, 'top_matches.json');
  const topMatchesArr = top.map((s) => ({
    match_id: s.meta.match_id,
    score: s.score,
    turns: s.meta.turns,
    channels_used: s.meta.channels_used || [],
    accused: s.meta.accused,
    winner: s.meta.winner,
    sourceFile: path.relative(process.cwd(), filePath) || filePath,
    entries: s.match.entries
  }));
  fs.writeFileSync(topMatchesPath, JSON.stringify(topMatchesArr, null, 2), 'utf8');
  console.log('Saved:', topMatchesPath);
}

main();

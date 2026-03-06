#!/usr/bin/env node
/**
 * pick_highlights.js - 재미있는 판 자동 선별
 * JSONL 로그를 읽어 점수화 후 상위 N개 출력
 */
const fs = require('fs');
const path = require('path');

const USER_ACTION_TYPES = new Set(['message', 'interrogate', 'cctv', 'engine', 'accuse']);
const PRIMARY_CMDS = new Set(['nav', 'time', 'sync']);
const PRIMARY_MARKER = '[SYSTEM] Access log:';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { file: null, top: 20, min: null, allowNoMatchId: false }; // PATCH
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      opts.file = args[++i];
    } else if (args[i] === '--top' && args[i + 1]) {
      opts.top = Math.max(1, parseInt(args[++i], 10) || 20);
    } else if (args[i] === '--min' && args[i + 1]) {
      opts.min = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--allow-no-match-id') {
      opts.allowNoMatchId = true; // PATCH
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
pick_highlights.js - 재미있는 판 자동 선별

Usage: node pick_highlights.js [options]

Options:
  --file <path>           JSONL 로그 파일 경로 (없으면 자동 탐색)
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

function getActionType(entry) {
  const act = entry?.action ?? entry?.actionType ?? null;
  if (!act) return null;
  const t = act.type ?? act.actionType ?? '';
  return String(t).toLowerCase() || null;
}

function getUserInputs(entries) {
  return entries
    .map((e) => getActionType(e))
    .filter((t) => t && USER_ACTION_TYPES.has(t));
}

function getAutoKillCount(entries) {
  return entries.filter((e) => getActionType(e) === 'auto-kill').length;
}

function getDeadCrewMax(entries) {
  let max = 0;
  for (const e of entries) {
    const dc = e?.deadCrew ?? e?.result?.deadCrew ?? [];
    const len = Array.isArray(dc) ? dc.length : 0;
    if (len > max) max = len;
  }
  return max;
}

function hasPrimarySuccess(entries) {
  for (const e of entries) {
    const act = e?.action ?? e?.actionType ?? null;
    const text = (act?.text ?? act?.value ?? '').toString().toLowerCase().trim();
    if (PRIMARY_CMDS.has(text)) return true;

    const resultText =
      e?.resultTextLog ?? e?.resultText ?? e?.result ?? e?.text ?? '';
    const str = String(resultText || '');
    if (str.includes(PRIMARY_MARKER)) return true;
  }
  return false;
}

function scoreMatch(entries, completed) {
  let score = 0;
  if (!completed) score -= 1;

  const lastEntry = entries[entries.length - 1];
  const outcome = lastEntry?.outcome ?? lastEntry?.state ?? '';
  if (String(outcome).toLowerCase() === 'victory') score += 3;

  const deadCrewMax = getDeadCrewMax(entries);
  if (deadCrewMax >= 2) score += 2;

  const userInputs = getUserInputs(entries);
  const inputCount = userInputs.length;
  if (inputCount >= 5 && inputCount <= 12) score += 2;

  const last3 = userInputs.slice(-3);
  if (last3.includes('accuse')) score += 1;

  const autoKillCount = getAutoKillCount(entries);
  if (autoKillCount >= 2) score += 1;

  if (hasPrimarySuccess(entries)) score += 1;

  return score;
}

function getMatchId(entry) {
  const id = entry?.match_id ?? entry?.matchId ?? null;
  return id != null && String(id).trim() !== '' ? String(id).trim() : null; // PATCH
}

function groupMatches(lines) {
  const entries = [];
  for (const line of lines) {
    const entry = safeParseLine(line);
    if (!entry) continue;
    entries.push(entry);
  }

  const hasAnyMatchId = entries.some((e) => getMatchId(e)); // PATCH
  if (hasAnyMatchId) {
    // match_id 우선: 같은 match_id끼리 한 판으로 묶기 // PATCH
    const byId = new Map();
    for (const e of entries) {
      const mid = getMatchId(e) ?? '__no_id__';
      if (!byId.has(mid)) byId.set(mid, []);
      byId.get(mid).push(e);
    }
    const matches = [];
    for (const [mid, list] of byId) {
      if (mid === '__no_id__') continue; // match_id 없는 건 fallback에서 처리
      const completed = list.some((e) => e?.isGameOver === true || e?.result?.isGameOver === true);
      matches.push({ entries: list, completed, match_id: mid }); // PATCH
    }
    // match_id 없는 entry들은 기존 방식으로 묶기 // PATCH
    const noIdEntries = entries.filter((e) => !getMatchId(e));
    if (noIdEntries.length > 0) {
      const fallback = groupMatchesByGameOver(noIdEntries); // PATCH
      matches.push(...fallback.map((m) => ({ ...m, match_id: null }))); // PATCH
    }
    return matches;
  }

  return groupMatchesByGameOver(entries); // PATCH: fallback
}

function groupMatchesByGameOver(entries) { // PATCH: match_id 없을 때 fallback
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
  if (current.length > 0) {
    matches.push({ entries: current, completed: false });
  }
  return matches;
}

function summarizeMatch(m, index) {
  const entries = m.entries;
  const score = scoreMatch(entries, m.completed);
  const last = entries[entries.length - 1];
  const outcome = last?.outcome ?? last?.state ?? '?';
  const impostor = last?.actualImposterLog ?? last?.actualImposter ?? '?';
  const deadCrew = last?.deadCrew ?? last?.result?.deadCrew ?? [];
  const inputCount = getUserInputs(entries).length;
  const firstWithMatchId = entries.find((e) => getMatchId(e)); // PATCH
  const match_id = m.match_id ?? (firstWithMatchId ? getMatchId(firstWithMatchId) : null); // PATCH

  return {
    index: index + 1,
    score,
    completed: m.completed,
    outcome,
    impostor,
    deadCrewCount: Array.isArray(deadCrew) ? deadCrew.length : 0,
    inputCount,
    entryCount: entries.length,
    seed: last?.seed ?? '?',
    serverTimestamp: last?.serverTimestamp ?? '',
    match_id // PATCH
  };
}

function main() {
  const opts = parseArgs();

  let filePath = opts.file;
  if (!filePath) {
    filePath = findLogFile();
    if (!filePath) {
      console.error('[pick_highlights] No JSONL file found. Use --file <path> or ensure ./logs/*.jsonl exists.');
      process.exit(1);
    }
    console.error('[pick_highlights] Using:', filePath);
  }

  if (!fs.existsSync(filePath)) {
    console.error('[pick_highlights] File not found:', filePath);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim());

  const matches = groupMatches(lines);
  const scored = matches.map((m, i) => ({
    match: m,
    summary: summarizeMatch(m, i),
    score: scoreMatch(m.entries, m.completed)
  }));

  let filtered = scored;
  if (opts.min != null && !isNaN(opts.min)) {
    filtered = scored.filter((s) => s.score >= opts.min);
  }
  if (!opts.allowNoMatchId) {
    filtered = filtered.filter((s) => s.summary.match_id != null && s.summary.match_id !== ''); // PATCH: match_id 없는 매치 제외
  }

  const top = filtered
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.top);

  console.log('\n=== Top', opts.top, 'highlights ===\n');
  top.forEach((s, i) => {
    const sm = s.summary;
    const mid = sm.match_id ? ` match_id=${sm.match_id}` : ''; // PATCH
    console.log(
      `${i + 1}. [score=${s.score}] outcome=${sm.outcome} impostor=${sm.impostor} inputs=${sm.inputCount} dead=${sm.deadCrewCount} (match #${sm.index})${mid}`
    );
  });

  const outDir = path.join(process.cwd(), 'outputs');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const jsonPath = path.join(outDir, 'highlights_top.json');
  const csvPath = path.join(outDir, 'highlights_top.csv');

  const jsonOut = top.map((s) => ({
    score: s.score,
    ...s.summary,
    entries: s.match.entries
  }));
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2), 'utf8');
  console.log('\nSaved:', jsonPath);

  const headers = ['rank', 'score', 'match_id', 'completed', 'outcome', 'impostor', 'deadCrewCount', 'inputCount', 'entryCount', 'seed']; // PATCH
  const csvRows = [headers.join(',')];
  top.forEach((s, i) => {
    const sm = s.summary;
    const row = [
      i + 1,
      s.score,
      sm.match_id != null ? `"${String(sm.match_id).replace(/"/g, '""')}"` : '', // PATCH
      sm.completed,
      `"${String(sm.outcome).replace(/"/g, '""')}"`,
      `"${String(sm.impostor).replace(/"/g, '""')}"`,
      sm.deadCrewCount,
      sm.inputCount,
      sm.entryCount,
      `"${String(sm.seed).replace(/"/g, '""')}"`
    ];
    csvRows.push(row.join(','));
  });
  fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf8');
  console.log('Saved:', csvPath);
}

main();

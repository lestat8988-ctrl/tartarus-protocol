#!/usr/bin/env node
/**
 * export_replay.js - highlights_top.json의 match_id별로 로그에서 replay 추출
 */
const fs = require('fs');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  let fromPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) {
      fromPath = args[++i];
      break;
    }
  }
  return { fromPath };
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

function resolveLogFile(item) {
  const src = item?.sourceFile;
  if (src && typeof src === 'string' && src.trim()) {
    const p = path.isAbsolute(src) ? src : path.join(process.cwd(), src);
    if (fs.existsSync(p)) return p;
  }
  return findLogFile();
}

function getMatchId(entry) {
  const id = entry?.match_id ?? entry?.matchId ?? null;
  return id != null && String(id).trim() !== '' ? String(id).trim() : null;
}

function extractItemsFromLog(logPath, targetMatchId) {
  const items = [];
  let parseFailCount = 0;

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim());

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const mid = getMatchId(entry);
      if (mid === targetMatchId) {
        items.push(entry);
      }
    } catch (_) {
      parseFailCount++;
    }
  }

  return { items, parseFailCount };
}

function main() {
  const { fromPath } = parseArgs();

  if (!fromPath) {
    console.error('Usage: node export_replay.js --from <highlights_top.json>');
    process.exit(1);
  }

  const absFrom = path.isAbsolute(fromPath) ? fromPath : path.join(process.cwd(), fromPath);
  if (!fs.existsSync(absFrom)) {
    console.error('[export_replay] File not found:', absFrom);
    process.exit(1);
  }

  let highlights;
  try {
    highlights = JSON.parse(fs.readFileSync(absFrom, 'utf8'));
  } catch (e) {
    console.error('[export_replay] Invalid JSON:', absFrom, e?.message);
    process.exit(1);
  }

  const arr = Array.isArray(highlights) ? highlights : [];
  const matchIds = [...new Set(arr.map((h) => h?.match_id ?? h?.matchId).filter(Boolean))];

  if (matchIds.length === 0) {
    console.log('exported 0 matches (no match_id in highlights)');
    return;
  }

  const outDir = path.join(process.cwd(), 'outputs', 'replays');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  let totalParseFails = 0;
  let exported = 0;

  for (const mid of matchIds) {
    const item = arr.find((h) => (h?.match_id ?? h?.matchId) === mid);
    const logPath = resolveLogFile(item || {});

    if (!logPath || !fs.existsSync(logPath)) {
      console.error('[export_replay] No log file for match_id:', mid);
      continue;
    }

    const { items, parseFailCount } = extractItemsFromLog(logPath, mid);
    totalParseFails += parseFailCount;

    if (items.length === 0) {
      console.error('[export_replay] No matching entries for match_id:', mid);
      continue;
    }

    const first = items[0];
    const last = items[items.length - 1];
    const startTs = first?.serverTimestamp ?? null;
    const endTs = last?.serverTimestamp ?? null;
    const outcome = last?.outcome ?? last?.state ?? null;
    const impostor = last?.actualImposterLog ?? last?.actualImposter ?? null;

    const payload = {
      match_id: mid,
      items,
      startTs,
      endTs,
      outcome,
      impostor
    };

    const safeName = String(mid).replace(/[/\\?*:|<>]/g, '_');
    const outPath = path.join(outDir, `${safeName}.json`);
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    exported++;
  }

  if (totalParseFails > 0) {
    console.log('[export_replay] Skipped', totalParseFails, 'parse-failed lines');
  }
  console.log('exported', exported, 'matches');
}

main();

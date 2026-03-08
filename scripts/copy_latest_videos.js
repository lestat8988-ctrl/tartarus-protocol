#!/usr/bin/env node
/**
 * copy_latest_videos.js - top_matches.json의 match_id에 해당하는 mp4를 outputs/videos/latest로 복사
 *
 * 파이프라인 마지막 단계: score -> export_replay -> render_mp4 -> copy_latest_videos
 *
 * Usage: node scripts/copy_latest_videos.js --from outputs/top_matches.json
 */
const fs = require('fs');
const path = require('path');

const CWD = process.cwd();
const VIDEOS_DIR = path.join(CWD, 'outputs', 'videos');
const DEFAULT_FROM = path.join(CWD, 'outputs', 'top_matches.json');

function parseArgs() {
  const args = process.argv.slice(2);
  let fromPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) fromPath = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
copy_latest_videos.js - top match mp4를 outputs/videos/latest로 복사

Usage: node scripts/copy_latest_videos.js [options]

Options:
  --from <path>    top_matches.json 경로 (기본: outputs/top_matches.json)
  --help, -h       도움말
`);
      process.exit(0);
    }
  }
  return { fromPath: fromPath || DEFAULT_FROM };
}

function findMp4ByMatchId(matchId) {
  const direct = path.join(VIDEOS_DIR, `${matchId}.mp4`);
  if (fs.existsSync(direct)) return direct;
  try {
    const files = fs.readdirSync(VIDEOS_DIR);
    const found = files.find(
      (f) => f.startsWith(matchId) && f.endsWith('.mp4') && !f.includes('_pad') && !f.includes('_crop')
    );
    if (found) return path.join(VIDEOS_DIR, found);
  } catch (_) {}
  return null;
}

function main() {
  const { fromPath } = parseArgs();

  const absFrom = path.isAbsolute(fromPath) ? fromPath : path.join(CWD, fromPath);
  if (!fs.existsSync(absFrom)) {
    console.error('[copy_latest_videos] File not found:', absFrom);
    process.exit(1);
  }

  let topMatches;
  try {
    topMatches = JSON.parse(fs.readFileSync(absFrom, 'utf8'));
  } catch (e) {
    console.error('[copy_latest_videos] Invalid JSON:', absFrom, e?.message);
    process.exit(1);
  }

  const arr = Array.isArray(topMatches) ? topMatches : [];
  const matchIds = arr
    .map((h) => h?.match_id ?? h?.matchId)
    .filter((id) => id != null && String(id).trim() !== '');

  if (matchIds.length === 0) {
    console.log('[copy_latest_videos] No match_id in', absFrom);
    return;
  }

  const latestDir = path.join(VIDEOS_DIR, 'latest');
  if (fs.existsSync(latestDir)) {
    try {
      const files = fs.readdirSync(latestDir);
      for (const f of files) {
        const p = path.join(latestDir, f);
        if (fs.statSync(p).isFile()) fs.unlinkSync(p);
      }
    } catch (e) {
      console.error('[copy_latest_videos] Failed to clear latest dir:', e?.message);
      process.exit(1);
    }
  }
  fs.mkdirSync(latestDir, { recursive: true });

  let copied = 0;
  for (const mid of matchIds) {
    const src = findMp4ByMatchId(mid);
    if (!src || !fs.existsSync(src)) {
      console.warn('[copy_latest_videos] mp4 not found:', mid);
      continue;
    }
    const dest = path.join(latestDir, path.basename(src));
    try {
      fs.copyFileSync(src, dest);
      copied++;
      console.log('[copy_latest_videos] copied:', path.basename(src));
    } catch (e) {
      console.warn('[copy_latest_videos] copy failed:', mid, e?.message);
    }
  }

  console.log('[copy_latest_videos] done. copied', copied, 'files to', latestDir);
}

main();

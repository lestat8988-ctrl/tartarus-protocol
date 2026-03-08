#!/usr/bin/env node
/**
 * run_pipeline.js - 원클릭 파이프라인
 *
 * 1. score_matches_v1.js  → outputs/fun_scores.json, fun_scores.csv, top_matches.json
 * 2. export_replay.js     → outputs/replays/<match_id>.json
 * 3. render_mp4.js        → outputs/videos/<match_id>.mp4 (per match)
 * 4. copy_latest_videos.js → outputs/videos/latest/ (top mp4만 복사)
 *
 * Usage: node scripts/run_pipeline.js [options]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CWD = process.cwd();
const SCRIPTS_DIR = path.join(CWD, 'scripts');
const OUTPUTS_DIR = path.join(CWD, 'outputs');
const TOP_MATCHES_PATH = path.join(OUTPUTS_DIR, 'top_matches.json');
const REPLAYS_DIR = path.join(OUTPUTS_DIR, 'replays');
const VIDEOS_DIR = path.join(OUTPUTS_DIR, 'videos');

const DEFAULT_BASE_URL = 'http://localhost:3000';

const FUN_SCORES_JSON = path.join(OUTPUTS_DIR, 'fun_scores.json');
const FUN_SCORES_CSV = path.join(OUTPUTS_DIR, 'fun_scores.csv');

function resolveBaseUrl(cliBase, envBase) {
  const fromCli = cliBase != null && String(cliBase).trim() !== '' ? String(cliBase).trim() : null;
  const fromEnv = envBase != null && String(envBase).trim() !== '' ? String(envBase).trim() : null;
  return fromCli ?? fromEnv ?? DEFAULT_BASE_URL;
}

function inferTagFromInput(inputPath) {
  if (!inputPath || String(inputPath).trim() === '') return null;
  const name = path.basename(String(inputPath).trim()).toLowerCase();
  if (/arena_duel_llm|arena_duel|arena_run|arena_/.test(name) || (name.endsWith('.json') && /arena/.test(name))) return 'ai';
  if (/tartarus_/.test(name) && name.endsWith('.jsonl')) return 'human';
  if (name.endsWith('.jsonl')) return 'human';
  if (name.endsWith('.json') && /arena/.test(name)) return 'ai';
  return null;
}

function parseScoreInputPathFromOutput(output) {
  if (!output || typeof output !== 'string') return null;
  const lines = output.split(/\r?\n/);
  const line = lines.find((l) => l.includes('[score_matches_v1] Using:'));
  if (!line) return null;
  const m = line.match(/\[score_matches_v1\] Using:\s*(.+)/);
  return m ? String(m[1]).trim() : null;
}

function runNodeForScore(scriptName, args, cwd = CWD) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  const r = spawnSync('node', [scriptPath, ...args], {
    cwd,
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf8'
  });
  const stdout = (r.stdout || '').toString();
  const stderr = (r.stderr || '').toString();
  const combined = stdout + (stdout && stderr ? '\n' : '') + stderr;
  if (combined.trim()) process.stdout.write(combined);
  const scoreInputPath = parseScoreInputPathFromOutput(combined) || parseScoreInputPathFromOutput(stdout) || parseScoreInputPathFromOutput(stderr);
  return { ok: r.status === 0, scoreInputPath };
}

function backupScoreResults(tag) {
  const files = [
    [FUN_SCORES_JSON, path.join(OUTPUTS_DIR, `fun_scores_${tag}.json`)],
    [FUN_SCORES_CSV, path.join(OUTPUTS_DIR, `fun_scores_${tag}.csv`)],
    [TOP_MATCHES_PATH, path.join(OUTPUTS_DIR, `top_matches_${tag}.json`)]
  ];
  let ok = 0;
  for (const [src, dest] of files) {
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dest);
        console.log('[backup] saved', path.basename(dest));
        ok++;
      }
    } catch (e) {
      console.warn('[backup] failed to copy', path.basename(dest), ':', e?.message || e);
    }
  }
  return ok;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let baseFromCli = null;
  const opts = {
    top: 3,
    min: null,
    input: null,
    tag: null,
    noBaseCheck: false,
    compare: false,
    fps: 30,
    speed: 700,
    width: 1280,
    height: 720,
    portrait: 'none',
    pwidth: 720,
    pheight: 1280
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--top' && args[i + 1]) opts.top = Math.max(1, parseInt(args[++i], 10) || 3);
    else if (args[i] === '--min' && args[i + 1]) opts.min = parseInt(args[++i], 10);
    else if ((args[i] === '--input' || args[i] === '--file') && args[i + 1]) opts.input = args[++i];
    else if (args[i] === '--tag' && args[i + 1]) {
      const v = (args[++i] || '').toLowerCase();
      opts.tag = (v === 'human' || v === 'ai') ? v : null;
    }
    else if ((args[i] === '--base-url' || args[i] === '--base') && args[i + 1]) baseFromCli = args[++i];
    else if (args[i] === '--fps' && args[i + 1]) opts.fps = Math.max(1, parseInt(args[++i], 10) || 30);
    else if (args[i] === '--speed' && args[i + 1]) opts.speed = Math.max(0, parseInt(args[++i], 10) || 700);
    else if (args[i] === '--width' && args[i + 1]) opts.width = Math.max(320, parseInt(args[++i], 10) || 1280);
    else if (args[i] === '--height' && args[i + 1]) opts.height = Math.max(240, parseInt(args[++i], 10) || 720);
    else if (args[i] === '--portrait' && args[i + 1]) {
      const v = (args[++i] || '').toLowerCase();
      opts.portrait = ['none', 'pad', 'crop', 'both'].includes(v) ? v : 'none';
    }
    else if (args[i] === '--pwidth' && args[i + 1]) opts.pwidth = Math.max(320, parseInt(args[++i], 10) || 720);
    else if (args[i] === '--pheight' && args[i + 1]) opts.pheight = Math.max(480, parseInt(args[++i], 10) || 1280);
    else if (args[i] === '--no-base-check') opts.noBaseCheck = true;
    else if (args[i] === '--compare') opts.compare = true;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
run_pipeline.js - 원클릭 파이프라인 (score → replay → render → latest)

Usage: node scripts/run_pipeline.js [options]

Options:
  --top <N>         상위 N개 (기본 3)
  --min <score>     최소 점수 이상만 (score_matches_v1에 전달)
  --input <path>    로그 파일 경로 (score_matches_v1에 전달)
  --tag <human|ai>  백업 태그 (없으면 input 파일명으로 자동 추론)
  --base-url <url>  base URL (CLI > BASE_URL env > 기본값)
  --fps <int>       fps (기본 30)
  --speed <ms>      턴 간격 ms (기본 700)
  --width <int>     가로 (기본 1280)
  --height <int>    세로 (기본 720)
  --portrait <mode> none|pad|crop|both (기본 none)
  --pwidth <int>    portrait 가로 (기본 720)
  --pheight <int>   portrait 세로 (기본 1280)
  --no-base-check   base URL 체크 생략 (서버 없이 score/export만 테스트)
  --compare         마지막에 human vs AI 비교 요약 생성 (compare_human_ai_summary.js)
  --help, -h        도움말
`);
      process.exit(0);
    }
  }
  opts.baseUrl = resolveBaseUrl(baseFromCli, process.env.BASE_URL);
  return opts;
}

function checkBaseAlive(baseUrl) {
  return new Promise((resolve) => {
    try {
      const url = new URL(baseUrl);
      const mod = url.protocol === 'https:' ? require('https') : require('http');
      const req = mod.get(baseUrl, { timeout: 5000 }, (res) => {
        resolve(res.statusCode < 500);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

function runNode(scriptName, args, cwd = CWD) {
  const scriptPath = path.join(SCRIPTS_DIR, scriptName);
  const r = spawnSync('node', [scriptPath, ...args], {
    cwd,
    stdio: 'inherit'
  });
  return r.status === 0;
}

function runFfmpegPortrait(inputMp4, outputMp4, mode, pw, ph) {
  const padFilter = `scale=${pw}:${ph}:force_original_aspect_ratio=decrease,pad=${pw}:${ph}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const cropFilter = `scale=${pw}:${ph}:force_original_aspect_ratio=increase,crop=${pw}:${ph},setsar=1`;
  const vf = mode === 'pad' ? padFilter : cropFilter;
  let ffmpegPath;
  try {
    ffmpegPath = require('ffmpeg-static');
  } catch (_) {
    console.error('[render] ffmpeg-static not installed. Run: npm i ffmpeg-static');
    return false;
  }
  const r = spawnSync(ffmpegPath, ['-y', '-i', inputMp4, '-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputMp4], {
    cwd: CWD,
    stdio: 'inherit'
  });
  return r.status === 0;
}

function findMp4ByMatchId(matchId) {
  const direct = path.join(VIDEOS_DIR, `${matchId}.mp4`);
  if (fs.existsSync(direct)) return direct;
  try {
    const files = fs.readdirSync(VIDEOS_DIR);
    const found = files.find((f) => f.startsWith(matchId) && f.endsWith('.mp4') && !f.includes('_pad') && !f.includes('_crop'));
    if (found) return path.join(VIDEOS_DIR, found);
  } catch (_) {}
  return null;
}

async function main() {
  const opts = parseArgs();

  if (!opts.noBaseCheck) {
    console.log('[run_pipeline] Checking base URL:', opts.baseUrl);
    const baseOk = await checkBaseAlive(opts.baseUrl);
    if (!baseOk) {
      console.error('[run_pipeline] Base URL not reachable. vercel dev 켜라');
      console.error('[run_pipeline] (--no-base-check 로 score/export만 실행 가능)');
      process.exit(1);
    }
    console.log('[run_pipeline] Base OK\n');
  } else {
    console.log('[run_pipeline] Skipping base URL check (--no-base-check)\n');
  }

  // ─── 1. [score] score_matches_v1.js ─────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('[score] Step 1: score_matches_v1.js --top', opts.top);
  console.log('═══════════════════════════════════════════════════════════');
  const scoreArgs = ['--top', String(opts.top)];
  if (opts.min != null) scoreArgs.push('--min', String(opts.min));
  if (opts.input) scoreArgs.push('--input', opts.input);
  const scoreResult = runNodeForScore('score_matches_v1.js', scoreArgs);
  if (!scoreResult.ok) {
    console.error('[score] score_matches_v1.js failed');
    process.exit(1);
  }
  console.log('[score] done.\n');

  // ─── 1.5 [backup] score 결과 백업 (--tag 또는 자동 추론) ───────────────────
  const resolvedScoreInputPath = scoreResult.scoreInputPath ?? opts.input ?? null;
  const resolvedTag = opts.tag ?? inferTagFromInput(resolvedScoreInputPath);
  if (resolvedTag) {
    if (opts.tag) {
      console.log('[backup] tag:', resolvedTag, '(from --tag)');
    } else {
      console.log('[backup] inferred tag:', resolvedTag);
      if (resolvedScoreInputPath) console.log('[backup] inferred from:', resolvedScoreInputPath);
    }
    backupScoreResults(resolvedTag);
  } else {
    console.log('[backup] tag not determined, backup skipped');
    if (resolvedScoreInputPath) console.log('[backup] (input path:', resolvedScoreInputPath, ')');
  }

  // ─── 2. [replay] export_replay.js ───────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('[replay] Step 2: export_replay.js --from', TOP_MATCHES_PATH);
  console.log('═══════════════════════════════════════════════════════════');
  if (!fs.existsSync(TOP_MATCHES_PATH)) {
    console.error('[replay] top_matches.json not found');
    process.exit(1);
  }
  if (!runNode('export_replay.js', ['--from', TOP_MATCHES_PATH])) {
    console.error('[replay] export_replay.js failed');
    process.exit(1);
  }
  console.log('[replay] done.\n');

  // ─── 3. [render] render_mp4.js (per match) ─────────────────────────────
  let topMatches;
  try {
    topMatches = JSON.parse(fs.readFileSync(TOP_MATCHES_PATH, 'utf8'));
  } catch (e) {
    console.error('[render] Invalid top_matches.json:', e?.message);
    process.exit(1);
  }
  const arr = Array.isArray(topMatches) ? topMatches : [];
  const matchIds = arr
    .map((h) => h?.match_id ?? h?.matchId)
    .filter((id) => id != null && String(id).trim() !== '');
  const toProcess = matchIds.slice(0, Math.min(opts.top, matchIds.length));

  fs.mkdirSync(VIDEOS_DIR, { recursive: true });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('[render] Step 3: render_mp4.js for', toProcess.length, 'matches');
  console.log('═══════════════════════════════════════════════════════════');

  const stats = { ok: 0, fail: 0, skip: 0, failedIds: [] };
  for (let i = 0; i < toProcess.length; i++) {
    const mid = toProcess[i];
    const replayPath = path.join(REPLAYS_DIR, `${mid}.json`);
    if (!fs.existsSync(replayPath)) {
      console.warn(`[render] ${i + 1}/${toProcess.length} skip ${mid} (replay not found)`);
      stats.skip++;
      continue;
    }

    const renderArgs = [
      '--file', replayPath,
      '--base', opts.baseUrl,
      '--fps', String(opts.fps),
      '--speed', String(opts.speed),
      '--width', String(opts.width),
      '--height', String(opts.height)
    ];

    try {
      const ok = runNode('render_mp4.js', renderArgs);
      if (ok) {
        stats.ok++;
        console.log(`[render] ${i + 1}/${toProcess.length} ok ${mid}`);
      } else {
        stats.fail++;
        stats.failedIds.push(mid);
        console.warn(`[render] ${i + 1}/${toProcess.length} fail ${mid}`);
      }
    } catch (e) {
      stats.fail++;
      stats.failedIds.push(mid);
      console.warn(`[render] ${i + 1}/${toProcess.length} error ${mid}:`, e?.message || e);
    }
  }
  console.log('[render] done. ok:', stats.ok, ' fail:', stats.fail, ' skip:', stats.skip, '\n');

  // ─── 3.5 [render] portrait 후처리 (선택) ─────────────────────────────────
  if (opts.portrait !== 'none') {
    const modes = opts.portrait === 'both' ? ['pad', 'crop'] : [opts.portrait];
    console.log('[render] portrait', modes.join(', '));
    for (const mid of toProcess) {
      const mp4Path = findMp4ByMatchId(mid);
      if (!mp4Path || !fs.existsSync(mp4Path)) continue;
      for (const mode of modes) {
        const outName = `${mid}_${opts.pwidth}x${opts.pheight}_${mode}.mp4`;
        const outPath = path.join(VIDEOS_DIR, outName);
        try {
          const ok = runFfmpegPortrait(mp4Path, outPath, mode, opts.pwidth, opts.pheight);
          if (ok) console.log('[render] portrait saved:', outName);
        } catch (_) {}
      }
    }
  }

  // ─── 4. [latest] copy_latest_videos.js ──────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('[latest] Step 4: copy_latest_videos.js');
  console.log('═══════════════════════════════════════════════════════════');
  if (!runNode('copy_latest_videos.js', ['--from', TOP_MATCHES_PATH])) {
    console.warn('[latest] copy_latest_videos.js failed (non-fatal)');
  } else {
    console.log('[latest] done.\n');
  }

  // ─── 요약 ───────────────────────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════════');
  console.log('[run_pipeline] Done.');
  if (resolvedScoreInputPath) console.log('  input:', resolvedScoreInputPath);
  if (resolvedTag) console.log('  tag:', resolvedTag);
  console.log('  [score]  fun_scores.json, fun_scores.csv, top_matches.json');
  console.log('  [replay] outputs/replays/*.json');
  console.log('  [render] ok=', stats.ok, ' fail=', stats.fail, ' skip=', stats.skip);
  if (stats.failedIds.length > 0) {
    console.log('  [render] failed:', stats.failedIds.join(', '));
  }
  console.log('  [latest] outputs/videos/latest/ (성공 mp4만 복사)');
  if (opts.compare) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('[compare] Step 5: compare_human_ai_summary.js');
    console.log('═══════════════════════════════════════════════════════════');
    const compareOk = runNode('compare_human_ai_summary.js', []);
    if (!compareOk) {
      console.warn('[compare] compare_human_ai_summary.js failed (non-fatal)');
    } else {
      console.log('[compare] done.\n');
    }
  }
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error('[run_pipeline]', err?.message || err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * run_pipeline.js - 원클릭 파이프라인: pick_highlights → export_replay → render_mp4(Top N) [+ portrait 후처리]
 *
 * 가정:
 * - pick_highlights.js 출력 → outputs/highlights_top.json
 * - export_replay.js → outputs/replays/<match_id>.json
 * - render_mp4.js → outputs/videos/<match_id>.mp4
 * - portrait 후처리 → outputs/videos/<match_id>_<pw>x<ph>_pad.mp4, _crop.mp4
 * - --latest: 예상 파일명 존재 확인 후 latest-dir로 복사 (시간 비교 없음)
 *
 * Windows/Node에서 바로 실행: node scripts/run_pipeline.js [options]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CWD = process.cwd();
const SCRIPTS_DIR = path.join(CWD, 'scripts');
const OUTPUTS_DIR = path.join(CWD, 'outputs');
const HIGHLIGHTS_PATH = path.join(OUTPUTS_DIR, 'highlights_top.json');
const REPLAYS_DIR = path.join(OUTPUTS_DIR, 'replays');
const VIDEOS_DIR = path.join(OUTPUTS_DIR, 'videos');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    top: 5,
    min: null,
    base: 'http://localhost:3000',
    fps: 30,
    speed: 700,
    width: 1280,
    height: 720,
    portrait: 'none',
    pwidth: 720,
    pheight: 1280,
    latest: false, // PATCH
    latestDir: 'outputs/videos/latest', // PATCH
    latestClean: true // PATCH
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--top' && args[i + 1]) opts.top = Math.max(1, parseInt(args[++i], 10) || 5);
    else if (args[i] === '--min' && args[i + 1]) opts.min = parseInt(args[++i], 10);
    else if (args[i] === '--base' && args[i + 1]) opts.base = args[++i];
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
    else if (args[i] === '--latest') opts.latest = true; // PATCH
    else if (args[i] === '--latest-dir' && args[i + 1]) opts.latestDir = args[++i]; // PATCH
    else if (args[i] === '--latest-clean') opts.latestClean = true; // PATCH
    else if (args[i] === '--no-latest-clean') opts.latestClean = false; // PATCH
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
run_pipeline.js - pick_highlights → export_replay → render_mp4(Top N) [+ portrait]

Usage: node scripts/run_pipeline.js [options]

Options:
  --top <N>         상위 N개 (기본 5)
  --min <score>     최소 점수 이상만 (기본 없음)
  --base <url>      base URL (기본 http://localhost:3000)
  --fps <int>       fps (기본 30)
  --speed <ms>      턴 간격 ms (기본 700)
  --width <int>     가로 (기본 1280)
  --height <int>    세로 (기본 720)
  --portrait <mode> none|pad|crop|both (기본 none)
  --pwidth <int>    portrait 가로 (기본 720)
  --pheight <int>   portrait 세로 (기본 1280)
  --latest          예상 파일명 존재 확인 후 latest-dir로 복사
  --latest-dir      latest 복사 대상 폴더 (기본 outputs/videos/latest)
  --latest-clean    latest 폴더 비우고 시작 (기본 true)
  --no-latest-clean latest 폴더 비우지 않음
  --help, -h        도움말
`);
      process.exit(0);
    }
  }
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
    console.error('[run_pipeline] ffmpeg-static not installed. Run: npm i ffmpeg-static');
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

// PATCH: top N match_ids 기준 예상 파일 경로 목록 (존재 확인용)
function getExpectedPaths(matchIds, opts) {
  const list = [];
  for (const mid of matchIds) {
    list.push(path.join(VIDEOS_DIR, `${mid}.mp4`));
    if (opts.portrait === 'pad' || opts.portrait === 'both') {
      list.push(path.join(VIDEOS_DIR, `${mid}_${opts.pwidth}x${opts.pheight}_pad.mp4`));
    }
    if (opts.portrait === 'crop' || opts.portrait === 'both') {
      list.push(path.join(VIDEOS_DIR, `${mid}_${opts.pwidth}x${opts.pheight}_crop.mp4`));
    }
  }
  return list;
}

async function main() {
  const opts = parseArgs();

  console.log('[run_pipeline] Checking base URL:', opts.base);
  const baseOk = await checkBaseAlive(opts.base);
  if (!baseOk) {
    console.error('[run_pipeline] Base URL not reachable. vercel dev 켜라');
    process.exit(1);
  }
  console.log('[run_pipeline] Base OK\n');

  // A) pick_highlights
  console.log('[run_pipeline] Step A: pick_highlights --top', opts.top);
  const pickArgs = ['--top', String(opts.top)];
  if (opts.min != null) pickArgs.push('--min', String(opts.min));
  if (!runNode('pick_highlights.js', pickArgs)) {
    console.error('[run_pipeline] pick_highlights failed');
    process.exit(1);
  }

  // B) export_replay
  console.log('\n[run_pipeline] Step B: export_replay --from', HIGHLIGHTS_PATH);
  if (!runNode('export_replay.js', ['--from', HIGHLIGHTS_PATH])) {
    console.error('[run_pipeline] export_replay failed');
    process.exit(1);
  }

  // C) load highlights, get top N match_ids
  if (!fs.existsSync(HIGHLIGHTS_PATH)) {
    console.error('[run_pipeline] highlights_top.json not found');
    process.exit(1);
  }
  let highlights;
  try {
    highlights = JSON.parse(fs.readFileSync(HIGHLIGHTS_PATH, 'utf8'));
  } catch (e) {
    console.error('[run_pipeline] Invalid highlights JSON:', e?.message);
    process.exit(1);
  }
  const arr = Array.isArray(highlights) ? highlights : [];
  const matchIds = arr
    .map((h) => h?.match_id ?? h?.matchId)
    .filter((id) => id != null && String(id).trim() !== '');
  const topN = Math.min(opts.top, matchIds.length);
  const toProcess = matchIds.slice(0, topN);

  fs.mkdirSync(VIDEOS_DIR, { recursive: true });

  const stats = { ok: 0, fail: 0, skip: 0 };

  // C) render_mp4 for each match
  console.log('\n[run_pipeline] Step C: render_mp4 for', toProcess.length, 'matches');
  for (let i = 0; i < toProcess.length; i++) {
    const mid = toProcess[i];
    const replayPath = path.join(REPLAYS_DIR, `${mid}.json`);
    if (!fs.existsSync(replayPath)) {
      console.warn(`[run_pipeline] ${i + 1}/${toProcess.length} skip ${mid} (replay not found)`);
      stats.skip++;
      continue;
    }

    const renderArgs = [
      '--file', replayPath,
      '--base', opts.base,
      '--fps', String(opts.fps),
      '--speed', String(opts.speed),
      '--width', String(opts.width),
      '--height', String(opts.height)
    ];

    const ok = runNode('render_mp4.js', renderArgs);
    if (ok) {
      stats.ok++;
    } else {
      console.warn(`[run_pipeline] ${i + 1}/${toProcess.length} ${mid} render failed`);
      stats.fail++;
    }
  }

  // D) portrait 후처리
  if (opts.portrait !== 'none') {
    const modes = opts.portrait === 'both' ? ['pad', 'crop'] : [opts.portrait];
    console.log('\n[run_pipeline] Step D: portrait', modes.join(', '));

    for (const mid of toProcess) {
      const mp4Path = findMp4ByMatchId(mid);
      if (!mp4Path || !fs.existsSync(mp4Path)) continue;

      for (const mode of modes) {
        const outName = `${mid}_${opts.pwidth}x${opts.pheight}_${mode}.mp4`;
        const outPath = path.join(VIDEOS_DIR, outName);
        const ok = runFfmpegPortrait(mp4Path, outPath, mode, opts.pwidth, opts.pheight);
        if (ok) {
          console.log('[run_pipeline] portrait saved:', outName);
        } else {
          console.warn('[run_pipeline] portrait failed:', outName);
        }
      }
    }
  }

  // PATCH: latest - 예상 파일명 존재 확인 후 latest-dir로 복사
  if (opts.latest) {
    const latestDir = path.isAbsolute(opts.latestDir) ? opts.latestDir : path.join(CWD, opts.latestDir);
    if (opts.latestClean && fs.existsSync(latestDir)) {
      try {
        const files = fs.readdirSync(latestDir);
        for (const f of files) {
          fs.unlinkSync(path.join(latestDir, f));
        }
      } catch (e) {
        console.warn('[run_pipeline] latest-clean failed:', e?.message);
      }
    }
    fs.mkdirSync(latestDir, { recursive: true });
    const expected = getExpectedPaths(toProcess, opts);
    let copied = 0;
    for (const src of expected) {
      if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        const name = path.basename(src);
        const dest = path.join(latestDir, name);
        try {
          fs.copyFileSync(src, dest);
          copied++;
        } catch (e) {
          console.warn('[run_pipeline] copy failed:', name, e?.message);
        }
      }
    }
    console.log('\n[run_pipeline] copied', copied, 'files');
  }

  // 요약
  console.log('\n[run_pipeline] Done.');
  console.log('  ok:', stats.ok, ' fail:', stats.fail, ' skip:', stats.skip);
}

main().catch((err) => {
  console.error('[run_pipeline]', err?.message || err);
  process.exit(1);
});

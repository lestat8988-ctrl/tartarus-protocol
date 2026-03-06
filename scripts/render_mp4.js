#!/usr/bin/env node
/**
 * render_mp4.js - replay JSON을 재생하면서 CDP screencast로 녹화 후 ffmpeg로 mp4 생성
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    file: null,
    from: null, // PATCH: highlights_top.json 경로
    top: null, // PATCH: 상위 N개 (null이면 전부)
    base: 'http://localhost:3000',
    speed: 700,
    fps: 30,
    width: 1280,
    height: 720,
    out: 'outputs/videos',
    keepFrames: false,
    portrait: null, // PATCH: 'pad' | 'crop' | null
    pwidth: 720,
    pheight: 1280
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) opts.file = args[++i];
    else if (args[i] === '--from' && args[i + 1]) opts.from = args[++i]; // PATCH
    else if (args[i] === '--top' && args[i + 1]) { opts.top = Math.max(1, parseInt(args[i + 1], 10) || 9999); i++; } // PATCH
    else if (args[i] === '--base' && args[i + 1]) opts.base = args[++i];
    else if (args[i] === '--speed' && args[i + 1]) {
      opts.speed = Math.max(0, parseInt(args[i + 1], 10) || 700);
      i++;
    } else if (args[i] === '--fps' && args[i + 1]) {
      opts.fps = Math.max(1, parseInt(args[i + 1], 10) || 30);
      i++;
    } else if (args[i] === '--width' && args[i + 1]) {
      opts.width = Math.max(320, parseInt(args[i + 1], 10) || 1280);
      i++;
    } else if (args[i] === '--height' && args[i + 1]) {
      opts.height = Math.max(240, parseInt(args[i + 1], 10) || 720);
      i++;
    } else if (args[i] === '--out' && args[i + 1]) opts.out = args[++i];
    else if (args[i] === '--keep-frames') opts.keepFrames = true;
    else if (args[i] === '--portrait' && args[i + 1]) { // PATCH
      const v = (args[++i] || '').toLowerCase();
      opts.portrait = (v === 'pad' || v === 'crop') ? v : null;
    }
    else if (args[i] === '--pwidth' && args[i + 1]) { opts.pwidth = Math.max(320, parseInt(args[i + 1], 10) || 720); i++; } // PATCH
    else if (args[i] === '--pheight' && args[i + 1]) { opts.pheight = Math.max(480, parseInt(args[i + 1], 10) || 1280); i++; } // PATCH
  }
  opts.pwidth = opts.pwidth ?? 720; // PATCH
  opts.pheight = opts.pheight ?? 1280; // PATCH
  return opts;
}

function ensureDep(name, pkg, installCmd) {
  try {
    require.resolve(pkg);
    return require(pkg);
  } catch (_) {
    console.error(`[render_mp4] ${name} is not installed.`);
    console.error(`Run: ${installCmd}`);
    process.exit(1);
  }
}

function loadReplayData(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  if (!fs.existsSync(abs)) return null; // PATCH: batch에서 skip용
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    console.error('[render_mp4] Invalid JSON:', abs, e?.message);
    return null;
  }
}

function loadHighlightsAndGetMatchIds(fromPath, topN) {
  const abs = path.isAbsolute(fromPath) ? fromPath : path.join(process.cwd(), fromPath);
  if (!fs.existsSync(abs)) {
    console.error('[render_mp4] highlights file not found:', abs);
    process.exit(1);
  }
  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    console.error('[render_mp4] Invalid highlights JSON:', e?.message);
    process.exit(1);
  }
  const list = Array.isArray(arr) ? arr : [];
  const ids = list
    .map((h) => h?.match_id ?? h?.matchId)
    .filter((id) => id != null && String(id).trim() !== '');
  const n = topN != null ? Math.min(topN, ids.length) : ids.length;
  return ids.slice(0, n); // PATCH
}

function getTurns(data) {
  if (Array.isArray(data?.turns)) return data.turns;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function getActionInfo(entry) {
  const act = entry?.action ?? null;
  const type = (act?.type ?? act?.actionType ?? entry?.actionType ?? entry?.type ?? '')
    .toString()
    .toLowerCase();
  const text = (act?.text ?? act?.value ?? entry?.text ?? entry?.value ?? '').toString().trim();
  return { type, text };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForLogUpdate(page, prevCount, maxMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const count = await page.evaluate(() => document.querySelectorAll('#log .line').length).catch(() => 0);
    if (count > prevCount) return;
    await sleep(100);
  }
}

function runFfmpeg(framesDir, outputPath, fps) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = require('ffmpeg-static');
    const absOut = path.isAbsolute(outputPath) ? outputPath : path.join(process.cwd(), outputPath);
    const args = [
      '-y',
      '-framerate', String(fps),
      '-i', path.join(framesDir, 'frame_%06d.png'),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      absOut
    ];
    const proc = spawn(ffmpegPath, args, { cwd: framesDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function runFfmpegPortrait(inputMp4, outputMp4, mode, pw, ph) {
  const padFilter = `scale=${pw}:${ph}:force_original_aspect_ratio=decrease,pad=${pw}:${ph}:(ow-iw)/2:(oh-ih)/2,setsar=1`; // PATCH
  const cropFilter = `scale=${pw}:${ph}:force_original_aspect_ratio=increase,crop=${pw}:${ph},setsar=1`; // PATCH
  const vf = mode === 'pad' ? padFilter : cropFilter;
  return new Promise((resolve, reject) => {
    const ffmpegPath = require('ffmpeg-static');
    const args = ['-y', '-i', inputMp4, '-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outputMp4];
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg portrait exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function runReplayAndRecord(opts) {
  const puppeteer = ensureDep('puppeteer', 'puppeteer', 'npm i puppeteer');
  const data = loadReplayData(opts.file);
  if (!data) throw new Error(`Replay file not found: ${opts.file}`); // PATCH
  const turns = getTurns(data);
  const matchId = data?.match_id || path.basename(opts.file, '.json').replace(/[^a-zA-Z0-9_-]/g, '_');

  const framesDir = path.join(process.cwd(), 'outputs', '_frames', matchId);
  const outDir = path.isAbsolute(opts.out) ? opts.out : path.join(process.cwd(), opts.out);
  const mp4Path = path.join(outDir, `${matchId}.mp4`);

  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  let frameIndex = 0;
  let cdpClient = null;
  let browser = null;

  const cleanup = async () => {
    if (cdpClient) {
      try {
        await cdpClient.send('Page.stopScreencast').catch(() => {});
      } catch (_) {}
    }
    if (browser) {
      try {
        await browser.close().catch(() => {});
      } catch (_) {}
    }
    if (!opts.keepFrames && fs.existsSync(framesDir)) {
      try {
        fs.rmSync(framesDir, { recursive: true });
      } catch (_) {}
    }
  };

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: opts.width, height: opts.height });

    cdpClient = await page.target().createCDPSession();
    await cdpClient.send('Page.enable');

    cdpClient.on('Page.screencastFrame', async (frame) => {
      frameIndex++;
      const num = String(frameIndex).padStart(6, '0');
      const buf = Buffer.from(frame.data, 'base64');
      fs.writeFileSync(path.join(framesDir, `frame_${num}.png`), buf);
      await cdpClient.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
    });

    await cdpClient.send('Page.startScreencast', {
      format: 'png',
      quality: 100,
      everyNthFrame: 1
    });

    await page.goto(opts.base, { waitUntil: 'networkidle0', timeout: 15000 }).catch(() => {});

    await sleep(800);

    const introVisible = await page.evaluate(() => {
      const el = document.getElementById('intro-screen');
      return el && !el.classList.contains('hidden');
    }).catch(() => false);
    if (introVisible) {
      await page.keyboard.press('Enter');
      await sleep(2500);
      const stillIntro = await page.evaluate(() => {
        const el = document.getElementById('intro-screen');
        return el && !el.classList.contains('hidden');
      }).catch(() => true);
      if (stillIntro) {
        await page.keyboard.press('Enter');
        await sleep(1000);
      }
    }

    await page.waitForSelector('#input, #log', { timeout: 10000 }).catch(() => {});

    for (let i = 0; i < turns.length; i++) {
      const entry = turns[i];
      const { type, text } = getActionInfo(entry);

      if (!type) {
        console.log(`${i + 1}/${turns.length} skip (no action type)`);
        await sleep(opts.speed);
        continue;
      }

      const prevLogCount = await page.evaluate(() => document.querySelectorAll('#log .line').length).catch(() => 0);

      try {
        if (type === 'interrogate') {
          const clicked = await page.evaluate(() => {
            const b = document.querySelector('button.action-btn[data-msg="interrogate"]')
              || Array.from(document.querySelectorAll('button')).find((x) => /INTERROGATE/i.test(x.textContent || ''));
            if (b) { b.click(); return true; }
            return false;
          }).catch(() => false);
          console.log(`${i + 1}/${turns.length} interrogate${clicked ? '' : ' (skip)'}`);
        } else if (type === 'cctv') {
          const clicked = await page.evaluate(() => {
            const b = document.querySelector('button.action-btn[data-msg="cctv"]')
              || Array.from(document.querySelectorAll('button')).find((x) => /CCTV/i.test(x.textContent || ''));
            if (b) { b.click(); return true; }
            return false;
          }).catch(() => false);
          console.log(`${i + 1}/${turns.length} cctv${clicked ? '' : ' (skip)'}`);
        } else if (type === 'engine') {
          const clicked = await page.evaluate(() => {
            const b = document.querySelector('button.action-btn[data-msg="engine"]')
              || Array.from(document.querySelectorAll('button')).find((x) => /ENGINE/i.test(x.textContent || ''));
            if (b) { b.click(); return true; }
            return false;
          }).catch(() => false);
          console.log(`${i + 1}/${turns.length} engine${clicked ? '' : ' (skip)'}`);
        } else if (type === 'message') {
          const input = (await page.$('#input')) || (await page.$('input[placeholder*="Enter command"], input[placeholder*="명령"], input[type="text"]')) || null;
          if (input) {
            const toType = text || 'INTERROGATE';
            await input.click({ clickCount: 3 });
            await input.type(toType, { delay: 50 });
            await page.keyboard.press('Enter');
            console.log(`${i + 1}/${turns.length} message "${toType}"`);
          } else {
            console.log(`${i + 1}/${turns.length} message (skip)`);
          }
        } else if (type === 'accuse') {
          const target = ((entry?.action?.target ?? entry?.target ?? text) || 'Navigator').trim();
          const result = await page.evaluate((t) => {
            const accuseBtn = Array.from(document.querySelectorAll('button')).find((b) => /ACCUSE|PURGE|고발/i.test(b.textContent || ''));
            if (!accuseBtn) return 'no_accuse_ui';
            accuseBtn.click();
            return 'opened';
          }, target).catch(() => 'error');
          if (result === 'no_accuse_ui') {
            console.warn(`[render_mp4] ${i + 1}/${turns.length} accuse: UI not found, skip`);
          } else if (result === 'opened') {
            await sleep(400);
            const targetClicked = await page.evaluate((t) => {
              const btns = Array.from(document.querySelectorAll('button.target-btn[data-role]'));
              const btn = btns.find((b) => b.dataset.role === t || b.textContent?.trim() === t) || btns.find((b) => !b.disabled);
              if (btn && !btn.disabled) { btn.click(); return true; }
              return false;
            }, target).catch(() => false);
            console.log(`${i + 1}/${turns.length} accuse target=${target}${targetClicked ? '' : ' (skip)'}`);
          }
        } else if (type === 'auto-kill' || type === 'witness') {
          console.log(`${i + 1}/${turns.length} ${type} (skip)`);
        } else {
          console.log(`${i + 1}/${turns.length} ${type} (skip)`);
        }
      } catch (err) {
        console.warn(`[render_mp4] ${i + 1}/${turns.length} ${type} failed:`, err?.message || err);
      }

      await waitForLogUpdate(page, prevLogCount, 3000);
      await sleep(opts.speed);
    }

    await sleep(500);
    await cdpClient.send('Page.stopScreencast');
    await sleep(300);

    await browser.close();
    browser = null;

    if (frameIndex === 0) {
      console.error('[render_mp4] No frames captured.');
      return;
    }

    ensureDep('ffmpeg-static', 'ffmpeg-static', 'npm i ffmpeg-static');
    await runFfmpeg(framesDir, mp4Path, opts.fps);

    if (opts.portrait === 'pad' || opts.portrait === 'crop') {
      const pw = opts.pwidth ?? 720;
      const ph = opts.pheight ?? 1280;
      const portraitName = `${matchId}_${pw}x${ph}_${opts.portrait}.mp4`;
      const portraitPath = path.join(outDir, portraitName);
      await runFfmpegPortrait(mp4Path, portraitPath, opts.portrait, pw, ph); // PATCH
      console.log('SAVED:', portraitPath);
    }

    if (!opts.keepFrames && fs.existsSync(framesDir)) {
      fs.rmSync(framesDir, { recursive: true });
    }

    console.log('SAVED:', mp4Path);
  } finally {
    await cleanup();
  }
}

async function runBatch(opts) {
  const matchIds = loadHighlightsAndGetMatchIds(opts.from, opts.top); // PATCH
  const replaysDir = path.join(process.cwd(), 'outputs', 'replays');
  let ok = 0;
  let fail = 0;
  let skip = 0; // PATCH: replay 파일 없음
  for (let i = 0; i < matchIds.length; i++) {
    const mid = matchIds[i];
    const replayPath = path.join(replaysDir, `${mid}.json`);
    if (!fs.existsSync(replayPath)) {
      console.warn(`[render_mp4] ${i + 1}/${matchIds.length} skip ${mid} (replay not found)`); // PATCH
      skip++;
      continue;
    }
    const singleOpts = { ...opts, file: replayPath };
    try {
      await runReplayAndRecord(singleOpts);
      ok++;
    } catch (err) {
      console.warn(`[render_mp4] ${i + 1}/${matchIds.length} ${mid} failed:`, err?.message || err); // PATCH
      fail++;
    }
  }
  console.log(`\n[render_mp4] Batch done: ${ok} ok, ${fail} failed, ${skip} skipped`); // PATCH
}

function main() {
  const opts = parseArgs();

  if (opts.from) {
    // PATCH: 일괄 렌더
    runBatch(opts).catch((err) => {
      console.error('[render_mp4]', err?.message || err);
      process.exit(1);
    });
    return;
  }

  if (!opts.file) {
    console.error('Usage: node render_mp4.js --file <match_json_path> [options]');
    console.error('   or: node render_mp4.js --from <highlights_top.json> [--top <N>] [options]');
    console.error('Options: --base, --speed, --fps, --width, --height, --out, --keep-frames');
    console.error('         --portrait pad|crop, --pwidth, --pheight'); // PATCH
    process.exit(1);
  }

  runReplayAndRecord(opts).catch((err) => {
    console.error('[render_mp4]', err?.message || err);
    process.exit(1);
  });
}

main();

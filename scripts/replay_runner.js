#!/usr/bin/env node
/**
 * replay_runner.js - outputs/replays/match_*.json 재생
 * Puppeteer로 로컬 서버에서 액션 순서대로 재현
 */
const fs = require('fs');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { file: null, base: 'http://localhost:3000', speed: 800, headless: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      opts.file = args[++i];
    } else if (args[i] === '--base' && args[i + 1]) {
      opts.base = args[++i];
    } else if (args[i] === '--speed' && args[i + 1]) {
      opts.speed = Math.max(0, parseInt(args[i + 1], 10) || 800);
      i++;
    } else if (args[i] === '--headless') {
      opts.headless = true;
    }
  }
  return opts;
}

function ensurePuppeteer() {
  try {
    require.resolve('puppeteer');
    return require('puppeteer');
  } catch (_) {
    console.error('[replay_runner] puppeteer is not installed.');
    console.error('Run: npm i puppeteer');
    process.exit(1);
  }
}

function loadReplayData(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    console.error('[replay_runner] File not found:', abs);
    process.exit(1);
  }
  const raw = fs.readFileSync(abs, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('[replay_runner] Invalid JSON:', e?.message);
    process.exit(1);
  }
}

function getTurns(data) {
  if (Array.isArray(data?.turns)) return data.turns;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

function getActionInfo(entry) {
  const act = entry?.action ?? null;
  const type = (act?.type ?? act?.actionType ?? entry?.actionType ?? entry?.type ?? '').toString().toLowerCase();
  const text = (act?.text ?? act?.value ?? entry?.text ?? entry?.value ?? '').toString().trim();
  return { type, text };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForLogUpdate(page, prevCount, maxMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const count = await page.evaluate(() => document.querySelectorAll('#log .line').length);
    if (count > prevCount) return;
    await sleep(100);
  }
}

async function runReplay(opts) {
  const puppeteer = ensurePuppeteer();
  const data = loadReplayData(opts.file);
  const turns = getTurns(data);

  if (turns.length === 0) {
    console.log('[replay_runner] No turns/items found.');
    console.log('DONE');
    return;
  }

  const browser = await puppeteer.launch({
    headless: opts.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
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

    const prevLogCount = await page.evaluate(() => document.querySelectorAll('#log .line').length);

    try {
      if (type === 'interrogate') {
        const clicked = await page.evaluate(() => {
          const b = document.querySelector('button.action-btn[data-msg="interrogate"]')
            || Array.from(document.querySelectorAll('button')).find((x) => /INTERROGATE/i.test(x.textContent || ''));
          if (b) { b.click(); return true; }
          return false;
        }).catch(() => false);
        console.log(`${i + 1}/${turns.length} interrogate${clicked ? '' : ' (button not found, skip)'}`);
      } else if (type === 'cctv') {
        const clicked = await page.evaluate(() => {
          const b = document.querySelector('button.action-btn[data-msg="cctv"]')
            || Array.from(document.querySelectorAll('button')).find((x) => /CCTV/i.test(x.textContent || ''));
          if (b) { b.click(); return true; }
          return false;
        }).catch(() => false);
        console.log(`${i + 1}/${turns.length} cctv${clicked ? '' : ' (button not found, skip)'}`);
      } else if (type === 'engine') {
        const clicked = await page.evaluate(() => {
          const b = document.querySelector('button.action-btn[data-msg="engine"]')
            || Array.from(document.querySelectorAll('button')).find((x) => /ENGINE/i.test(x.textContent || ''));
          if (b) { b.click(); return true; }
          return false;
        }).catch(() => false);
        console.log(`${i + 1}/${turns.length} engine${clicked ? '' : ' (button not found, skip)'}`);
      } else if (type === 'message') {
        const input = (await page.$('#input')) || (await page.$('input[type="text"]')) || null;
        if (input) {
          const toType = text || 'INTERROGATE';
          await input.click({ clickCount: 3 });
          await input.type(toType, { delay: 50 });
          await page.keyboard.press('Enter');
          console.log(`${i + 1}/${turns.length} message "${toType}"`);
        } else {
          console.log(`${i + 1}/${turns.length} message (input not found, skip)`);
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
          console.warn(`[replay_runner] ${i + 1}/${turns.length} accuse: accuse UI not found, skip`);
        } else if (result === 'opened') {
          await sleep(400);
          const targetClicked = await page.evaluate((t) => {
            const btns = Array.from(document.querySelectorAll('button.target-btn[data-role]'));
            const btn = btns.find((b) => b.dataset.role === t || b.textContent?.trim() === t) || btns.find((b) => !b.disabled);
            if (btn && !btn.disabled) { btn.click(); return true; }
            return false;
          }, target).catch(() => false);
          console.log(`${i + 1}/${turns.length} accuse target=${target}${targetClicked ? '' : ' (target not found, skip)'}`);
        }
      } else if (type === 'auto-kill' || type === 'witness') {
        console.log(`${i + 1}/${turns.length} ${type} (skip, no UI)`);
      } else {
        console.log(`${i + 1}/${turns.length} ${type} (unknown, skip)`);
      }
    } catch (err) {
      console.warn(`[replay_runner] ${i + 1}/${turns.length} ${type} failed:`, err?.message || err);
    }

    await waitForLogUpdate(page, prevLogCount, 3000);
    await sleep(opts.speed);
  }

  await browser.close();
  console.log('DONE');
}

function main() {
  const opts = parseArgs();

  if (!opts.file) {
    console.error('Usage: node replay_runner.js --file <match_json_path> [--base <url>] [--speed <ms>] [--headless]');
    process.exit(1);
  }

  runReplay(opts).catch((err) => {
    console.error('[replay_runner]', err?.message || err);
    process.exit(1);
  });
}

main();

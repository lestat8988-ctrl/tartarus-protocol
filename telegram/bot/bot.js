/**
 * telegram/bot/bot.js - 텔레그램 봇 진입점
 * 1차 런칭용 뼈대. core 엔진과 연결 예정.
 */

// const TelegramBot = require('node-telegram-bot-api');
// const matchStore = require('../../core/state/matchStore');
// const playerStore = require('../../core/state/playerStore');
// const ep1Engine = require('../../core/engine/ep1Engine');
// const intentParser = require('../../core/nlu/intentParser');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

/**
 * 봇 초기화 (스텁)
 */
function initBot() {
  if (!BOT_TOKEN) {
    console.warn('[bot] TELEGRAM_BOT_TOKEN not set. Bot disabled.');
    return null;
  }
  // const bot = new TelegramBot(BOT_TOKEN, { polling: true });
  // bot.on('message', onMessage);
  console.log('[bot] Telegram bot skeleton ready.');
  return {};
}

/**
 * @param {object} msg - Telegram message
 */
async function onMessage(msg) {
  const chatId = msg.chat?.id;
  const text = msg.text || '';
  if (!chatId) return;

  // 스텁: 에코 응답
  // await bot.sendMessage(chatId, `Received: ${text.slice(0, 50)}`);
  console.log('[bot] message:', chatId, text.slice(0, 50));
}

/**
 * Webhook 모드 (선택)
 * @param {object} req - Express req
 * @param {object} res - Express res
 */
async function handleWebhook(req, res) {
  const body = req.body || {};
  if (body.message) {
    await onMessage(body.message);
  }
  res.status(200).send();
}

module.exports = { initBot, onMessage, handleWebhook };

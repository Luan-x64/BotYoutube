const TelegramBot = require('node-telegram-bot-api');

// suas credenciais
const botChave = '';
const chatIdKey = ''; // opcional 


const bot = new TelegramBot(botChave, { polling: true });

module.exports = {
  bot,
  botChave,
  chatIdKey
};
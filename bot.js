const ADMIN_ID = 2; // SUBSTITUA PELO SEU ID
const { bot } = require('./configBot');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { saveDownload } = require('./database');
const archiver = require('archiver');

const stateFile = path.join(__dirname, 'queue.json');
const downloadDir = path.join(__dirname, 'downloads');

if (!fs.existsSync(downloadDir)) {
  fs.mkdirSync(downloadDir, { recursive: true });
}

// =============================
// FILA E ESTADO
// =============================
const queue = [];
let processing = false;
const chatQueueCount = {};

function isYoutubeLink(text) {
  return text.includes('youtube.com') || text.includes('youtu.be');
}

function getUserDir(chatId) {
  const dir = path.join(downloadDir, String(chatId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let output = '';
    ffprobe.stdout.on('data', (data) => output += data.toString());
    ffprobe.on('close', (code) => {
      if (code === 0) {
        const duration = parseFloat(output.trim());
        resolve(isNaN(duration) ? 0 : duration);
      } else {
        reject(new Error('ffprobe falhou'));
      }
    });
    ffprobe.on('error', reject);
  });
}

function saveState(currentProcessing = null) {
  const data = {
    queue: queue.map(job => ({
      chatId: job.chatId,
      text: job.text,
      msg: job.msg
    })),
    processing: currentProcessing
  };
  fs.writeFileSync(stateFile, JSON.stringify(data, null, 2));
}

function rebuildQueueCounts() {
  for (let key in chatQueueCount) delete chatQueueCount[key];
  for (const job of queue) {
    const cid = job.chatId;
    if (!chatQueueCount[cid]) chatQueueCount[cid] = 0;
    chatQueueCount[cid]++;
  }
  console.log('📊 Contadores restaurados:', chatQueueCount);
}

function loadState() {
  if (!fs.existsSync(stateFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    queue.length = 0;
    if (data.queue) {
      data.queue.forEach(item => {
        queue.push({
          chatId: item.chatId,
          text: item.text,
          msg: item.msg,
          run: () => processDownload(item.chatId, item.text, item.msg)
        });
      });
    }
    if (data.processing) {
      queue.unshift({
        chatId: data.processing.chatId,
        text: data.processing.text,
        msg: data.processing.msg,
        run: () => processDownload(data.processing.chatId, data.processing.text, data.processing.msg)
      });
    }
    rebuildQueueCounts();
    console.log('♻️ Fila restaurada com sucesso!');
  } catch (err) {
    console.error('Erro ao carregar estado:', err);
  }
}

async function zipAdminMusic(adminId, statusMsgId) {
  const adminDir = getUserDir(adminId);
  const files = fs.readdirSync(adminDir).filter(f => f.endsWith('.mp3'));
  if (files.length === 0) {
    throw new Error('Nenhuma música encontrada para zipar.');
  }

  let totalSize = 0;
  const fileSizes = [];
  for (const file of files) {
    const filePath = path.join(adminDir, file);
    const size = fs.statSync(filePath).size;
    totalSize += size;
    fileSizes.push({ name: file, size });
  }
  const totalSizeMB = (totalSize / 1024 / 1024).toFixed(2);
  console.log(`📦 Iniciando zip de ${files.length} arquivos (${totalSizeMB} MB no total)`);

  const zipPath = path.join('/tmp', `admin_${adminId}_${Date.now()}.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const startTime = Date.now();
  let processedBytes = 0;
  let processedFiles = 0;

  const updateTelegram = async () => {
    if (!statusMsgId) return;
    const elapsedSec = (Date.now() - startTime) / 1000;
    const percent = (processedBytes / totalSize) * 100;
    const speedMBps = processedBytes / elapsedSec / 1024 / 1024;
    const remainingBytes = totalSize - processedBytes;
    const remainingSec = remainingBytes / (processedBytes / elapsedSec);
    const remainingMin = (remainingSec / 60).toFixed(1);
    const speedText = speedMBps.toFixed(2);
    const text = `🗜️ Compactando: ${percent.toFixed(1)}% (${(processedBytes/1024/1024).toFixed(2)} MB de ${totalSizeMB} MB)\n📊 Velocidade: ${speedText} MB/s\n⏳ Tempo restante: ~${remainingMin} min`;
    try {
      await bot.editMessageText(text, {
        chat_id: adminId,
        message_id: statusMsgId
      });
    } catch (e) {}
  };

  return new Promise((resolve, reject) => {
    archive.on('entry', async (entry) => {
      const fileIndex = processedFiles;
      if (fileIndex < fileSizes.length) {
        processedBytes += fileSizes[fileIndex].size;
      }
      processedFiles++;
      console.log(`➕ Adicionado: ${entry.name} (${(fileSizes[fileIndex]?.size / 1024 / 1024).toFixed(2)} MB) - Total: ${(processedBytes/1024/1024).toFixed(2)} MB`);
      const updateInterval = files.length > 50 ? 5 : 1;
      if (processedFiles % updateInterval === 0 || processedFiles === files.length) {
        await updateTelegram();
      }
    });
    output.on('close', () => {
      const finalSizeMB = (archive.pointer() / 1024 / 1024).toFixed(2);
      console.log(`✅ Zip finalizado: ${zipPath} (${finalSizeMB} MB)`);
      resolve(zipPath);
    });
    archive.on('error', (err) => reject(err));
    archive.pipe(output);
    for (const file of files) {
      const filePath = path.join(adminDir, file);
      archive.file(filePath, { name: file });
    }
    archive.finalize();
  });
}

async function processDownload(chatId, url, originalMsg) {
  const firstName = originalMsg?.from?.first_name || '';
  const lastName = originalMsg?.from?.last_name || '';
  const username = originalMsg?.from?.username || '';
  const nomeCompleto = `${firstName} ${lastName}`.trim();
  const userDir = getUserDir(chatId);

  let progressMsg = await bot.sendMessage(
    chatId,
    `⏳ Baixando...\n📊 Restantes: ${chatQueueCount[chatId] - 1 || 0}`
  );

  try {
    const args = [
      '--js-runtimes', 'node:/usr/bin/node',
      '-f', '140/251/18',
      '--no-playlist',
      '--print', 'title',
      '--print', 'after_move:filepath',
      '-o', path.join(userDir, '%(title)s.%(ext)s'),
      url
    ];

    const yt = spawn('/usr/local/bin/yt-dlp', args, { env: process.env });
    let videoTitle = '';
    let downloadedFile = '';
    let lastPercent = '';

    yt.stdout.on('data', async (data) => {
      const output = data.toString();
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes(userDir)) downloadedFile = line.trim();
        if (!videoTitle && line && !line.includes('%')) videoTitle = line.trim();
      }
      const match = output.match(/(\d{1,3}\.\d+)%/);
      if (match && match[1] !== lastPercent) {
        lastPercent = match[1];
        try {
          await bot.editMessageText(
            `📥 Baixando: ${lastPercent}%\n📊 Restantes: ${chatQueueCount[chatId] - 1 || 0}`,
            { chat_id: chatId, message_id: progressMsg.message_id }
          );
        } catch (e) {}
      }
    });

    yt.stderr.on('data', (data) => console.error('yt-dlp stderr:', data.toString()));
    await new Promise(resolve => yt.on('close', resolve));

    if (!downloadedFile || !fs.existsSync(downloadedFile)) {
      throw new Error('Arquivo não encontrado após download');
    }

    const inputPath = downloadedFile;
    const outputPath = inputPath.replace(/\.(mp4|webm|m4a)$/, '.mp3');

    let totalDuration = 0;
    try {
      totalDuration = await getAudioDuration(inputPath);
      console.log(`🎵 Duração total do áudio: ${totalDuration.toFixed(2)} segundos`);
    } catch (err) {
      console.log('Não foi possível obter duração, estimativa não disponível');
    }

    await bot.editMessageText(
      `🎧 Convertendo...\n📊 Restantes: ${chatQueueCount[chatId] - 1 || 0}`,
      { chat_id: chatId, message_id: progressMsg.message_id }
    );

    let conversionStart = Date.now();
    let lastUpdateTime = 0;

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', [
        '-i', inputPath,
        '-vn',
        '-acodec', 'libmp3lame',
        '-ab', '192k',
        '-ar', '44100',
        '-y',
        outputPath
      ]);

      ff.stderr.on('data', async (data) => {
        const str = data.toString();
        console.log('FFMPEG:', str);
        const timeMatch = str.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/);
        if (timeMatch && totalDuration > 0) {
          const hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const seconds = parseFloat(timeMatch[3]);
          const currentTime = hours * 3600 + minutes * 60 + seconds;
          const percent = (currentTime / totalDuration) * 100;
          const elapsedSec = (Date.now() - conversionStart) / 1000;
          const speed = currentTime / elapsedSec;
          let remainingSec = 0;
          if (speed > 0) remainingSec = (totalDuration - currentTime) / speed;
          let timeStr = '';
          if (remainingSec < 60) timeStr = `${Math.round(remainingSec)} segundos`;
          else if (remainingSec < 3600) {
            const mins = Math.floor(remainingSec / 60);
            const secs = Math.round(remainingSec % 60);
            timeStr = `${mins} min ${secs} s`;
          } else {
            const hrs = Math.floor(remainingSec / 3600);
            const mins = Math.floor((remainingSec % 3600) / 60);
            timeStr = `${hrs}h ${mins}min`;
          }
          const now = Date.now();
          if (now - lastUpdateTime > 2000) {
            lastUpdateTime = now;
            try {
              await bot.editMessageText(
                `🎧 Convertendo: ${percent.toFixed(1)}%\n⏳ Tempo restante: ${timeStr}\n📊 Restantes: ${chatQueueCount[chatId] - 1 || 0}`,
                { chat_id: chatId, message_id: progressMsg.message_id }
              );
            } catch (e) {}
          }
        }
      });

      ff.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('ffmpeg code ' + code));
      });
      ff.on('error', reject);
    });
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      console.log('🧹 Original removido:', inputPath);
    } catch (err) {
      console.log('⚠️ Erro ao remover original:', err);
    }
    await bot.editMessageText(`📤 Enviando...`, { chat_id: chatId, message_id: progressMsg.message_id });

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error('MP3 corrompido ou não encontrado');
    }

    await bot.sendAudio(chatId, outputPath, {
      title: videoTitle || path.basename(outputPath),
      performer: 'YouTube Bot'
    });

    saveDownload({
      title: videoTitle || path.basename(outputPath),
      url: url,
      user_name: nomeCompleto,
      username: username,
      chat_id: chatId
    });

    await bot.editMessageText(`✅ Salvo e enviado!`, { chat_id: chatId, message_id: progressMsg.message_id });

  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, '❌ Erro inesperado no processamento.');
  } finally {
    if (chatQueueCount[chatId] > 0) chatQueueCount[chatId]--;
  }
}

function addToQueue(chatId, url, msg) {
  if (!chatQueueCount[chatId]) chatQueueCount[chatId] = 0;
  chatQueueCount[chatId]++;

  const job = {
    chatId,
    text: url,
    msg,
    run: () => processDownload(chatId, url, msg)
  };
  queue.push(job);
  saveState(job);

  bot.sendMessage(chatId, `📥 Adicionado à fila\n📊 Posição: ${chatQueueCount[chatId]}`);
  runQueue();
}

async function runQueue() {
  if (processing) return;
  if (queue.length === 0) return;

  processing = true;
  const job = queue.shift();
  saveState(job);

  try {
    await job.run();
  } catch (err) {
    console.error('Erro no job:', err);
  }

  saveState(null);
  processing = false;
  runQueue();
}

async function processRecovered(item) {
  const fakeMsg = { chat: { id: item.chatId }, from: {}, text: item.text };
  console.log('🔄 Reprocessando:', item.text);
  await processDownload(item.chatId, item.text, fakeMsg);
  runQueue();
}

// =============================
// COMANDOS DO BOT
// =============================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === '/' || text === '/help' || text === '/ajuda') {
    if (chatId === ADMIN_ID) {
      return bot.sendMessage(chatId, '📋 Menu (Admin):', {
        reply_markup: {
          keyboard: [
            ['/lista'],
            ['/limpar'],
            ['/zipar'],
            ['/enviar_todas']
          ],
          resize_keyboard: true
        }
      });
    }
    return bot.sendMessage(chatId, '📋 Menu:', {
      reply_markup: {
        keyboard: [
          ['/lista']
        ],
        resize_keyboard: true
      }
    });
  }
  if (text === '/enviar_todas') {
    const userDir = getUserDir(chatId);
    const files = fs.readdirSync(userDir).filter(f => f.endsWith('.mp3'));
    if (files.length === 0) {
      return bot.sendMessage(chatId, '📂 Você ainda não tem nenhuma música baixada.');
    }
    await bot.sendMessage(chatId, `📤 Enviando todas as suas ${files.length} músicas... Isso pode levar alguns instantes.`);
    let sent = 0;
    for (const file of files) {
      const filePath = path.join(userDir, file);
      try {
        await bot.sendAudio(chatId, filePath, {
          title: file.replace(/\.mp3$/, ''),
          performer: 'YouTube Bot'
        });
        sent++;
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (err) {
        console.error(`Erro ao enviar ${file}:`, err);
      }
    }
    await bot.sendMessage(chatId, `✅ Enviadas ${sent} de ${files.length} músicas.`);
    return;
  }

  if (text === '/zipar') {
    if (chatId !== ADMIN_ID) {
      return bot.sendMessage(chatId, '❌ Apenas o administrador pode usar este comando.');
    }
    if (queue.length > 0 || processing === true) {
      return bot.sendMessage(chatId, '⏳ Existem downloads pendentes. Aguarde a fila terminar.');
    }
    const statusMsg = await bot.sendMessage(chatId, '🗜️ Preparando compactação...');
    const statusMsgId = statusMsg.message_id;
    try {
      const zipFilePath = await zipAdminMusic(chatId, statusMsgId);
      const stats = fs.statSync(zipFilePath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      await bot.editMessageText(`📤 Enviando arquivo ZIP (${sizeMB} MB)...`, {
        chat_id: chatId,
        message_id: statusMsgId
      });
      await bot.sendDocument(chatId, zipFilePath, {
        caption: `📦 Todas as suas músicas (${sizeMB} MB)`
      });
      fs.unlinkSync(zipFilePath);
      await bot.editMessageText('✅ Zip criado e enviado com sucesso!', {
        chat_id: chatId,
        message_id: statusMsgId
      });
    } catch (err) {
      console.error(err);
      await bot.editMessageText(`❌ Erro ao zipar: ${err.message}`, {
        chat_id: chatId,
        message_id: statusMsgId
      });
    }
    return;
  }

  if (text === '/limpar') {
    if (chatId !== ADMIN_ID) {
      return bot.sendMessage(chatId, '❌ Sem permissão.');
    }
    try {
      const users = fs.readdirSync(downloadDir);
      if (users.length === 0) return bot.sendMessage(chatId, '📂 Nenhuma pasta encontrada.');
      let msgText = '📂 Pastas:\n\n';
      const keyboard = [];
      users.forEach(user => {
        const userPath = path.join(downloadDir, user);
        if (fs.lstatSync(userPath).isDirectory()) {
          const files = fs.readdirSync(userPath).filter(f => f.endsWith('.mp3'));
          msgText += `📁 ${user} (${files.length} músicas)\n`;
          keyboard.push([{ text: `🧹 Limpar ${user}`, callback_data: `confirm_clear_${user}` }]);
        }
      });
      keyboard.push([{ text: '💣 Limpar TUDO', callback_data: 'confirm_clear_all' }]);
      return bot.sendMessage(chatId, msgText, { reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      console.error(err);
      return bot.sendMessage(chatId, '❌ Erro ao listar pastas.');
    }
  }

  if (text === '/lista') {
    if (chatId === ADMIN_ID) {
      // Admin: mostra as pastas dos usuários
      const users = fs.readdirSync(downloadDir);
      const folders = [];
      users.forEach(user => {
        const userPath = path.join(downloadDir, user);
        if (fs.lstatSync(userPath).isDirectory()) {
          const count = fs.readdirSync(userPath).filter(f => f.endsWith('.mp3')).length;
          folders.push({ id: user, count });
        }
      });
      if (folders.length === 0) return bot.sendMessage(chatId, '📂 Nenhuma pasta de usuário encontrada.');
      const keyboard = folders.map(folder => ([{
        text: `📁 Usuário ${folder.id} (${folder.count} músicas)`,
        callback_data: `folder_${folder.id}`
      }]));
      return bot.sendMessage(chatId, '📂 Selecione um usuário para ver as músicas:', {
        reply_markup: { inline_keyboard: keyboard }
      });
    } else {
      // Usuário comum: mostra suas próprias músicas
      const userDir = getUserDir(chatId);
      let files = fs.readdirSync(userDir).filter(f => f.endsWith('.mp3'));
      if (files.length === 0) return bot.sendMessage(chatId, '📂 Nenhuma música encontrada');
      if (!global.playlistCache) global.playlistCache = {};
      const cacheId = Date.now() + '_' + chatId;
      global.playlistCache[cacheId] = files;
      const keyboard = files.map((file, index) => ([{
        text: file.substring(0, 40),
        callback_data: `play_${cacheId}_${chatId}_${index}`
      }]));
      keyboard.push([{
      text: "📤 Enviar todas",
      callback_data: `send_all_${chatId}`
    }]);
      
      return bot.sendMessage(chatId, '🎵 Escolha uma música ou envie todas:', { reply_markup: { inline_keyboard: keyboard } });
    }
  }

  if (text && isYoutubeLink(text)) {
    addToQueue(chatId, text, msg);
  }
});

// =============================
// CALLBACKS
// =============================
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('folder_')) {
    const userId = data.replace('folder_', '');
    const userPath = path.join(downloadDir, userId);
    if (!fs.existsSync(userPath)) {
      await bot.editMessageText('❌ Pasta não encontrada.', {
        chat_id: chatId,
        message_id: query.message.message_id
      });
      return bot.answerCallbackQuery(query.id);
    }
    const files = fs.readdirSync(userPath).filter(f => f.endsWith('.mp3'));
    if (files.length === 0) {
      await bot.editMessageText('📂 Este usuário não possui músicas.', {
        chat_id: chatId,
        message_id: query.message.message_id
      });
      return bot.answerCallbackQuery(query.id);
    }
    if (!global.playlistCache) global.playlistCache = {};
    const cacheId = Date.now() + '_' + userId;
    global.playlistCache[cacheId] = files;
    const keyboard = files.map((file, index) => ([{
      text: file.substring(0, 40),
      callback_data: `play_${cacheId}_${userId}_${index}`
    }]));
    await bot.editMessageText(`🎵 Músicas do usuário ${userId}:`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: keyboard }
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('send_all_')) {
    const userId = data.replace('send_all_', '');
    const userDir = path.join(downloadDir, userId);
    const files = fs.readdirSync(userDir).filter(f => f.endsWith('.mp3'));
    if (files.length === 0) {
      await bot.sendMessage(chatId, '📂 Nenhuma música encontrada.');
      return bot.answerCallbackQuery(query.id);
    }
    await bot.sendMessage(chatId, `📤 Enviando todas as suas ${files.length} músicas... Isso pode levar alguns instantes.`);
    let sent = 0;
    for (const file of files) {
      const filePath = path.join(userDir, file);
      try {
        await bot.sendAudio(chatId, filePath, {
          title: file.replace(/\.mp3$/, ''),
          performer: 'YouTube Bot'
        });
        sent++;
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (err) {
        console.error(`Erro ao enviar ${file}:`, err);
      }
    }
    await bot.sendMessage(chatId, `✅ Enviadas ${sent} de ${files.length} músicas.`);
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('play_')) {
    const parts = data.split('_');
    if (parts.length < 4) {
      console.error(`Formato inválido: ${data}`);
      return bot.answerCallbackQuery(query.id, { text: 'Inválido' });
    }

    const cacheId = parts[1];
    let userId = parts[2];
    let index = parseInt(parts[3]);

    if (index > 10000 && parts.length >= 4) {

      if (parts.length >= 5) {

        index = parseInt(parts[4]);
        console.log(`Corrigindo índice para ${index} (havia ${parts[3]})`);
      } else {
        console.error(`Índice inválido: ${index}. Verifique a geração do callback_data.`);
        await bot.sendMessage(chatId, '❌ Erro interno. Use /lista novamente.');
        return bot.answerCallbackQuery(query.id);
      }
    }

    console.log(`[play_] cacheId=${cacheId}, userId=${userId}, index=${index}, chatId=${chatId}`);

    if (chatId !== ADMIN_ID && String(chatId) !== String(userId)) {
      await bot.sendMessage(chatId, '❌ Você não tem permissão para acessar essa música.');
      return bot.answerCallbackQuery(query.id);
    }
    let fileName = null;
    if (global.playlistCache && global.playlistCache[cacheId] && global.playlistCache[cacheId][index]) {
      fileName = global.playlistCache[cacheId][index];
      console.log(`[play_] Cache hit: ${fileName}`);
    } else {
      console.log(`[play_] Cache miss para cacheId=${cacheId}, índice ${index}`);
      const userDir = path.join(downloadDir, userId);
      if (fs.existsSync(userDir)) {
        const files = fs.readdirSync(userDir).filter(f => f.endsWith('.mp3'));
        if (files.length > index) {
          fileName = files[index];
          console.log(`[play_] Reconstruído: ${fileName} (índice ${index} de ${files.length})`);
          if (!global.playlistCache) global.playlistCache = {};
          global.playlistCache[cacheId] = files;
        } else {
          console.error(`Índice ${index} inválido para usuário ${userId} (total ${files.length})`);
          await bot.sendMessage(chatId, '❌ Música não encontrada. Use /lista novamente.');
          return bot.answerCallbackQuery(query.id);
        }
      } else {
        console.error(`Pasta do usuário ${userId} não existe: ${userDir}`);
        await bot.sendMessage(chatId, '❌ Usuário não encontrado.');
        return bot.answerCallbackQuery(query.id);
      }
    }

    if (!fileName) {
      await bot.sendMessage(chatId, '❌ Música não encontrada. Use /lista novamente.');
      return bot.answerCallbackQuery(query.id);
    }

    const filePath = path.join(downloadDir, userId, fileName);
    console.log(`[play_] Tentando enviar: ${filePath}`);

    if (!fs.existsSync(filePath)) {
      console.error(`Arquivo não encontrado: ${filePath}`);
      await bot.sendMessage(chatId, '❌ Arquivo não encontrado no servidor.');
      return bot.answerCallbackQuery(query.id);
    }

    await bot.sendDocument(chatId, filePath, {
      caption: fileName.replace(/\.mp3$/, '')
    });

    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('confirm_clear_')) {
    if (chatId !== ADMIN_ID) {
      return bot.answerCallbackQuery(query.id, { text: 'Sem permissão', show_alert: true });
    }
    const user = data.replace('confirm_clear_', '');
    const confirmKeyboard = [
      [
        { text: '✅ Sim, limpar', callback_data: `clear_${user}` },
        { text: '❌ Não', callback_data: 'cancel_clear' }
      ]
    ];
    await bot.editMessageText(`⚠️ Tem certeza que deseja limpar a pasta **${user}**?\nEssa ação é irreversível.`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: confirmKeyboard }
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'confirm_clear_all') {
    if (chatId !== ADMIN_ID) {
      return bot.answerCallbackQuery(query.id, { text: 'Sem permissão', show_alert: true });
    }
    const confirmKeyboard = [
      [
        { text: '✅ Sim, limpar TUDO', callback_data: 'clear_all' },
        { text: '❌ Não', callback_data: 'cancel_clear' }
      ]
    ];
    await bot.editMessageText('⚠️ **ATENÇÃO:** Isso vai apagar TODAS as músicas de TODOS os usuários.\nEssa ação é irreversível. Tem certeza?', {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: confirmKeyboard }
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'cancel_clear') {
    await bot.editMessageText('✅ Limpeza cancelada.', {
      chat_id: chatId,
      message_id: query.message.message_id
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data.startsWith('clear_') && data !== 'clear_all' && !data.startsWith('confirm_')) {
    if (chatId !== ADMIN_ID) {
      return bot.answerCallbackQuery(query.id, { text: 'Sem permissão', show_alert: true });
    }
    const user = data.replace('clear_', '');
    const userPath = path.join(downloadDir, user);
    if (fs.existsSync(userPath)) {
      const files = fs.readdirSync(userPath);
      files.forEach(f => {
        const fullPath = path.join(userPath, f);
        if (fs.lstatSync(fullPath).isFile()) fs.unlinkSync(fullPath);
      });
      await bot.editMessageText(`🧹 Pasta **${user}** foi limpa com sucesso!`, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.editMessageText('❌ Pasta não encontrada.', {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    }
    return bot.answerCallbackQuery(query.id);
  }

  if (data === 'clear_all' && !data.startsWith('confirm_')) {
    if (chatId !== ADMIN_ID) {
      return bot.answerCallbackQuery(query.id, { text: 'Sem permissão', show_alert: true });
    }
    const users = fs.readdirSync(downloadDir);
    users.forEach(user => {
      const userPath = path.join(downloadDir, user);
      if (fs.lstatSync(userPath).isDirectory()) {
        const files = fs.readdirSync(userPath);
        files.forEach(f => {
          const fullPath = path.join(userPath, f);
          if (fs.lstatSync(fullPath).isFile()) fs.unlinkSync(fullPath);
        });
      }
    });
    await bot.editMessageText('💣 **Todas as pastas foram limpas!**', {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown'
    });
    return bot.answerCallbackQuery(query.id);
  }
});

// =============================
// INICIALIZAÇÃO
// =============================
loadState();
runQueue();
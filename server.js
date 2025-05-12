// server.js

const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const CHAT_HISTORY_FILE = path.join(__dirname, 'chat-history.json');
let chatHistory = [];

if (fs.existsSync(CHAT_HISTORY_FILE)) {
  try {
    chatHistory = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8'));
  } catch (err) {
    log(`❌ Error reading chat history: ${err}`);
  }
}

app.use(express.static('public'));

const users = [];
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

const tempAdminState = {}; // Map of socket.id → { firstInitTime, tempAdminGranted }
const kickedUsers = {}; // socketId → true if kicked
const lastMessageTimes = {}; // socketId → timestamp
let tempDisableState = false; // Track temp disable state
let slowModeEnabled = true;
const SLOW_MODE_INTERVAL = 2000; // 2 seconds

function getCurrentTime() {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour12: true
  });
}

function getCurrentDateTime() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour12: true
  });
}

function log(message) {
  console.log(`[${getCurrentDateTime()}] ${message}`);
}

function broadcastSystemMessage(text) {
  const message = {
    user: 'Server',
    text,
    color: '#000000',
    avatar: 'S',
    time: getCurrentTime(),
  };
  io.emit('chat message', message);
  chatHistory.push(message);
  saveChatHistory();
}

function sendPrivateSystemMessage(socket, text) {
  socket.emit('chat message', {
    user: 'Server',
    text,
    color: '#000000',
    avatar: 'S',
    time: getCurrentTime(),
  });
}

function saveChatHistory() {
  fs.writeFile(CHAT_HISTORY_FILE, JSON.stringify(chatHistory, null, 2), (err) => {
    if (err) log(`❌ Error saving chat history: ${err}`);
  });
}

let profanityList = new Set();

async function loadProfanityLists() {
  try {
    const [cmuResponse, zacangerResponse] = await Promise.all([
      axios.get('https://www.cs.cmu.edu/~biglou/resources/bad-words.txt'),
      axios.get('https://raw.githubusercontent.com/zacanger/profane-words/master/words.json')
    ]);

    const cmuWords = cmuResponse.data.split('\n').map(word => word.trim().toLowerCase()).filter(Boolean);
    const zacangerWords = zacangerResponse.data.map(word => word.trim().toLowerCase());

    profanityList = new Set([...cmuWords, ...zacangerWords]);
    log(`🛡️ Loaded ${profanityList.size} profane words.`);
  } catch (error) {
    log(`❌ Error loading profanity lists: ${error}`);
  }
}

function containsProfanity(message) {
  const words = message.toLowerCase().split(/\s+/);
  return words.some(word => profanityList.has(word));
}

setInterval(() => {
  const now = Date.now();
  let userListChanged = false;

  users.forEach(user => {
    const wasIdle = user.isIdle;
    const isNowIdle = (now - user.lastActivity > IDLE_TIMEOUT);

    if (isNowIdle && !wasIdle) {
      user.isIdle = true;
      user.displayName = `${user.originalName} (idle)`;
      log(`🕒 ${user.originalName} is now idle`);
      userListChanged = true;
    } else if (!isNowIdle && wasIdle) {
      user.isIdle = false;
      user.displayName = user.originalName;
      log(`✅ ${user.originalName} is active again`);
      userListChanged = true;
    }
  });

  if (userListChanged) {
    io.emit('update users', users.map(u => ({
      username: u.displayName,
      color: u.color,
      avatar: u.avatar
    })));
  }
}, 5000);

io.on('connection', (socket) => {
  log(`✅ New WebSocket connection from ${socket.id}`);
  socket.emit('chat history', chatHistory);
  socket.emit('temp disable state', tempDisableState);

  if (tempDisableState) {
    socket.emit('temp disable');
    return;
  }

  socket.on('new user', (username, color, avatar) => {
    if (tempDisableState) return;
    const user = {
      socketId: socket.id,
      originalName: username,
      displayName: username,
      color,
      avatar,
      lastActivity: Date.now(),
      isIdle: false,
    };
    users.push(user);
    io.emit('update users', users.map(u => ({
      username: u.displayName,
      color: u.color,
      avatar: u.avatar
    })));
    log(`👤 ${username} joined`);
    broadcastSystemMessage(`${username} has joined the chat.`);
  });

  socket.on('chat message', (message) => {
    if (tempDisableState) {
      sendPrivateSystemMessage(socket, '❌ Chat is temporarily disabled.');
      return;
    }

    const user = users.find(u => u.socketId === socket.id);
    if (!user) return;
    if (kickedUsers[socket.id]) {
      sendPrivateSystemMessage(socket, '❌ You have been kicked and cannot send messages.');
      return;
    }

    const now = Date.now();
    const lastTime = lastMessageTimes[socket.id] || 0;
    if (slowModeEnabled && now - lastTime < SLOW_MODE_INTERVAL) {
      sendPrivateSystemMessage(socket, '⏳ Slow mode is enabled. Please wait before sending another message.');
      return;
    }
    lastMessageTimes[socket.id] = now;

    user.lastActivity = Date.now();
    log(`💬 ${user.originalName}: ${message}`);

    const trimmed = message.trim().toLowerCase();

    // Admin command to toggle slowmode
    if (trimmed === 'server init slowmode on') {
      const record = tempAdminState[socket.id];
      if (record?.tempAdminGranted) {
        slowModeEnabled = true;
        log(`⚙️ Slow mode enabled`);
        broadcastSystemMessage('⏳ Slow mode has been enabled.');
        return;
      }
    }

    if (trimmed === 'server init slowmode off') {
      const record = tempAdminState[socket.id];
      if (record?.tempAdminGranted) {
        slowModeEnabled = false;
        log(`⚙️ Slow mode disabled`);
        broadcastSystemMessage('🚀 Slow mode has been disabled.');
        return;
      }
    }

    // Temp admin granting logic
    if (trimmed === 'server init') {
      const now = Date.now();
      const record = tempAdminState[socket.id];
      if (!record || now - record.firstInitTime > 10000) {
        tempAdminState[socket.id] = { firstInitTime: now, tempAdminGranted: false };
        sendPrivateSystemMessage(socket, 'Ok');
        return;
      }
      if (!record.tempAdminGranted) {
        record.tempAdminGranted = true;
        sendPrivateSystemMessage(socket, 'Temp Admin Granted');
        return;
      }
    }

    if (containsProfanity(message)) {
      log(`🚫 Message blocked from ${user.originalName}: ${message}`);
      sendPrivateSystemMessage(socket, '❌ Your message was blocked due to profanity.');
      return;
    }

    const msg = {
      user: user.displayName,
      text: message,
      color: user.color,
      avatar: user.avatar,
      time: getCurrentTime()
    };

    io.emit('chat message', msg);
    chatHistory.push(msg);
    saveChatHistory();
  });

  // Handle private message
  socket.on('private message', (data) => {
    const sender = users.find(u => u.socketId === socket.id);
    const recipient = users.find(u => u.originalName === data.recipient || u.displayName === data.recipient);

    if (!sender || !recipient) return;

    if (containsProfanity(data.message)) {
      sendPrivateSystemMessage(socket, '❌ Your private message was blocked due to profanity.');
      return;
    }

    log(`📩 Private from ${sender.originalName} to ${recipient.originalName}: ${data.message}`);

    io.to(recipient.socketId).emit('private message', {
      user: sender.displayName,
      text: data.message,
    });
  });

  socket.on('typing', (isTyping) => {
    const user = users.find(u => u.socketId === socket.id);
    if (user && !kickedUsers[socket.id] && !tempDisableState) {
      socket.broadcast.emit('typing', {
        user: user.displayName,
        isTyping,
      });
    }
  });

  socket.on('disconnect', () => {
    log(`❌ WebSocket disconnected from ${socket.id}`);
    const idx = users.findIndex(u => u.socketId === socket.id);
    if (idx !== -1) {
      const user = users.splice(idx, 1)[0];
      log(`❌ Disconnected: ${user.originalName}`);
      broadcastSystemMessage(`${user.originalName} has left the chat.`);
    }
  });
});

server.listen(3000, () => {
  log('✅ Server is running on http://localhost:3000');
  loadProfanityLists();
});

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
let activePoll = null;

if (fs.existsSync(CHAT_HISTORY_FILE)) {
  try {
    chatHistory = JSON.parse(fs.readFileSync(CHAT_HISTORY_FILE, 'utf8'));
  } catch (err) {
    console.log(`❌ Error reading chat history: ${err}`);
  }
}

app.use(express.static('public'));

const users = [];
const IDLE_TIMEOUT = 5 * 60 * 1000;

const SLOW_MODE_INTERVAL = 2000;
const tempAdminState = {};
const kickedUsers = {};
let tempDisableState = false;
const lastMessageTimestamps = {};
let slowModeEnabled = true;
let slowModeInterval = SLOW_MODE_INTERVAL;

function getCurrentTime() {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true });
}

function getCurrentDateTime() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: true });
}

function log(msg) {
  console.log(`[${getCurrentDateTime()}] ${msg}`);
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
  fs.writeFile(CHAT_HISTORY_FILE, JSON.stringify(chatHistory, null, 2), err => {
    if (err) log(`❌ Error saving chat history: ${err}`);
  });
}

let profanityList = new Set();

async function loadProfanityLists() {
  try {
    const [cmu, zac] = await Promise.all([
      axios.get('https://www.cs.cmu.edu/~biglou/resources/bad-words.txt'),
      axios.get('https://raw.githubusercontent.com/zacanger/profane-words/master/words.json'),
    ]);
    const cmuWords = cmu.data.split('\n').map(w => w.trim().toLowerCase()).filter(Boolean);
    const zacWords = zac.data.map(w => w.trim().toLowerCase());
    profanityList = new Set([...cmuWords, ...zacWords]);
    log(`🛡️ Loaded ${profanityList.size} profane words.`);
  } catch (err) {
    log(`❌ Error loading profanity lists: ${err}`);
  }
}

function containsProfanity(msg) {
  return msg.toLowerCase().split(/\s+/).some(word => profanityList.has(word));
}


setInterval(() => {
  const now = Date.now();
  let changed = false;
  users.forEach(user => {
    const idle = now - user.lastActivity > IDLE_TIMEOUT;
    if (idle && !user.isIdle) {
      user.isIdle = true;
      user.displayName = `${user.originalName} (idle)`;
      log(`🕒 ${user.originalName} is now idle`);
      changed = true;
    } else if (!idle && user.isIdle) {
      user.isIdle = false;
      user.displayName = user.originalName;
      log(`✅ ${user.originalName} is active again`);
      changed = true;
    }
  });
  if (changed) {
    io.emit('update users', users.map(u => ({
      username: u.displayName,
      color: u.color,
      avatar: u.avatar
    })));
  }
}, 5000);

io.on('connection', socket => {
  log(`✅ New WebSocket connection from ${socket.id}`);
  socket.emit('chat history', chatHistory);
  socket.emit('temp disable state', tempDisableState);
  if (tempDisableState) {
    socket.emit('temp disable');
    return;
  }

  socket.on('new user', (username, color, avatar) => {
    if (tempDisableState) return;

    // Function to generate a unique username
    function generateUniqueUsername(baseName) {
      // Block the name "Eli" from being duplicated at all
      if (baseName === 'Eli') {
        return 'Eli';
      }
      let name = baseName;
      let suffix = 2;
      const existingNames = users.map(u => u.originalName.toLowerCase());

      while (existingNames.includes(name.toLowerCase())) {
        name = `${baseName}${suffix}`;
        suffix++;
      }

      return name;
    }

    function addUser(username, color, avatar) {
      const uniqueUsername = generateUniqueUsername(username);

      // Force Eli's avatar color to orange
      if (username === 'Eli') {
        color = '#f59611';
      }

      const user = {
        socketId: socket.id,
        originalName: uniqueUsername,
        displayName: uniqueUsername,
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

      log(`👤 ${uniqueUsername} joined`);
      broadcastSystemMessage(`${uniqueUsername} has joined the chat.`);
    }

    // Block the name "Eli" from being duplicated at all
    if (username === 'Eli') {
      if (users.some(u => u.originalName === 'Eli')) {
        sendPrivateSystemMessage(socket, '❌ The username "Eli" is already in use.');
        return;
      }

      sendPrivateSystemMessage(socket, '🔐 Enter password for Eli:');
      const attemptPassword = () => {
        socket.once('chat message', password => {
          let decodedPassword = Buffer.from('ZWxpYWRtaW4xMjM=', 'base64').toString('utf8'); // default fallback
          const passwordFile = path.join(__dirname, 'eli-password.txt');
          if (fs.existsSync(passwordFile)) {
            try {
              decodedPassword = Buffer.from(fs.readFileSync(passwordFile, 'utf8'), 'base64').toString('utf8');
            } catch (err) {
              log('❌ Error reading Eli password file, using fallback.');
            }
          }

          if (password.trim() === decodedPassword) {
            tempAdminState[socket.id] = { firstInitTime: Date.now(), tempAdminGranted: true };
            addUser(username, color, avatar);
          } else {
            sendPrivateSystemMessage(socket, '❌ Incorrect password. Try again:');
            socket.once('chat message', retryPassword => {
              if (retryPassword.trim() === decodedPassword) {
                tempAdminState[socket.id] = { firstInitTime: Date.now(), tempAdminGranted: true };
                addUser(username, color, avatar);
              } else {
                sendPrivateSystemMessage(socket, '❌ Access denied for username Eli.');
              }
            });
          }
        });
      };
      attemptPassword();
      return;
    }

    addUser(username, color, avatar);
  });

  socket.on('chat message', message => {
    const user = users.find(u => u.socketId === socket.id);
    if (!user) return;
    const now = Date.now();
    const trimmed = message.trim().toLowerCase();
    const record = tempAdminState[socket.id];

    if (trimmed === 'server init42') {
      if (user.adminBlocked) {
        sendPrivateSystemMessage(socket, '❌ You are permanently blocked from becoming an admin.');
        log(`🚫 Admin block attempted by ${user.originalName}`);
        return;
      }
      if (!record || now - record.firstInitTime > 10000) {
        tempAdminState[socket.id] = { firstInitTime: now, tempAdminGranted: false };
        sendPrivateSystemMessage(socket, 'Ok');
        log(`💬 ${user.originalName}: ${message}`);
        return;
      }
      if (!record.tempAdminGranted) {
        record.tempAdminGranted = true;
        sendPrivateSystemMessage(socket, 'Temp Admin Granted');
        log(`💬 ${user.originalName}: ${message}`);
        // Notify Eli if connected
        const eliSocket = users.find(u => u.originalName === 'Eli');
        if (eliSocket) {
          const eliConnection = io.sockets.sockets.get(eliSocket.socketId);
          if (eliConnection) {
            sendPrivateSystemMessage(eliConnection, `🛡️ ${user.originalName} has been granted temporary admin access.`);
          }
        }
        return;
      }
    }

    if (trimmed.startsWith('server init') && (!record || !record.tempAdminGranted)) {
      sendPrivateSystemMessage(socket, '❌ You are not authorized to use admin commands.');
      log(`🚫 ${user.originalName} attempted admin command without permission: ${message}`);
      return;
    }

    if (tempDisableState && !trimmed.startsWith('server init')) {
      sendPrivateSystemMessage(socket, '❌ Admin has enabled temp chat disable. You cannot send messages.');
      log(`🚫 Message from ${user.originalName} blocked due to temp disable: ${message}`);
      return;
    }

    if (kickedUsers[socket.id]) {
      sendPrivateSystemMessage(socket, '❌ You have been kicked and cannot send messages.');
      log(`🚫 Message from ${user.originalName} blocked due to kick: ${message}`);
      return;
    }
      
      // === START POLL ===
      if (trimmed.startsWith('server init poll ')) {
        if (activePoll) {
          sendPrivateSystemMessage(socket, '❌ A poll is already running.');
          return;
        }

        const pollArgs = trimmed.replace('server init poll ', '').trim().split(' ');
        if (pollArgs.length < 2) {
          sendPrivateSystemMessage(socket, '❌ Please provide two options: server init poll [option1] [option2]');
          return;
        }

        const [option1, option2] = pollArgs;

        activePoll = {
          question: `🗳️ New Poll:`,
          options: [option1, option2],
          votes: {}, // key: socketId, value: 0 or 1
        };

        io.emit('chat message', {
          user: '🗳️ System',
          text: `Poll started!\nOption 1: ${option1}\nOption 2: ${option2}\nVote using: !vote 1 or !vote 2`,
          color: '#3498db',
          avatar: '',
          time: getCurrentTime(),
        });

        return;
      }

      // === VOTING ===
      if (trimmed.startsWith('!vote')) {
        if (!activePoll) {
          sendPrivateSystemMessage(socket, '❌ No active poll.');
          return;
        }

        const voteNum = parseInt(trimmed.replace('!vote', '').trim(), 10);
        if (![1, 2].includes(voteNum)) {
          sendPrivateSystemMessage(socket, '❌ Invalid vote. Use !vote 1 or !vote 2.');
          return;
        }

        activePoll.votes[socket.id] = voteNum - 1;

        // Count current results
        const counts = [0, 0];
        for (const v of Object.values(activePoll.votes)) {
          counts[v]++;
        }

        io.emit('chat message', {
          user: '🗳️ Poll Update',
          text: `Current results:\n${activePoll.options[0]}: ${counts[0]} votes\n${activePoll.options[1]}: ${counts[1]} votes`,
          color: '#2ecc71',
          avatar: '',
          time: getCurrentTime(),
        });

        return;
      }

      // === END POLL ===
      if (trimmed === 'server init endpoll') {
        if (user.originalName !== 'Eli') {
          sendPrivateSystemMessage(socket, '❌ Only Eli can end the poll.');
          return;
        }

        if (!activePoll) {
          sendPrivateSystemMessage(socket, '❌ No poll is active.');
          return;
        }

        const counts = [0, 0];
        for (const v of Object.values(activePoll.votes)) {
          counts[v]++;
        }

        io.emit('chat message', {
          user: '🗳️ Poll Ended',
          text: `Final results:\n${activePoll.options[0]}: ${counts[0]} votes\n${activePoll.options[1]}: ${counts[1]} votes`,
          color: '#e74c3c',
          avatar: '',
          time: getCurrentTime(),
        });

        activePoll = null;
        return;
      }
      
      if (trimmed.startsWith('server init pin ')) {
        const pinMessage = message.slice('server init pin '.length).trim();

        if (!pinMessage) {
          sendPrivateSystemMessage(socket, '❌ Cannot pin an empty message.');
          return;
        }

        // Send the pinned message to all clients (for dedicated UI)
        io.emit('pinned message', pinMessage);

        // Optionally save it to chat history as well
        const pinAnnouncement = {
          user: '📌 Pinned Message',
          text: pinMessage,
          color: '#f39c12',
          avatar: '',
          time: getCurrentTime(),
        };

        chatHistory.push(pinAnnouncement);
        saveChatHistory();

        log(`📌 Message pinned by ${user.originalName}: ${pinMessage}`);

        // Notify Eli
        const eliUser = users.find(u => u.originalName === 'Eli');
        if (eliUser && user.originalName !== 'Eli') {
          const eliSocket = io.sockets.sockets.get(eliUser.socketId);
          if (eliSocket) {
            sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: pinned a message.`);
          }
        }

        return;
      }
      
      if (trimmed === 'server init pinoff') {
        // Notify all clients to hide the pinned message
        io.emit('pinned message', '');

        log(`📌 Pinned message cleared by ${user.originalName}`);

        // Optionally notify Eli
        const eliUser = users.find(u => u.originalName === 'Eli');
        if (eliUser && user.originalName !== 'Eli') {
          const eliSocket = io.sockets.sockets.get(eliUser.socketId);
          if (eliSocket) {
            sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: cleared pinned message.`);
          }
        }

        return;
      }

    if (
      slowModeEnabled &&
      lastMessageTimestamps[socket.id] &&
      now - lastMessageTimestamps[socket.id] < slowModeInterval &&
      !trimmed.startsWith('server init')
    ) {
      sendPrivateSystemMessage(socket, '⏳ Slow mode is enabled. Please wait.');
      log(`🚫 Message from ${user.originalName} blocked due to slow mode: ${message}`);
      return;
    }
    lastMessageTimestamps[socket.id] = now;
    user.lastActivity = now;

    // Admin Command Handlers
      if (trimmed === 'server init help') {
        // Check if the user is Eli (if Eli is logged in)
        if (user.originalName === 'Eli') {
          sendPrivateSystemMessage(socket, `
      🛠️ Admin Commands:
      1. server init temp disable
      2. server init temp disable off
      3. server init clear history
      4. server init kick <username>
      5. server init slowmode on/off
      6. server init restart
      7. server init slowmode <time>
      8. server init broadcast <text>
      9. server init admin delete <username>
      10. server init change password <new_password>`);
        } else {
          sendPrivateSystemMessage(socket, `
      🛠️ Admin Commands:
      1. server init temp disable
      2. server init temp disable off
      3. server init clear history
      4. server init kick <username>
      5. server init slowmode on/off
      6. server init restart
      7. server init slowmode <time>
      8. server init broadcast <text>`);
        }
        log(`💬 ${user.originalName}: ${message}`);
        return;
      }
      
    if (trimmed.startsWith('server init broadcast ')) {
      const broadcastText = message.slice('server init broadcast '.length).trim();
      if (broadcastText.length === 0) {
        sendPrivateSystemMessage(socket, '❌ Cannot send an empty broadcast message.');
        return;
      }
      const adminMessage = `📢 Admin Broadcast: ${broadcastText}`;
      broadcastSystemMessage(adminMessage);
      log(`📢 Broadcast by ${user.originalName}: ${broadcastText}`);
      // Notify Eli
      const eliUser = users.find(u => u.originalName === 'Eli');
      if (eliUser && user.originalName !== 'Eli') {
        const eliSocket = io.sockets.sockets.get(eliUser.socketId);
        if (eliSocket) {
          sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: ${adminMessage.replace(/^[^a-zA-Z0-9]+/, '')}`);
        }
      }
      return;
    }

    if (trimmed === 'server init slowmode on') {
      slowModeEnabled = true;
      const adminMessage = '⚙️ Admin has enabled slow mode.';
      broadcastSystemMessage(adminMessage);
      log(`⚙️ Slow mode enabled by ${user.originalName}`);
      // Notify Eli
      const eliUser = users.find(u => u.originalName === 'Eli');
      if (eliUser && user.originalName !== 'Eli') {
        const eliSocket = io.sockets.sockets.get(eliUser.socketId);
        if (eliSocket) {
          sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: ${adminMessage.replace(/^[^a-zA-Z0-9]+/, '')}`);
        }
      }
      return;
    }

    if (trimmed === 'server init slowmode off') {
      slowModeEnabled = false;
      const adminMessage = '⚙️ Admin has disabled slow mode.';
      broadcastSystemMessage(adminMessage);
      log(`⚙️ Slow mode disabled by ${user.originalName}`);
      // Notify Eli
      const eliUser = users.find(u => u.originalName === 'Eli');
      if (eliUser && user.originalName !== 'Eli') {
        const eliSocket = io.sockets.sockets.get(eliUser.socketId);
        if (eliSocket) {
          sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: ${adminMessage.replace(/^[^a-zA-Z0-9]+/, '')}`);
        }
      }
      return;
    }
      
    if (trimmed.startsWith('server init slowmode ')) {
      const time = parseFloat(trimmed.split(' ')[3]);
      if (isNaN(time) || time <= 0) {
        sendPrivateSystemMessage(socket, '❌ Invalid slowmode time.');
        log(`❌ Invalid slowmode time input by ${user.originalName}`);
        return;
      }
      slowModeInterval = time * 1000;
      const adminMessage = `⏳ Slowmode delay changed to ${time} seconds.`;
      sendPrivateSystemMessage(socket, adminMessage);
      log(`⚙️ Slowmode time changed by ${user.originalName} to ${time} seconds.`);
      // Notify Eli
      const eliUser = users.find(u => u.originalName === 'Eli');
      if (eliUser && user.originalName !== 'Eli') {
        const eliSocket = io.sockets.sockets.get(eliUser.socketId);
        if (eliSocket) {
          sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: ${adminMessage.replace(/^[^a-zA-Z0-9]+/, '')}`);
        }
      }
      return;
    }

    if (trimmed === 'server init temp disable') {
      setTimeout(() => {
        tempDisableState = true;
        io.emit('temp disable');
        const adminMessage = '⚠️ Admin has enabled temp chat disable.';
        broadcastSystemMessage(adminMessage);
        log(`⚙️ Temp disable ON triggered by admin: ${user.originalName}`);
        // Notify Eli
        const eliUser = users.find(u => u.originalName === 'Eli');
        if (eliUser) {
          const eliSocket = io.sockets.sockets.get(eliUser.socketId);
          if (eliSocket) {
            sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: ${adminMessage.replace(/^[^a-zA-Z0-9]+/, '')}`);
          }
        }
      }, 2000);
      return;
    }

    if (trimmed === 'server init temp disable off') {
      tempDisableState = false;
      io.emit('temp disable off');
      const adminMessage = '✅ Admin has disabled temp chat disable.';
      broadcastSystemMessage(adminMessage);
      log(`🔓 Temp disable OFF triggered by admin: ${user.originalName}`);
      // Notify Eli
      const eliUser = users.find(u => u.originalName === 'Eli');
      if (eliUser && user.originalName !== 'Eli') {
        const eliSocket = io.sockets.sockets.get(eliUser.socketId);
        if (eliSocket) {
          sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: ${adminMessage.replace(/^[^a-zA-Z0-9]+/, '')}`);
        }
      }
      return;
    }

    if (trimmed === 'server init clear history') {
      let countdown = 3;
      log(`⚙️ Clear chat history triggered by admin: ${user.originalName}`);
      const interval = setInterval(() => {
        if (countdown > 0) {
          broadcastSystemMessage(`🧹 Clearing chat history in ${countdown--}...`);
        } else {
          clearInterval(interval);
          chatHistory = [];
          saveChatHistory();
          const adminMessage = '🧹 Chat history has been cleared.';
          broadcastSystemMessage(adminMessage);
          io.emit('clear history');
          // Notify Eli
          const eliUser = users.find(u => u.originalName === 'Eli');
          if (eliUser) {
            const eliSocket = io.sockets.sockets.get(eliUser.socketId);
            if (eliSocket) {
              sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: ${adminMessage.replace(/^[^a-zA-Z0-9]+/, '')}`);
            }
          }
        }
      }, 1000);
      return;
    }

    if (trimmed.startsWith('server init kick ')) {
      const targetName = trimmed.replace('server init kick ', '').trim();
      const targetUser = users.find(u => u.originalName.toLowerCase() === targetName.toLowerCase() || u.displayName.toLowerCase() === targetName.toLowerCase());
      if (targetUser) {
        const targetSocket = io.sockets.sockets.get(targetUser.socketId);
        if (targetSocket) {
          let countdown = 0;
          const interval = setInterval(() => {
            if (countdown > 0) {
              sendPrivateSystemMessage(targetSocket, `⚠️ You will be kicked in ${countdown--} second(s)...`);
            } else {
              clearInterval(interval);
              kickedUsers[targetUser.socketId] = true;
              sendPrivateSystemMessage(targetSocket, '❌ You were kicked by admin.');
              const adminMessage = `${targetUser.originalName} was kicked by ${user.originalName}.`;
              broadcastSystemMessage(adminMessage);
              log(`🚫 Kicked ${targetUser.originalName} by ${user.originalName}`);
              // Notify Eli
              const eliUser = users.find(u => u.originalName === 'Eli');
              if (eliUser && user.originalName !== 'Eli') {
                const eliSocket = io.sockets.sockets.get(eliUser.socketId);
                if (eliSocket) {
                  sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: ${adminMessage.replace(/^[^a-zA-Z0-9]+/, '')}`);
                }
              }
            }
          }, 1000);
        }
      } else {
        sendPrivateSystemMessage(socket, `❌ Could not find user "${targetName}".`);
      }
      return;
    }
      
      if (trimmed.startsWith('server init unkick ')) {
        const targetName = trimmed.replace('server init unkick ', '').trim();
        const targetUser = users.find(u =>
          u.originalName.toLowerCase() === targetName.toLowerCase() ||
          u.displayName.toLowerCase() === targetName.toLowerCase()
        );

        if (targetUser) {
          if (kickedUsers[targetUser.socketId]) {
            delete kickedUsers[targetUser.socketId];
            const adminMessage = `✅ ${targetUser.originalName} has been un-kicked and can rejoin.`;
            broadcastSystemMessage(adminMessage);
            log(`🔓 Unkicked ${targetUser.originalName} by ${user.originalName}`);

            // Notify Eli
            const eliUser = users.find(u => u.originalName === 'Eli');
            if (eliUser && user.originalName !== 'Eli') {
              const eliSocket = io.sockets.sockets.get(eliUser.socketId);
              if (eliSocket) {
                sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: ${adminMessage.replace(/^[^a-zA-Z0-9]+/, '')}`);
              }
            }
          } else {
            sendPrivateSystemMessage(socket, `ℹ️ ${targetUser.originalName} is not currently kicked.`);
          }
        } else {
          sendPrivateSystemMessage(socket, `❌ Could not find user "${targetName}".`);
        }
        return;
      }

    if (trimmed.startsWith('server init admin delete ')) {
      if (user.originalName !== 'Eli') {
        sendPrivateSystemMessage(socket, '❌ Only Eli is authorized to use this command.');
        log(`❌ Unauthorized admin delete attempt by ${user.originalName}`);
        return;
      }

      const targetName = trimmed.replace('server init admin delete ', '').trim().toLowerCase();
      const targetUser = users.find(u =>
        u.originalName.toLowerCase() === targetName || u.displayName.toLowerCase() === targetName
      );
      if (targetUser) {
        targetUser.adminBlocked = true;
        // Also remove any existing tempAdminState
        if (tempAdminState[targetUser.socketId]) {
          delete tempAdminState[targetUser.socketId];
        }
        const adminMessage = `✅ ${targetUser.originalName} has been blocked from becoming admin.`;
        sendPrivateSystemMessage(socket, adminMessage);
        log(`🔒 Admin block: ${targetUser.originalName} blocked by ${user.originalName}`);
        const eliUser = users.find(u => u.originalName === 'Eli');
        if (eliUser && user.originalName !== 'Eli') {
          const eliSocket = io.sockets.sockets.get(eliUser.socketId);
          if (eliSocket) {
            sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: ${adminMessage.replace(/^[^a-zA-Z0-9]+/, '')}`);
          }
        }
      } else {
        sendPrivateSystemMessage(socket, `❌ Could not find user "${targetName}".`);
      }
      return;
    }

    // Eli password change command
    if (trimmed.startsWith('server init change password ')) {
      if (user.originalName !== 'Eli') {
        sendPrivateSystemMessage(socket, '❌ Only Eli is authorized to change the password.');
        log(`❌ Unauthorized password change attempt by ${user.originalName}`);
        return;
      }

      const newPassword = trimmed.replace('server init change password ', '').trim();
      if (!newPassword) {
        sendPrivateSystemMessage(socket, '❌ New password cannot be empty.');
        return;
      }

      const encodedPassword = Buffer.from(newPassword).toString('base64');
      const passwordFilePath = path.join(__dirname, 'eli-password.txt');
      fs.writeFileSync(passwordFilePath, encodedPassword, 'utf8');
      sendPrivateSystemMessage(socket, '✅ Eli login password has been updated.');
      log(`🔐 Eli updated login password.`);
      return;
    }

    if (trimmed === 'server init restart') {
      log('🚨 Restart initiated by admin');
      io.emit('shutdown initiated');
      let remaining = 5;
      const interval = setInterval(() => {
        if (remaining > 0) {
          broadcastSystemMessage(`🚨 Server restarting in ${remaining--} second(s)...`);
        } else {
          clearInterval(interval);
          const adminMessage = '🚨 Server restarting (takes 1 - 2 minutes to complete).';
          broadcastSystemMessage(adminMessage);
          server.close();
      // Notify Eli
      const eliUser = users.find(u => u.originalName === 'Eli');
      if (eliUser && user.originalName !== 'Eli') {
        const eliSocket = io.sockets.sockets.get(eliUser.socketId);
        if (eliSocket) {
          sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: ${adminMessage.replace(/^[^a-zA-Z0-9]+/, '')}`);
        }
      }
        }
      }, 1000);
      return;
    }
      
      if (trimmed.startsWith('server init impersonate ')) {
        if (user.originalName !== 'Eli') {
          sendPrivateSystemMessage(socket, '❌ Only Eli is authorized to use the impersonate command.');
          log(`❌ Unauthorized impersonation attempt by ${user.originalName}`);
          return;
        }

        const commandParts = trimmed.split(' ');
        if (commandParts.length < 4) {
          sendPrivateSystemMessage(socket, '❌ Invalid impersonate command format. Use: server init impersonate [username] [message]');
          return;
        }

        const targetName = commandParts[3];
        const messageIndex = trimmed.indexOf(targetName) + targetName.length;
        const impersonatedMessage = trimmed.slice(messageIndex).trim();

        const targetUser = users.find(u =>
          u.originalName.toLowerCase() === targetName.toLowerCase() ||
          u.displayName.toLowerCase() === targetName.toLowerCase()
        );

        if (!targetUser) {
          sendPrivateSystemMessage(socket, `❌ Could not find user "${targetName}".`);
          return;
        }

        const msg = {
          user: targetUser.displayName,
          text: impersonatedMessage,
          color: targetUser.color,
          avatar: targetUser.avatar,
          time: getCurrentTime(),
        };

        io.emit('chat message', msg);
        chatHistory.push(msg);
        saveChatHistory();
        log(`🎭 Impersonated message from ${targetUser.originalName} by ${user.originalName}: ${impersonatedMessage}`);

        // Notify Eli
        const eliUser = users.find(u => u.originalName === 'Eli');
        if (eliUser && user.originalName !== 'Eli') {
          const eliSocket = io.sockets.sockets.get(eliUser.socketId);
          if (eliSocket) {
            sendPrivateSystemMessage(eliSocket, `Admin command executed by ${user.originalName}: Impersonated ${targetUser.originalName}`);
          }
        }
        return;
      }
      
    if (containsProfanity(message)) {
      sendPrivateSystemMessage(socket, '❌ Your message was blocked due to profanity.');
      log(`🚫 Message from ${user.originalName} blocked due to profanity: ${message}`);
      return;
    }

    const msg = {
      user: user.displayName,
      text: message,
      color: user.color,
      avatar: user.avatar,
      time: getCurrentTime(),
    };

    io.emit('chat message', msg);
    chatHistory.push(msg);
    saveChatHistory();
    log(`💬 ${user.originalName}: ${message}`);
  });

  socket.on('private message', data => {
    const sender = users.find(u => u.socketId === socket.id);
    // Prevent kicked users from sending private messages
    if (kickedUsers[socket.id]) {
      sendPrivateSystemMessage(socket, '❌ You have been kicked and cannot send private messages.');
      log(`🚫 Private message from ${sender?.originalName || socket.id} blocked due to kick.`);
      return;
    }
    const recipient = users.find(u =>
      u.originalName === data.recipient || u.displayName === data.recipient
    );
    if (!sender || !recipient) return;

    if (containsProfanity(data.message)) {
      sendPrivateSystemMessage(socket, '❌ Your private message was blocked due to profanity.');
      log(`🚫 Private message blocked due to profanity from ${sender.originalName} to ${data.recipient}: ${data.message}`);
      return;
    }

    // log(`📩 Private from ${sender.originalName} to ${recipient.originalName}: ${data.message}`);
    io.to(recipient.socketId).emit('private message', {
      user: sender.displayName,
      text: data.message,
    });
  });

  socket.on('typing', isTyping => {
    if (tempDisableState) return;
    const user = users.find(u => u.socketId === socket.id);
    if (user && !kickedUsers[socket.id]) {
      socket.broadcast.emit('typing', { user: user.displayName, isTyping });
    }
  });

  socket.on('username changed', newUsername => {
    const user = users.find(u => u.socketId === socket.id);
    if (user) {
      const old = user.originalName;
      user.originalName = newUsername;
      user.displayName = newUsername + (user.isIdle ? ' (idle)' : '');
      io.emit('update users', users.map(u => ({
        username: u.displayName,
        color: u.color,
        avatar: u.avatar
      })));
      broadcastSystemMessage(`${old} changed username to ${newUsername}.`);
      log(`💬 ${user.originalName}: changed username to ${newUsername}`);
    }
  });

  socket.on('disconnect', () => {
    const index = users.findIndex(u => u.socketId === socket.id);
    if (index !== -1) {
      const [user] = users.splice(index, 1);
      log(`❌ Disconnected: ${user.originalName}`);
      io.emit('update users', users.map(u => ({
        username: u.displayName,
        color: u.color,
        avatar: u.avatar
      })));
      broadcastSystemMessage(`${user.originalName} has left the chat.`);
    }
  });
});

server.listen(3000, () => {
  log('✅ Server is running on http://localhost:3000');
  loadProfanityLists();
});

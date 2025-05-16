const socket = io();
let privateRecipient = null;

// UI ELEMENTS
const chatUI = document.getElementById('chat-ui');
const usernameScreen = document.getElementById('username-screen');
const usernameInput = document.getElementById('username-input');
const enterChatBtn = document.getElementById('enter-chat-btn');
const usernameError = document.getElementById('username-error');

if (usernameError) {
  usernameError.style.display = "none";
}

const input = document.getElementById('message-input');
const sendButton = document.getElementById('send-btn');
const messages = document.getElementById('messages');
const emojiBtn = document.getElementById('emoji-btn');
const emojiContainer = document.getElementById('emoji-container');
const emojiPicker = emojiContainer.querySelector('emoji-picker');
const closeEmojiBtn = document.getElementById('close-emoji-btn');

const chatInfo = document.getElementById('chat-info');
const chatType = document.getElementById('chat-type');
const currentChatWith = document.getElementById('current-chat-with');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const privateChatInput = document.getElementById('private-chat-input');
const startPrivateChatButton = document.getElementById('start-private-chat');
const publicChatButton = document.getElementById('public-chat-btn');
const publicChatButtonTop = document.getElementById('public-chat-btn-top');
const closeSettingsButton = document.getElementById('close-settings-btn');
const changeUsernameInput = document.getElementById('change-username-input');
const changeUsernameButton = document.getElementById('change-username-btn');
const onlineUsersList = document.getElementById('online-users');

const pinnedContainer = document.getElementById('pinned-message-container');
const pinnedText = document.getElementById('pinned-message-text');

// Typing indicator: fixed space in layout, hidden by default, styled for orange background
let typingIndicator = document.getElementById('typing-indicator');
if (!typingIndicator) {
  typingIndicator = document.createElement('div');
  typingIndicator.id = 'typing-indicator';
  typingIndicator.classList.add('text-sm', 'text-gray-500', 'mt-2', 'typing-indicator', 'hidden');
  // Insert after messages
  messages.parentElement.insertBefore(typingIndicator, messages.nextSibling);
}

// Unread messages badge
const unreadBadge = document.getElementById('unread-badge');
let unreadCount = 0;

let username = localStorage.getItem('username') || '';
let userStatus = 'active';
let idleTimeout = null;
let lastInteractionTime = Date.now();
const idleLimit = 2 * 60 * 1000;
const statusLogInterval = 15 * 1000;

const allowedNames = [
  "Emiliano", "Fiona", "Eliot", "Krishay", "Channing", "Anna", "Mayla", "Adela",
  "Nathaniel", "Noah", "Stefan", "Michael", "Adam", "Nicholas", "Samuel", "Jonah",
  "Amber", "Annie", "Conor", "Christopher", "Seneca", "Magnus", "Jace", "Martin",
  "Daehan", "Charles", "Ava", "Dexter", "Charlie", "Charles", "Nick", "Sam", "Nate",
  "Aleksander", "Alek", "Eli", "Saral", "Jackson", "Yael", "Julia"
];

function capitalizeFirstLetter(name) {
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

function getRandomColor() {
  let color;
  do {
    color = "#" + Math.floor(Math.random() * 16777215).toString(16);
  } while (color.toLowerCase() === "#ffffff");
  return color;
}

function enterChat() {
  const enteredUsername = usernameInput.value.trim();
  const capitalizedUsername = capitalizeFirstLetter(enteredUsername);

  if (!allowedNames.includes(capitalizedUsername)) {
    if (usernameError) {
      usernameError.textContent = "That name is not allowed. Please use your real name.";
      usernameError.style.color = "red";
      usernameError.style.display = "block";
    }
    return;
  }

  if (enteredUsername) {
    username = capitalizedUsername;
    localStorage.setItem('username', username);
    const color = getRandomColor();
    const avatar = username[0].toUpperCase();
    socket.emit('new user', username, color, avatar);
    usernameScreen.classList.add('hidden');
    chatUI.classList.remove('hidden');
    usernameError.textContent = '';
    startIdleDetection();
    startStatusLogging();
  }
}

enterChatBtn.addEventListener('click', enterChat);
usernameInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') enterChat();
});

function sendMessage() {
  if (input.value.trim()) {
    if (privateRecipient) {
      socket.emit('private message', { recipient: privateRecipient, message: input.value });
      logPrivateMessage(input.value);
    } else {
      socket.emit('chat message', input.value);
    }
    socket.emit('typing', false);
    input.value = '';
  }
}

sendButton.addEventListener('click', (e) => {
  e.preventDefault();
  sendMessage();
});

input.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendMessage();
  }
});

input.addEventListener('input', () => {
  socket.emit('typing', input.value.length > 0);
});

function isNearBottom(element, threshold = 100) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < threshold;
}

socket.on('chat history', (history) => {
  history.forEach(displayMessage);
});

socket.on('chat message', displayMessage);

socket.on('private message', msg => {
  const wasNearBottom = isNearBottom(messages);
  const item = document.createElement('div');
  item.innerHTML = `
    <div class="bg-green-100 p-2 rounded-md">
      <strong>Private from ${msg.user}: </strong>${sanitize(msg.text)}
    </div>
  `;
  messages.appendChild(item);
  if (wasNearBottom) {
    messages.scrollTop = messages.scrollHeight;
  }
});

socket.on('pinned message', (msg) => {
  if (msg.trim() === '') {
    pinnedContainer.classList.add('hidden');
    pinnedText.textContent = '';
  } else {
    pinnedText.textContent = msg;
    pinnedContainer.classList.remove('hidden');
  }
});

// Typing Indicator logic with simple implementation, no extra styling classes
socket.on('typing', data => {
  typingIndicator.textContent = data.isTyping ? `${data.user} is typing...` : 'No one is typing.';
  // Remove any styling classes related to orange background, text color, padding, etc.
  typingIndicator.classList.remove('bg-orange-500', 'text-white', 'px-2', 'py-1', 'rounded-full');
});

socket.on('update users', users => {
  onlineUsersList.innerHTML = '';
  users.forEach(user => {
    if (user.username === username) return;

    const userItem = document.createElement('li');
    userItem.classList.add('relative', 'group');
    userItem.innerHTML = `
      <button class="text-blue-600 underline hover:text-blue-800" data-username="${user.username}">
        ${user.username} ${user.status === 'idle' ? '(Idle)' : ''}
      </button>
    `;
    const nameBtn = userItem.querySelector('button');
    nameBtn.addEventListener('click', () => {
      privateRecipient = user.username;
      logChatMessage(`Started private chat with ${user.username}`);
      chatType.textContent = 'Private Chat';
      currentChatWith.textContent = privateRecipient;
    });
    onlineUsersList.appendChild(userItem);
  });
});

emojiBtn.addEventListener('click', () => {
  emojiContainer.classList.remove('hidden');
});

emojiPicker.addEventListener('emoji-click', (event) => {
  input.value += event.detail.unicode;
});

closeEmojiBtn.addEventListener('click', () => {
  emojiContainer.classList.add('hidden');
});

settingsBtn.addEventListener('click', () => {
  settingsModal.classList.remove('hidden');
});

closeSettingsButton.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

startPrivateChatButton.addEventListener('click', () => {
  privateRecipient = privateChatInput.value.trim();
  if (privateRecipient) {
    logChatMessage(`Started private chat with ${privateRecipient}`);
    settingsModal.classList.add('hidden');
    chatType.textContent = 'Private Chat';
    currentChatWith.textContent = privateRecipient;
  } else {
    logChatMessage('Please enter a valid username for private chat.');
  }
});

publicChatButton.addEventListener('click', switchToPublic);
publicChatButtonTop.addEventListener('click', switchToPublic);

function switchToPublic() {
  privateRecipient = null;
  logChatMessage('Switched to public chat.');
  chatType.textContent = 'Public Chat';
  currentChatWith.textContent = 'No one';
}

changeUsernameButton.addEventListener('click', () => {
  const newUsername = changeUsernameInput.value.trim();
  const capitalizedUsername = capitalizeFirstLetter(newUsername);

  if (!allowedNames.includes(capitalizedUsername) || capitalizedUsername === "Eli") {
    logChatMessage('This username is not allowed. Please use your own name.');
    return;
  }

  if (newUsername) {
    socket.emit('username changed', capitalizedUsername);
    username = capitalizedUsername;
    localStorage.setItem('username', username);
    logChatMessage(`Username changed to ${capitalizedUsername}`);
    changeUsernameInput.value = '';
    settingsModal.classList.add('hidden');
  } else {
    logChatMessage('Please enter a valid new username.');
  }
});

function displayMessage(msg) {
  const wasNearBottom = isNearBottom(messages);
  const item = document.createElement('div');
  item.classList.add('message-item');
  item.innerHTML = `
    <div class="flex items-center space-x-2 mb-1">
      <div class="w-6 h-6 rounded-full bg-gray-300 flex items-center justify-center text-white text-sm font-bold" style="background-color: ${msg.color}">
        ${msg.avatar}
      </div>
      <span class="text-sm font-medium" style="color: ${msg.color}">${msg.user}</span>
      <span class="text-xs text-gray-500">${msg.time}</span>
    </div>
    <div class="ml-8">${sanitize(msg.text)}</div>
  `;
  messages.appendChild(item);
  // Unread badge logic
  if (!isNearBottom(messages)) {
    unreadCount++;
    updateUnreadBadge();
  }
  if (wasNearBottom) {
    messages.scrollTop = messages.scrollHeight;
  }
  if (isNearBottom(messages)) {
    unreadCount = 0;
    updateUnreadBadge();
  }
}

function logChatMessage(text) {
  const wasNearBottom = isNearBottom(messages);
  const item = document.createElement('div');
  item.innerHTML = `<div class="text-gray-500 text-sm italic">${text}</div>`;
  messages.appendChild(item);
  if (wasNearBottom) {
    messages.scrollTop = messages.scrollHeight;
  }
  if (isNearBottom(messages)) {
    unreadCount = 0;
    updateUnreadBadge();
  }
}

function logPrivateMessage(text) {
  const wasNearBottom = isNearBottom(messages);
  const item = document.createElement('div');
  item.innerHTML = `
    <div class="bg-blue-100 p-2 rounded-md">
      <strong>Private to ${privateRecipient}: </strong>${sanitize(text)}
    </div>
  `;
  messages.appendChild(item);
  if (wasNearBottom) {
    messages.scrollTop = messages.scrollHeight;
  }
  if (isNearBottom(messages)) {
    unreadCount = 0;
    updateUnreadBadge();
  }
}

function sanitize(input) {
  const div = document.createElement('div');
  div.innerText = input;
  return div.innerHTML;
}

// IDLE DETECTION
function startIdleDetection() {
  document.addEventListener('mousemove', resetIdleTimer);
  document.addEventListener('keypress', resetIdleTimer);
  resetIdleTimer();
}

function resetIdleTimer() {
  if (userStatus !== 'active') {
    userStatus = 'active';
    socket.emit('update status', { status: 'active' });
  }

  clearTimeout(idleTimeout);
  idleTimeout = setTimeout(() => {
    userStatus = 'idle';
    socket.emit('update status', { status: 'idle' });
  }, idleLimit);

  lastInteractionTime = Date.now();
}

function startStatusLogging() {
  setInterval(() => {
    const idleDuration = Math.round((Date.now() - lastInteractionTime) / 1000);
    console.log(`User ${username} status: ${userStatus} (Last interaction: ${idleDuration} seconds ago)`);
  }, statusLogInterval);
}

socket.on('update status', ({ username, status }) => {
  const userElement = document.querySelector(`[data-username="${username}"]`);
  if (userElement) {
    const statusText = status === 'idle' ? '(Idle)' : '';
    userElement.innerHTML = `${username} ${statusText}`;
  }
});

// 🔒 SHUTDOWN FUNCTIONALITY
document.getElementById('shutdown-btn').addEventListener('click', () => {
  const password = document.getElementById('shutdown-password').value;
  const errorMsg = document.getElementById('shutdown-error');
  if (password === 'eliadmin123') {
    socket.emit('admin shutdown');
    errorMsg.classList.add('hidden');
  } else {
    errorMsg.classList.remove('hidden');
  }
});

socket.on('shutdown initiated', () => {
  messages.innerHTML = '';
  input.disabled = true;
  sendButton.disabled = true;
});

// 🔒 TEMP DISABLE FUNCTIONALITY
// Listen for temp disable event and disable chat UI
socket.on('temp disable', () => {
  messages.innerHTML = '';
  const msg = document.createElement('div');
  msg.classList.add('text-gray-500', 'text-sm', 'italic');
  msg.textContent = 'Admin Has Enabled Temp Chat Disable';
  messages.appendChild(msg);
  input.disabled = false;
  sendButton.disabled = false;
});

// On page load, check if temp disable is active
window.addEventListener('load', () => {
  socket.emit('check temp disable');
});

socket.on('temp disable status', (isDisabled) => {
  if (isDisabled) {
    messages.innerHTML = '';
    const msg = document.createElement('div');
    msg.classList.add('text-gray-500', 'text-sm', 'italic');
    msg.textContent = 'Admin Has Enabled Temp Chat Disable';
    messages.appendChild(msg);
    input.disabled = true;
    sendButton.disabled = true;
  }
});

// Listen for "you were kicked" event and disable chat UI
socket.on('you were kicked', () => {
  input.disabled = true;
  sendButton.disabled = true;

  const msg = document.createElement('div');
  msg.classList.add('text-red-500', 'text-sm', 'italic');
  msg.textContent = 'You were kicked by an admin and can no longer send messages.';
  messages.appendChild(msg);
});

// 🔄 CLEAR HISTORY FUNCTIONALITY
socket.on('clear history', () => {
  messages.innerHTML = '';
});

// --- UNREAD BADGE UTILITY ---
function updateUnreadBadge() {
  if (unreadBadge) {
    if (unreadCount > 0) {
      unreadBadge.textContent = `${unreadCount} new message${unreadCount === 1 ? '' : 's'}`;
      unreadBadge.classList.remove('hidden');
    } else {
      unreadBadge.classList.add('hidden');
    }
  }
}

// Reset unread messages when user scrolls to bottom
messages.addEventListener('scroll', () => {
  if (isNearBottom(messages)) {
    unreadCount = 0;
    updateUnreadBadge();
  }
});

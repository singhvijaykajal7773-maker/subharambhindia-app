// ===================== STATE =====================
let TOKEN = localStorage.getItem('sai_token') || null;
let ME = null;
let socket = null;
const PENDING_ICE = new Map();
let CHATS = [];
let ACTIVE_CHAT_ID = null;
let ONLINE_IDS = new Set();
let TYPING_TIMEOUT = null;
let ACTIVE_CALL = null;
let LOCAL_STREAM = null;
let PEER = null;
let CALL_IS_CALLER = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function api(path, options = {}) {
  const headers = options.headers || {};
  if (TOKEN) headers['Authorization'] = `Bearer ${TOKEN}`;
  if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  return fetch(`/api${path}`, { ...options, headers })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    });
}

function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function showError(msg) {
  const el = $('#auth-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
function clearError() { $('#auth-error').classList.add('hidden'); }

// ===================== AUTH FLOW =====================
let currentPhone = null;

$('#btn-request-otp').addEventListener('click', async () => {
  clearError();
  const phone = $('#input-phone').value.trim();
  if (!phone) return showError('Enter your phone number');
  try {
    const res = await api('/auth/request-otp', { method: 'POST', body: JSON.stringify({ phone }) });
    currentPhone = phone;
    $('#step-phone').classList.add('hidden');
    $('#step-otp').classList.remove('hidden');
    $('#demo-otp-hint').textContent = res.demoOtp
      ? `Demo mode: your OTP is ${res.demoOtp} (no SMS sent)`
      : 'OTP sent to your phone';
  } catch (e) { showError(e.message); }
});

$('#link-back-phone').addEventListener('click', (e) => {
  e.preventDefault();
  $('#step-otp').classList.add('hidden');
  $('#step-phone').classList.remove('hidden');
  clearError();
});

$('#btn-verify-otp').addEventListener('click', async () => {
  clearError();
  const otp = $('#input-otp').value.trim();
  if (!otp) return showError('Enter the OTP');
  try {
    const res = await api('/auth/verify-otp', { method: 'POST', body: JSON.stringify({ phone: currentPhone, otp }) });
    if (res.status === 'login') {
      loginSuccess(res.token, res.user);
    } else {
      $('#step-otp').classList.add('hidden');
      $('#step-profile').classList.remove('hidden');
      $('#step-profile').dataset.tempToken = res.tempToken;
    }
  } catch (e) { showError(e.message); }
});

$('#btn-complete-profile').addEventListener('click', async () => {
  clearError();
  const tempToken = $('#step-profile').dataset.tempToken;
  const name = $('#input-name').value.trim();
  const username = $('#input-username').value.trim();
  const password = $('#input-password').value;
  if (!name || !username || !password) return showError('All fields are required');
  try {
    const res = await api('/auth/complete-profile', { method: 'POST', body: JSON.stringify({ tempToken, name, username, password }) });
    loginSuccess(res.token, res.user);
  } catch (e) { showError(e.message); }
});

$('#link-password-login').addEventListener('click', (e) => {
  e.preventDefault();
  $('#step-phone').classList.add('hidden');
  $('#step-password').classList.remove('hidden');
  clearError();
});
$('#link-back-phone-2').addEventListener('click', (e) => {
  e.preventDefault();
  $('#step-password').classList.add('hidden');
  $('#step-phone').classList.remove('hidden');
  clearError();
});
$('#btn-login-password').addEventListener('click', async () => {
  clearError();
  const username = $('#input-login-username').value.trim();
  const password = $('#input-login-password').value;
  if (!username || !password) return showError('Enter username and password');
  try {
    const res = await api('/auth/login-password', { method: 'POST', body: JSON.stringify({ username, password }) });
    loginSuccess(res.token, res.user);
  } catch (e) { showError(e.message); }
});

function applyRoleUI() { const owner = ME?.role === 'owner'; const business = ['owner','admin','manager'].includes(ME?.role); $$('.owner-only').forEach(el => el.classList.toggle('hidden', !owner)); $$('.business-only').forEach(el => el.classList.toggle('hidden', !business)); const mtab=$('[data-tab="marketing"]'); if(mtab) mtab.classList.toggle('hidden', !business); }

function loginSuccess(token, user) {
  TOKEN = token;
  ME = user;
  applyRoleUI();
  localStorage.setItem('sai_token', token);
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  document.body.classList.add('app-active');
  connectSocket();
  loadChats();
  hydrateSettings();
}

$('#btn-logout').addEventListener('click', () => {
  localStorage.removeItem('sai_token');
  if (socket) socket.disconnect();
  location.reload();
});

// ===================== PWA INSTALL =====================
let deferredInstallPrompt = null;
const installBtn = document.getElementById('btn-install-app');
const installHelp = document.getElementById('install-help');
function isIOSDevice(){ return /iphone|ipad|ipod/i.test(navigator.userAgent); }
function isStandalone(){ return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }
function showInstallHelp(message){
  if(!installHelp) return;
  installHelp.textContent = message;
  installHelp.classList.remove('hidden');
}
if (installBtn) {
  if (isStandalone()) {
    installBtn.textContent = '✓ App Installed';
    installBtn.disabled = true;
  }
  installBtn.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice.catch(()=>null);
      deferredInstallPrompt = null;
      if (choice?.outcome === 'accepted') {
        installBtn.textContent = '✓ App Installed';
        installBtn.disabled = true;
      }
      return;
    }
    if (isIOSDevice()) {
      showInstallHelp('iPhone/iPad: Safari में Share (□↑) दबाएँ → Add to Home Screen चुनें।');
      return;
    }
    showInstallHelp('अपने browser के address bar/menu में Install App या Add to Home Screen विकल्प चुनें। यह विकल्प HTTPS पर supported browsers में दिखाई देता है।');
  });
}
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (installBtn && !isStandalone()) installBtn.classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  if (installBtn) { installBtn.textContent = '✓ App Installed'; installBtn.disabled = true; }
});

// ===================== BOOTSTRAP (existing session) =====================
async function bootstrap() {
  if (!TOKEN) return;
  try {
    const res = await api('/auth/me');
    ME = res.user;
    applyRoleUI();
    $('#auth-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');
    document.body.classList.add('app-active');
    connectSocket();
    loadChats();
    hydrateSettings();
  } catch (e) {
    localStorage.removeItem('sai_token');
    TOKEN = null;
  }
}
bootstrap();

// ===================== SOCKET =====================
function connectSocket() {
  socket = io({ auth: { token: TOKEN } });

  socket.on('message:new', (msg) => {
    if (msg.chatId === ACTIVE_CHAT_ID) {
      renderMessage(msg);
      scrollMessagesToBottom();
      socket.emit('message:read', { chatId: msg.chatId, messageIds: [msg.id] });
    }
    loadChats();
  });

  socket.on('message:typing', ({ chatId, userId }) => {
    if (chatId === ACTIVE_CHAT_ID && userId !== ME.id) {
      $('#typing-indicator').textContent = 'typing…';
      $('#typing-indicator').classList.remove('hidden');
      clearTimeout(TYPING_TIMEOUT);
      TYPING_TIMEOUT = setTimeout(() => $('#typing-indicator').classList.add('hidden'), 2000);
    }
  });

  socket.on('message:reacted', ({ messageId, reactions }) => {
    const el = document.querySelector(`[data-msg-id="${messageId}"] .reactions`);
    if (el) el.textContent = formatReactions(reactions);
  });

  socket.on('message:edited', ({ messageId, text }) => {
    const el = document.querySelector(`[data-msg-id="${messageId}"] .msg-text`);
    if (el) el.textContent = text;
  });

  socket.on('message:deletedForEveryone', ({ messageId }) => {
    const el = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (el) el.querySelector('.msg-text')?.replaceWith(Object.assign(document.createElement('span'), { className: 'msg-text', textContent: '🚫 This message was deleted' }));
  });

  socket.on('presence:online', ({ userId }) => { ONLINE_IDS.add(userId); updateSubtitle(); });
  socket.on('presence:offline', ({ userId }) => { ONLINE_IDS.delete(userId); updateSubtitle(); });

  socket.on('chat:new', () => loadChats());
  socket.on('chat:updated', () => { loadChats(); if (ACTIVE_CHAT_ID) openChat(ACTIVE_CHAT_ID); });
  socket.on('chat:removed', ({ chatId }) => {
    if (chatId === ACTIVE_CHAT_ID) {
      ACTIVE_CHAT_ID = null;
      $('#chat-active').classList.add('hidden');
      $('#chat-empty').classList.remove('hidden');
    }
    loadChats();
  });

  socket.on('status:new', () => loadStatuses());

  socket.on('call:incoming', async (data) => { await handleIncomingCall(data); });
  socket.on('call:offer', async (data) => { if(!ACTIVE_CALL || ACTIVE_CALL.callId!==data.callId) return; await PEER?.setRemoteDescription(new RTCSessionDescription(data.offer)); await flushPendingIce(data.callId); const answer=await PEER.createAnswer(); await PEER.setLocalDescription(answer); socket.emit('call:answer',{callId:data.callId,chatId:data.chatId,targetUserId:data.fromUserId,answer:PEER.localDescription}); $('#call-status').textContent='Connected'; });
  socket.on('call:answer', async (data) => { if(!ACTIVE_CALL || ACTIVE_CALL.callId!==data.callId) return; await PEER?.setRemoteDescription(new RTCSessionDescription(data.answer)); await flushPendingIce(data.callId); $('#call-status').textContent='Connected'; });
  socket.on('call:ice', async (data) => { if(!ACTIVE_CALL || ACTIVE_CALL.callId!==data.callId) return; try{ if(!PEER?.remoteDescription){ const key=data.callId; const list=PENDING_ICE.get(key)||[]; list.push(data.candidate); PENDING_ICE.set(key,list); return; } await PEER.addIceCandidate(new RTCIceCandidate(data.candidate)); }catch(e){ console.warn('ICE candidate failed',e); } });
  socket.on('call:end', (data) => { if(ACTIVE_CALL?.callId===data.callId) endCall(false,data.reason||'Call ended'); });
  socket.on('error:message', (e) => alert(e.error));
}


// ===================== VOICE / VIDEO CALLING =====================
function callTargetFromChat(){
  const chat=CHATS.find(c=>c.id===ACTIVE_CHAT_ID); if(!chat||chat.type!=='direct') return null;
  return chat.memberIds.find(id=>id!==ME.id) || null;
}
async function getCallMedia(kind){
  if(!navigator.mediaDevices?.getUserMedia) throw new Error('Camera/microphone is not available in this browser/context. Use HTTPS or localhost.');
  return navigator.mediaDevices.getUserMedia(kind==='video'?{audio:true,video:{facingMode:'user'}}:{audio:true,video:false});
}
function resetCallUI(){
  $('#call-overlay')?.classList.add('hidden'); $('#remote-video').srcObject=null; $('#local-video').srcObject=null; $('#audio-call-avatar').classList.add('hidden');
  $('#call-mute').textContent='🎤 Mute'; $('#call-camera').textContent='📷 Camera';
}
async function flushPendingIce(callId){ const list=PENDING_ICE.get(callId)||[]; for(const c of list){ try{await PEER?.addIceCandidate(new RTCIceCandidate(c));}catch(e){console.warn('Queued ICE failed',e);} } PENDING_ICE.delete(callId); }
async function preparePeer(targetUserId,chatId,callId,kind){
  PEER=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
  PEER.onicecandidate=e=>{if(e.candidate) socket.emit('call:ice',{callId,chatId,targetUserId,candidate:e.candidate});};
  PEER.ontrack=e=>{ $('#remote-video').srcObject=e.streams[0]; }; 
  PEER.onconnectionstatechange=()=>{ const s=PEER.connectionState; if(s==='connected') $('#call-status').textContent='Connected'; if(['failed','disconnected','closed'].includes(s)) $('#call-status').textContent='Connection lost'; };
  LOCAL_STREAM=await getCallMedia(kind); LOCAL_STREAM.getTracks().forEach(t=>PEER.addTrack(t,LOCAL_STREAM)); $('#local-video').srcObject=LOCAL_STREAM;
  if(kind==='audio'){ $('#local-video').classList.add('hidden'); $('#remote-video').classList.add('hidden'); $('#audio-call-avatar').classList.remove('hidden'); }
  else { $('#local-video').classList.remove('hidden'); $('#remote-video').classList.remove('hidden'); }
}
async function startCall(kind){
  const targetUserId=callTargetFromChat(); if(!targetUserId) return alert('Voice/Video call is available for one-to-one chats.');
  const other=CHATS.find(c=>c.id===ACTIVE_CHAT_ID); const targetName=other?.name||'Contact';
  const callId=crypto.randomUUID(); ACTIVE_CALL={callId,chatId:ACTIVE_CHAT_ID,targetUserId,kind}; CALL_IS_CALLER=true;
  $('#call-title').textContent=`${kind==='video'?'Video':'Voice'} call — ${targetName}`; $('#call-status').textContent='Calling…'; $('#call-overlay').classList.remove('hidden');
  try{ await preparePeer(targetUserId,ACTIVE_CHAT_ID,callId,kind); const offer=await PEER.createOffer(); await PEER.setLocalDescription(offer); socket.emit('call:start',{callId,chatId:ACTIVE_CHAT_ID,targetUserId,kind}); socket.emit('call:offer',{callId,chatId:ACTIVE_CHAT_ID,targetUserId,offer:PEER.localDescription}); }
  catch(e){ alert(e.message); endCall(false,'Could not start call'); }
}
async function handleIncomingCall(data){
  if(ACTIVE_CALL){ socket.emit('call:end',{callId:data.callId,chatId:data.chatId,targetUserId:data.callerId,reason:'Busy'}); return; }
  const ok=confirm(`${data.callerName} is calling you by ${data.kind==='video'?'video':'voice'}.\n\nAccept?`); if(!ok){socket.emit('call:end',{callId:data.callId,chatId:data.chatId,targetUserId:data.callerId,reason:'Declined'});return;}
  ACTIVE_CALL={callId:data.callId,chatId:data.chatId,targetUserId:data.callerId,kind:data.kind}; CALL_IS_CALLER=false;
  $('#call-title').textContent=`${data.kind==='video'?'Video':'Voice'} call — ${data.callerName}`; $('#call-status').textContent='Connecting…'; $('#call-overlay').classList.remove('hidden');
  try{ await preparePeer(data.callerId,data.chatId,data.callId,data.kind); }
  catch(e){ alert(e.message); endCall(false,'Could not accept call'); }
}
function endCall(emit=true,reason='Call ended'){
  if(emit && ACTIVE_CALL && socket) socket.emit('call:end',{callId:ACTIVE_CALL.callId,chatId:ACTIVE_CALL.chatId,targetUserId:ACTIVE_CALL.targetUserId,reason});
  if(ACTIVE_CALL) PENDING_ICE.delete(ACTIVE_CALL.callId); LOCAL_STREAM?.getTracks().forEach(t=>t.stop()); LOCAL_STREAM=null; PEER?.close(); PEER=null; ACTIVE_CALL=null; resetCallUI();
}
$('#btn-voice-call')?.addEventListener('click',()=>startCall('audio'));
$('#btn-video-call')?.addEventListener('click',()=>startCall('video'));
$('#call-end')?.addEventListener('click',()=>endCall(true,'Ended'));
$('#call-close')?.addEventListener('click',()=>endCall(true,'Closed'));
$('#call-mute')?.addEventListener('click',()=>{const t=LOCAL_STREAM?.getAudioTracks()[0]; if(!t)return; t.enabled=!t.enabled; $('#call-mute').textContent=t.enabled?'🎤 Mute':'🔇 Unmute';});
$('#call-camera')?.addEventListener('click',()=>{const t=LOCAL_STREAM?.getVideoTracks()[0]; if(!t)return; t.enabled=!t.enabled; $('#call-camera').textContent=t.enabled?'📷 Camera':'🚫 Camera';});

// ===================== TABS =====================
$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'status') loadStatuses();
    if (btn.dataset.tab === 'contacts') loadContacts();
  });
});

// ===================== CHATS LIST =====================
async function loadChats() {
  const res = await api('/chats');
  CHATS = res.chats;
  renderChatList();
}

function renderChatList() {
  const list = $('#chat-list');
  list.innerHTML = '';
  if (CHATS.length === 0) {
    list.innerHTML = '<p style="padding:16px;color:#6b7280;font-size:13px;">No chats yet. Go to Contacts to start one.</p>';
    return;
  }
  CHATS.forEach(chat => {
    const item = document.createElement('div');
    item.className = 'list-item' + (chat.id === ACTIVE_CHAT_ID ? ' active' : '');
    const lastText = chat.lastMessage
      ? (chat.lastMessage.mediaUrl ? '📎 Attachment' : chat.lastMessage.text)
      : (chat.type === 'group' ? 'Group created' : 'Say hello 👋');
    item.innerHTML = `
      <div class="avatar-sm">${chat.avatar ? `<img src="${escapeHtml(chat.avatar)}" alt="" />` : initials(chat.name)}</div>
      <div class="list-item-text">
        <div class="list-item-name">${escapeHtml(chat.name || 'Unnamed')}</div>
        <div class="list-item-sub">${escapeHtml(lastText || '')}</div>
      </div>
      ${chat.unreadCount > 0 ? `<div class="unread-badge">${chat.unreadCount}</div>` : ''}
    `;
    item.addEventListener('click', () => openChat(chat.id));
    list.appendChild(item);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ===================== ACTIVE CHAT =====================
async function openChat(chatId) {
  ACTIVE_CHAT_ID = chatId;
  renderChatList();
  const res = await api(`/chats/${chatId}`);
  const chat = res.chat;

  $('#chat-empty').classList.add('hidden');
  $('#chat-active').classList.remove('hidden');
  $('#chat-window').classList.add('mobile-open');
  $('#chat-title').textContent = chat.name || 'Unnamed';
  setAvatarElement($('#chat-avatar'), { name: chat.name, avatar: chat.avatar });
  $('#btn-group-info').classList.toggle('hidden', chat.type !== 'group');
  $('#btn-group-info').onclick = () => showGroupInfo(chat);
  updateSubtitle(chat);

  const msgsRes = await api(`/chats/${chatId}/messages?limit=100`);
  const container = $('#messages');
  container.innerHTML = '';
  msgsRes.messages.forEach(renderMessage);
  scrollMessagesToBottom();

  const unread = msgsRes.messages.filter(m => m.senderId !== ME.id && !m.readBy.includes(ME.id)).map(m => m.id);
  if (unread.length) socket.emit('message:read', { chatId, messageIds: unread });

  window.__currentChat = chat;
}

$('#btn-mobile-back').addEventListener('click', () => {
  $('#chat-window').classList.remove('mobile-open');
  $('#chat-active').classList.add('hidden');
  $('#chat-empty').classList.remove('hidden');
  ACTIVE_CHAT_ID = null;
  renderChatList();
});

function updateSubtitle(chat) {
  chat = chat || window.__currentChat;
  if (!chat || chat.id !== ACTIVE_CHAT_ID) return;
  if (chat.type === 'group') {
    $('#chat-subtitle').textContent = `${chat.memberIds.length} members`;
  } else {
    const otherId = chat.memberIds.find(id => id !== ME.id);
    $('#chat-subtitle').textContent = ONLINE_IDS.has(otherId) ? 'Online' : 'Offline';
  }
}

function renderMessage(msg) {
  const mine = msg.senderId === ME.id;
  const row = document.createElement('div');
  row.className = 'msg-row ' + (mine ? 'mine' : 'theirs');
  row.dataset.msgId = msg.id;

  let mediaHtml = '';
  if (msg.mediaUrl) {
    if (msg.mediaType === 'image') mediaHtml = `<img src="${msg.mediaUrl}" />`;
    else if (msg.mediaType === 'video') mediaHtml = `<video src="${msg.mediaUrl}" controls></video>`;
    else if (msg.mediaType === 'audio') mediaHtml = `<audio src="${msg.mediaUrl}" controls></audio>`;
    else mediaHtml = `<a class="doc-link" href="${msg.mediaUrl}" target="_blank">📄 Download file</a>`;
  }

  const sender = window.__currentChat?.type === 'group' && !mine
    ? `<span class="sender-name">${escapeHtml(getUserName(msg.senderId))}</span>` : '';

  row.innerHTML = `
    <div class="bubble">
      ${sender}
      <span class="msg-text">${escapeHtml(msg.text)}</span>
      ${mediaHtml}
      <span class="reactions">${formatReactions(msg.reactions)}</span>
      <div class="meta">${fmtTime(msg.createdAt)}${mine ? (msg.readBy.length > 1 ? ' ✓✓' : ' ✓') : ''}</div>
    </div>
  `;
  row.addEventListener('dblclick', () => {
    socket.emit('message:react', { messageId: msg.id, emoji: '❤️' });
  });
  $('#messages').appendChild(row);
}

function formatReactions(reactions) {
  if (!reactions) return '';
  const parts = Object.entries(reactions).filter(([, users]) => users.length > 0).map(([emoji, users]) => `${emoji}${users.length}`);
  return parts.join(' ');
}

function getUserName(userId) {
  if (userId === ME.id) return 'You';
  const chat = window.__currentChat;
  const member = chat?.members?.find(m => m.id === userId);
  return member ? member.name : 'Unknown';
}

function scrollMessagesToBottom() {
  const c = $('#messages');
  c.scrollTop = c.scrollHeight;
}

// ===================== COMPOSER =====================
$('#message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage();
  else if (ACTIVE_CHAT_ID) socket.emit('message:typing', { chatId: ACTIVE_CHAT_ID });
});
$('#btn-send').addEventListener('click', sendMessage);

function sendMessage() {
  const input = $('#message-input');
  const text = input.value.trim();
  if (!text || !ACTIVE_CHAT_ID) return;
  socket.emit('message:send', { chatId: ACTIVE_CHAT_ID, text });
  input.value = '';
}

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !ACTIVE_CHAT_ID) return;
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await api('/upload', { method: 'POST', body: form });
    socket.emit('message:send', { chatId: ACTIVE_CHAT_ID, text: '', mediaUrl: res.url, mediaType: res.mediaType });
  } catch (err) {
    alert('Upload failed: ' + err.message);
  }
  e.target.value = '';
});

// ===================== CONTACTS =====================
async function loadContacts(q = '') {
  const res = await api(`/users?q=${encodeURIComponent(q)}`);
  const list = $('#contact-list');
  list.innerHTML = '';
  res.users.forEach(u => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="avatar-sm">${u.avatar ? `<img src="${escapeHtml(u.avatar)}" alt="" />` : initials(u.name)}</div>
      <div class="list-item-text">
        <div class="list-item-name">${escapeHtml(u.name)}</div>
        <div class="list-item-sub">@${escapeHtml(u.username)}</div>
      </div>
    `;
    item.addEventListener('click', async () => {
      const res = await api('/chats/direct', { method: 'POST', body: JSON.stringify({ otherUserId: u.id }) });
      await loadChats();
      $$('.tab-btn')[0].click();
      openChat(res.chat.id);
    });
    list.appendChild(item);
  });
}
$('#contact-search').addEventListener('input', (e) => loadContacts(e.target.value));

// ===================== GROUPS =====================
$('#btn-new-group').addEventListener('click', async () => {
  const res = await api('/users');
  openModal(`
    <h3>New Group</h3>
    <input id="modal-group-name" type="text" placeholder="Group name" />
    <div id="modal-member-list">
      ${res.users.map(u => `
        <div class="checkbox-row">
          <input type="checkbox" value="${u.id}" id="member-${u.id}" />
          <label for="member-${u.id}">${escapeHtml(u.name)} (@${escapeHtml(u.username)})</label>
        </div>
      `).join('')}
    </div>
    <button id="modal-create-group" class="btn-primary" style="margin-top:14px;">Create Group</button>
  `);
  $('#modal-create-group').addEventListener('click', async () => {
    const name = $('#modal-group-name').value.trim();
    if (!name) return alert('Group name required');
    const memberIds = Array.from($('#modal-member-list').querySelectorAll('input:checked')).map(i => i.value);
    const cres = await api('/chats/group', { method: 'POST', body: JSON.stringify({ name, memberIds }) });
    closeModal();
    await loadChats();
    $$('.tab-btn')[0].click();
    openChat(cres.chat.id);
  });
});

function showGroupInfo(chat) {
  const isAdmin = chat.adminIds.includes(ME.id);
  const otherMembers = chat.members.filter(m => m.id !== ME.id);
  const memberRows = chat.members.map(m => `
    <div class="group-member-row">
      <div class="avatar-sm">${initials(m.name)}</div>
      <div class="list-item-text">
        <div class="list-item-name">${escapeHtml(m.name)}${m.id === ME.id ? ' (You)' : ''} ${chat.adminIds.includes(m.id) ? '<span class="admin-badge">ADMIN</span>' : ''}</div>
        <div class="list-item-sub">@${escapeHtml(m.username)}</div>
      </div>
      ${isAdmin && m.id !== ME.id ? `<div class="member-actions"><button class="btn-small btn-remove-member" data-user-id="${m.id}">Remove</button>${!chat.adminIds.includes(m.id) ? `<button class="btn-small btn-make-admin" data-user-id="${m.id}">Make Admin</button>` : ''}</div>` : ''}
    </div>
  `).join('');

  openModal(`
    <h3>${escapeHtml(chat.name)}</h3>
    <p class="modal-muted">${escapeHtml(chat.description || 'No description')}</p>
    <div class="group-info-head"><h4>Members (${chat.members.length})</h4>${isAdmin ? '<button id="modal-add-members" class="btn-secondary">+ Add Member</button>' : ''}</div>
    <div class="group-members-list">${memberRows || '<p class="modal-muted">No members</p>'}</div>
    <button id="modal-leave-group" class="btn-danger">Leave Group</button>
  `);

  if (isAdmin) {
    $('#modal-add-members').addEventListener('click', async () => {
      try {
        const res = await api('/users');
        const available = res.users.filter(u => !chat.memberIds.includes(u.id));
        openModal(`
          <h3>Add Members</h3>
          <p class="modal-muted">Select people to add to this group.</p>
          <div id="modal-add-member-list">${available.length ? available.map(u => `
            <label class="checkbox-row"><input type="checkbox" value="${u.id}" /> <span><b>${escapeHtml(u.name)}</b><small>@${escapeHtml(u.username)}</small></span></label>
          `).join('') : '<p class="modal-muted">No new contacts available.</p>'}</div>
          <button id="modal-confirm-add-members" class="btn-primary">Add Selected Members</button>
        `);
        $('#modal-confirm-add-members').addEventListener('click', async () => {
          const userIds = [...$('#modal-add-member-list').querySelectorAll('input:checked')].map(i => i.value);
          if (!userIds.length) return alert('Select at least one member.');
          try {
            await api(`/chats/${chat.id}/members`, { method: 'POST', body: JSON.stringify({ userIds }) });
            const fresh = await api(`/chats/${chat.id}`);
            window.__currentChat = fresh.chat;
            closeModal();
            showGroupInfo(fresh.chat);
            updateSubtitle(fresh.chat);
            await loadChats();
          } catch (e) { alert(e.message); }
        });
      } catch (e) { alert(e.message); }
    });

    $$('.btn-remove-member').forEach(btn => btn.addEventListener('click', async () => {
      const userId = btn.dataset.userId;
      const member = chat.members.find(m => m.id === userId);
      if (!member || !confirm(`Remove ${member.name} from this group?`)) return;
      try {
        await api(`/chats/${chat.id}/members/${userId}`, { method: 'DELETE' });
        const fresh = await api(`/chats/${chat.id}`);
        window.__currentChat = fresh.chat;
        closeModal();
        showGroupInfo(fresh.chat);
        updateSubtitle(fresh.chat);
        await loadChats();
      } catch (e) { alert(e.message); }
    }));

    $$('.btn-make-admin').forEach(btn => btn.addEventListener('click', async () => {
      const userId = btn.dataset.userId;
      const member = chat.members.find(m => m.id === userId);
      if (!member || !confirm(`Make ${member.name} an admin?`)) return;
      try {
        await api(`/chats/${chat.id}/admins/${userId}`, { method: 'POST' });
        const fresh = await api(`/chats/${chat.id}`);
        window.__currentChat = fresh.chat;
        closeModal();
        showGroupInfo(fresh.chat);
        await loadChats();
      } catch (e) { alert(e.message); }
    }));
  }

  $('#modal-leave-group').addEventListener('click', async () => {
    if (!confirm('Leave this group?')) return;
    try {
      await api(`/chats/${chat.id}/members/${ME.id}`, { method: 'DELETE' });
      closeModal();
      ACTIVE_CHAT_ID = null;
      $('#chat-active').classList.add('hidden');
      $('#chat-empty').classList.remove('hidden');
      $('#chat-window').classList.remove('mobile-open');
      loadChats();
    } catch (e) { alert(e.message); }
  });
}
// ===================== STATUS =====================
async function loadStatuses() {
  const res = await api('/status');
  const list = $('#status-list');
  list.innerHTML = '';
  if (res.statusFeed.length === 0) {
    list.innerHTML = '<p style="padding:16px;color:#6b7280;font-size:13px;">No active statuses. Statuses disappear after 24 hours.</p>';
    return;
  }
  res.statusFeed.forEach(({ user, statuses }) => {
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="avatar-sm">${user.avatar ? `<img src="${escapeHtml(user.avatar)}" alt="" />` : initials(user.name)}</div>
      <div class="list-item-text">
        <div class="list-item-name">${escapeHtml(user.name)}${user.id === ME.id ? ' (You)' : ''}</div>
        <div class="list-item-sub">${statuses.length} update${statuses.length > 1 ? 's' : ''}</div>
      </div>
    `;
    item.addEventListener('click', () => viewStatuses(user, statuses));
    list.appendChild(item);
  });
}

function viewStatuses(user, statuses) {
  let idx = 0;
  function render() {
    const s = statuses[idx];
    if (s.userId !== ME.id) api(`/status/${s.id}/view`, { method: 'POST' }).catch(() => {});
    openModal(`
      <h3>${escapeHtml(user.name)}</h3>
      <p style="color:#6b7280;font-size:12px;">${new Date(s.createdAt).toLocaleString()}</p>
      ${s.mediaUrl ? `<img class="status-viewer-media" src="${s.mediaUrl}" />` : ''}
      <p>${escapeHtml(s.content)}</p>
      ${s.userId === ME.id ? `<p style="font-size:12px;color:#6b7280;">👁 Viewed by ${s.viewers.length}</p>` : ''}
      <div style="display:flex;gap:8px;">
        ${idx > 0 ? '<button id="status-prev" class="btn-secondary">‹ Prev</button>' : ''}
        ${idx < statuses.length - 1 ? '<button id="status-next" class="btn-secondary">Next ›</button>' : ''}
        ${s.userId === ME.id ? '<button id="status-delete" class="btn-danger">Delete</button>' : ''}
      </div>
    `);
    $('#status-prev')?.addEventListener('click', () => { idx--; render(); });
    $('#status-next')?.addEventListener('click', () => { idx++; render(); });
    $('#status-delete')?.addEventListener('click', async () => {
      await api(`/status/${s.id}`, { method: 'DELETE' });
      closeModal();
      loadStatuses();
    });
  }
  render();
}

$('#btn-add-status').addEventListener('click', () => {
  openModal(`
    <h3>Add Status</h3>
    <textarea id="status-text" placeholder="What's on your mind?"></textarea>
    <label class="attach-btn">📎 Attach photo<input type="file" id="status-file" accept="image/*" hidden /></label>
    <button id="status-post" class="btn-primary" style="margin-top:14px;">Post Status</button>
  `);
  $('#status-post').addEventListener('click', async () => {
    const content = $('#status-text').value.trim();
    const file = $('#status-file').files[0];
    let mediaUrl = null, type = 'text';
    if (file) {
      const form = new FormData();
      form.append('file', file);
      const ures = await api('/upload', { method: 'POST', body: form });
      mediaUrl = ures.url;
      type = 'photo';
    }
    if (!content && !mediaUrl) return alert('Add text or a photo');
    await api('/status', { method: 'POST', body: JSON.stringify({ type, content, mediaUrl }) });
    closeModal();
    loadStatuses();
  });
});

// ===================== SETTINGS =====================
function setAvatarElement(el, user) {
  if (!el) return;
  if (user?.avatar) {
    el.innerHTML = `<img src="${escapeHtml(user.avatar)}" alt="${escapeHtml(user.name || 'Profile')}" />`;
    el.classList.add('has-photo');
  } else {
    el.textContent = initials(user?.name);
    el.classList.remove('has-photo');
  }
}
function hydrateSettings() {
  $('#settings-name').value = ME.name || '';
  $('#settings-username').value = ME.username ? `@${ME.username}` : '';
  $('#settings-phone').value = ME.phone || '';
  $('#settings-about').value = ME.about || '';
  setAvatarElement($('#my-avatar'), ME);
}
$('#settings-avatar').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { alert('Please select an image'); e.target.value=''; return; }
  if (file.size > 5 * 1024 * 1024) { alert('Profile photo must be 5 MB or smaller'); e.target.value=''; return; }
  const form = new FormData();
  form.append('file', file);
  try {
    const res = await api('/users/me/avatar', { method: 'POST', body: form });
    ME = res.user;
    hydrateSettings();
    loadChats();
  } catch (err) { alert('Profile photo upload failed: ' + err.message); }
  e.target.value = '';
});
$('#btn-save-profile').addEventListener('click', async () => {
  const name = $('#settings-name').value.trim();
  const about = $('#settings-about').value.trim();
  if (!name) return alert('Name is required');
  try {
    const res = await api('/users/me', { method: 'PATCH', body: JSON.stringify({ name, about }) });
    ME = res.user;
    hydrateSettings();
    loadChats();
    alert('Profile saved');
  } catch (err) { alert(err.message); }
});

// ===================== MODAL HELPERS =====================
function openModal(html) {
  $('#modal-content').innerHTML = `<span id="modal-close" style="float:right;cursor:pointer;font-size:20px;">&times;</span>` + html;
  $('#modal-overlay').classList.remove('hidden');
  $('#modal-close').addEventListener('click', closeModal);
}
function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  $('#modal-content').innerHTML = '';
}
$('#modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'modal-overlay') closeModal();
});

// ===================== BUSINESS MARKETING / CRM =====================
let MARKETING_TIMER = null;
async function loadMarketing(){
  if(!ME) return;
  try{
    const [dash, campaigns, contacts] = await Promise.all([api('/marketing/dashboard'), api('/marketing/campaigns'), api('/marketing/contacts')]);
    ['contacts','campaigns','sent','delivered','read'].forEach(k=>{ const a=$(`#m-${k}`), b=$(`#md-${k}`); if(a)a.textContent=dash[k]??0; if(b)b.textContent=dash[k]??0; });
    renderCampaigns(campaigns.campaigns||[]); renderMarketingContacts(contacts.contacts||[]);
  }catch(e){ console.error(e); }
}
function renderCampaigns(items){
  const targets=[$('#campaign-list'),$('#campaign-list-main')].filter(Boolean); const html=items.length?items.map(c=>`<div class="campaign-row"><div class="campaign-row-head"><strong>${escapeHtml(c.name)}</strong><span class="campaign-status">${escapeHtml(c.status)}</span></div><div class="campaign-stats">${c.stats.total||0} recipients · ${c.stats.sent||0} sent · ${c.stats.delivered||0} delivered · ${c.stats.read||0} read</div>${c.status==='draft'||c.status==='paused'?`<button class="btn-secondary campaign-start" data-id="${c.id}" style="margin-top:8px">${c.status==='paused'?'Resume':'Start Campaign'}</button>`:''}<button class="btn-secondary campaign-internal" data-id="${c.id}" style="margin-top:8px;margin-left:6px">Send to App Users</button></div>`).join(''):'<p style="color:#6b7280;font-size:13px">No campaigns yet.</p>';targets.forEach(t=>t.innerHTML=html);$$('.campaign-start').forEach(b=>b.onclick=async()=>{await api(`/marketing/campaigns/${b.dataset.id}/start`,{method:'POST'});loadMarketing();});$$('.campaign-internal').forEach(b=>b.onclick=async()=>{if(!confirm('Send this campaign to matching registered app users now?'))return;try{const r=await api(`/marketing/campaigns/${b.dataset.id}/send-internal`,{method:'POST'});alert(`App broadcast complete: ${r.result.sent} sent, ${r.result.skipped} skipped.`);loadMarketing();}catch(e){alert(e.message)}});}
function renderMarketingContacts(items){
  const targets=[$('#marketing-contact-list'),$('#marketing-contact-list-main')].filter(Boolean);const html=items.length?items.map(c=>`<div class="customer-row"><div class="avatar-sm">${initials(c.name)}</div><div><b>${escapeHtml(c.name)}</b><small>${escapeHtml(c.phone)} · ${escapeHtml(c.group)}</small></div><span class="optin ${c.optIn?'':'optout'}">${c.optIn?'OPT-IN':'OPT-OUT'}</span></div>`).join(''):'<p style="padding:10px;color:#6b7280;font-size:13px">No marketing contacts. Add one or load demo data.</p>';targets.forEach(t=>t.innerHTML=html);}
$('#btn-add-contact')?.addEventListener('click',()=>{openModal(`<h3>Add Customer</h3><input id="mc-name" placeholder="Customer name"/><input id="mc-phone" placeholder="Phone e.g. +919876543210"/><input id="mc-group" placeholder="Group e.g. Leads" value="General"/><label style="display:block;font-size:13px;margin:6px 0"><input id="mc-opt" type="checkbox" checked style="width:auto;margin-right:6px"> Customer has opted in</label><button id="mc-save" class="btn-primary">Save Customer</button>`);$('#mc-save').onclick=async()=>{try{await api('/marketing/contacts',{method:'POST',body:JSON.stringify({name:$('#mc-name').value,phone:$('#mc-phone').value,group:$('#mc-group').value,optIn:$('#mc-opt').checked})});closeModal();loadMarketing();}catch(e){alert(e.message)}};});
$('#btn-demo-contacts')?.addEventListener('click',async()=>{const names=['Aarav Sharma','Priya Verma','Rohan Singh','Neha Gupta','Kavya Mehta','Aman Jain','Riya Kapoor','Vikram Joshi','Pooja Saini','Rahul Khan'];const contacts=names.map((name,i)=>({name,phone:`+9198765${String(10000+i).slice(-5)}`,group:i%2?'Customers':'Leads',optIn:true}));try{const r=await api('/marketing/contacts/import',{method:'POST',body:JSON.stringify({contacts})});alert(`Demo data: ${r.added} contacts added, ${r.skipped} skipped.`);loadMarketing();}catch(e){alert(e.message)}});
$('#btn-new-campaign')?.addEventListener('click',async()=>{try{const c=await api('/marketing/contacts');const groups=[...new Set(c.contacts.map(x=>x.group).filter(Boolean))];openModal(`<h3>Create Marketing Campaign</h3><p class="demo-hint">DEMO MODE: this campaign simulates sending and never sends a real WhatsApp message.</p><input id="camp-name" placeholder="Campaign name"/><select id="camp-group" style="width:100%;padding:10px;margin-bottom:12px;border:1px solid #e5e7eb;border-radius:8px"><option>All</option><option value="valid">Valid Members</option><option value="expiring_soon">Expiring Soon</option><option value="expired">Expired Members</option><option value="new">New Members</option>${groups.map(g=>`<option value="${escapeHtml(g)}">Group: ${escapeHtml(g)}</option>`).join('')}</select><textarea id="camp-message" placeholder="Write your marketing message..." rows="6"></textarea><button id="camp-save" class="btn-primary">Create Campaign</button>`);$('#camp-save').onclick=async()=>{try{await api('/marketing/campaigns',{method:'POST',body:JSON.stringify({name:$('#camp-name').value,message:$('#camp-message').value,group:$('#camp-group').value})});closeModal();loadMarketing();}catch(e){alert(e.message)}};}catch(e){alert(e.message)}});
$('#marketing-contact-search')?.addEventListener('input',async e=>{try{const r=await api(`/marketing/contacts?q=${encodeURIComponent(e.target.value)}`);renderMarketingContacts(r.contacts||[]);}catch{}});
// Extend existing tab behaviour without replacing the original chat logic.
const originalTabButtons = $$('.tab-btn');
originalTabButtons.forEach(btn=>btn.addEventListener('click',()=>{
  const marketing=btn.dataset.tab==='marketing';
  const owner=btn.dataset.tab==='owner';
  $('#chat-window')?.classList.toggle('hidden',marketing||owner);
  $('#marketing-window')?.classList.toggle('hidden',!marketing);
  $('#owner-window')?.classList.toggle('hidden',!owner);
  if(marketing){loadMarketing();clearInterval(MARKETING_TIMER);MARKETING_TIMER=setInterval(loadMarketing,1500);} else clearInterval(MARKETING_TIMER);
  if(owner) loadOwnerCenter();
}));

// ===================== OWNER CENTER =====================
async function loadOwnerCenter(){
  if(ME?.role!=='owner') return;
  try{
    const [ov,cs,ss,jr]=await Promise.all([api('/owner/overview'),api('/owner/contacts'),api('/owner/scripts'),api('/owner/ai-calls/jobs')]);
    $('#o-total').textContent=ov.counts.total; $('#o-expired').textContent=ov.counts.expired; $('#o-valid').textContent=ov.counts.valid; $('#o-new').textContent=ov.counts.new; $('#o-queued').textContent=ov.jobs.queued;
    renderOwnerContacts(cs.contacts||[]); renderOwnerScripts(ss.scripts||[]); renderOwnerJobs(jr.jobs||[]);
  }catch(e){alert(e.message);}
}
function renderOwnerContacts(items){
  const list=$('#owner-contact-list'); if(!items.length){list.innerHTML='<p style="padding:12px;color:#6b7280">No imported members yet. Import an Excel sheet.</p>';return;}
  list.innerHTML=items.map(c=>`<label class="list-item" style="cursor:pointer"><input class="owner-contact-check" type="checkbox" value="${c.id}" style="width:auto;margin-right:10px"><div class="avatar-sm">${initials(c.name)}</div><div class="list-item-text"><div class="list-item-name">${escapeHtml(c.name)} <span class="admin-badge">${escapeHtml(c.computedStatus)}</span></div><div class="list-item-sub">${escapeHtml(c.phone)} · ${escapeHtml(c.callingType||'No call type')} ${c.expiryDate?'· Expiry: '+escapeHtml(c.expiryDate):''}</div></div></label>`).join('');
}
function renderOwnerScripts(items){
  const el=$('#owner-script-list'); if(!items.length){el.innerHTML='<p style="color:#6b7280;font-size:13px">No scripts yet. Add scripts for expired, valid and new members.</p>';return;}
  el.innerHTML=items.map(s=>`<div class="campaign-row"><div class="campaign-row-head"><strong>${escapeHtml(s.name)}</strong><span class="campaign-status">${escapeHtml(s.matchStatus)}</span></div><div class="campaign-stats">${escapeHtml(s.script.slice(0,180))}${s.script.length>180?'…':''}</div><button class="btn-secondary owner-queue-script" data-id="${s.id}" style="margin-top:8px">Queue Selected Calls</button></div>`).join('');
  $$('.owner-queue-script').forEach(b=>b.onclick=async()=>{const ids=[...$$('.owner-contact-check:checked')].map(x=>x.value);if(!ids.length)return alert('Select members first.');try{const r=await api('/owner/ai-calls/queue',{method:'POST',body:JSON.stringify({contactIds:ids,scriptId:b.dataset.id})});alert(`${r.queued} AI call jobs queued.`);loadOwnerCenter();}catch(e){alert(e.message)}});
}
function renderOwnerJobs(items){const el=$('#owner-job-list');if(!items.length){el.innerHTML='<p style="color:#6b7280;font-size:13px">No call jobs yet.</p>';return;}el.innerHTML=items.slice(0,50).map(j=>`<div class="campaign-row"><div class="campaign-row-head"><strong>${escapeHtml(j.name)}</strong><span class="campaign-status">${escapeHtml(j.status)}</span></div><div class="campaign-stats">${escapeHtml(j.phone)} · ${escapeHtml(j.provider)}</div></div>`).join('');}
$('#owner-refresh')?.addEventListener('click',loadOwnerCenter);
$('#owner-auto-queue')?.addEventListener('click',async()=>{try{const r=await api('/owner/ai-calls/auto-queue',{method:'POST'});alert(`${r.queued} call jobs queued from enabled status rules.`);loadOwnerCenter();}catch(e){alert(e.message)}});
$('#owner-search')?.addEventListener('input',async e=>{try{const r=await api(`/owner/contacts?q=${encodeURIComponent(e.target.value)}`);renderOwnerContacts(r.contacts||[]);}catch{}});
$('#owner-excel')?.addEventListener('change',async e=>{const file=e.target.files[0];if(!file)return;const form=new FormData();form.append('file',file);try{const r=await api('/owner/import-xlsx',{method:'POST',body:form});alert(`Excel import complete: ${r.added} added, ${r.updated} updated, ${r.skipped} skipped.`);loadOwnerCenter();}catch(err){alert(err.message);}e.target.value='';});
$('#owner-add-script')?.addEventListener('click',()=>{openModal(`<h3>Add AI Call Script</h3><input id="os-name" placeholder="Script name e.g. Expired Member"/><select id="os-status" style="width:100%;padding:10px;margin-bottom:12px;border:1px solid #e5e7eb;border-radius:8px"><option value="expired">Expired</option><option value="valid">Valid</option><option value="new">New</option><option value="unknown">Unknown</option></select><textarea id="os-script" rows="8" placeholder="Write the exact AI call script and instructions..."></textarea><p style="font-size:12px;color:#6b7280;margin:6px 0 12px">This exact text is what the AI will say on the call \u2014 it is sent to Bolna automatically when you save.</p><button id="os-save" class="btn-primary">Save Script</button>`);$('#os-save').onclick=async()=>{try{const r=await api('/owner/scripts',{method:'POST',body:JSON.stringify({name:$('#os-name').value,matchStatus:$('#os-status').value,script:$('#os-script').value})});closeModal();if(r.bolnaSyncError)alert('Script saved, but could not sync to Bolna automatically: '+r.bolnaSyncError+'\n\nYou can add the Bolna Agent ID manually later if needed.');loadOwnerCenter();}catch(e){alert(e.message)}};});

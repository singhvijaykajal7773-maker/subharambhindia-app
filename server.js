require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { Server } = require('socket.io');
const XLSX = require('xlsx');
const db = require('./db');
const { COLUMNS, readWorkbook, normalizePhone: normalizeExcelPhone } = require('./excel-mapping');

function normalizePhone(value) {
  let p = String(value ?? '').trim().replace(/[^0-9+]/g, '');
  if (p.startsWith('+91')) p = p.slice(3);
  else if (p.startsWith('91') && p.length === 12) p = p.slice(2);
  if (p.length === 10) return '+91' + p;
  return p.startsWith('+') ? p : (p ? '+' + p : '');
}
const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET;
const DEMO_MODE = String(process.env.DEMO_MODE ?? 'false').toLowerCase() === 'true';
// DEMO_MODE is allowed for temporary testing deployments. Disable it before real production use.
const OWNER_PHONE = normalizePhone(process.env.OWNER_PHONE || '');
const OWNER_USERNAME = String(process.env.OWNER_USERNAME || '').trim().toLowerCase();
const OWNER_EMAIL = String(process.env.OWNER_EMAIL || '').trim().toLowerCase();
const STATUS_LIFETIME_MS = 24 * 60 * 60 * 1000;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be set to a random string of at least 32 characters.');
  process.exit(1);
}

// ===================== AI VOICE CALLING =====================
// Real interactive AI calling is OFF unless an API key is set. Without one, jobs behave exactly
// like before: they fail with a clear "not configured" message and cost nothing.
// Three providers are supported:
//  - Vapi (recommended if you already have Vapi assistant + phone number set up) -> set VAPI_PRIVATE_KEY
//  - Bolna AI (India-focused, ~Rs 5.5/min, native Hindi/Hinglish)                -> set BOLNA_API_KEY
//  - Bland AI (global, ~Rs 10-12/min, English-first)                            -> set BLAND_API_KEY
// Priority when multiple are set: Vapi > Bolna > Bland. Set AI_CALL_PROVIDER to force one.
const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY || '';
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID || '';
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || '';
const BOLNA_API_KEY = process.env.BOLNA_API_KEY || '';
const BLAND_API_KEY = process.env.BLAND_API_KEY || '';
const BLAND_VOICE_ID = process.env.BLAND_VOICE_ID || 'maya';
const BLAND_LANGUAGE = process.env.BLAND_LANGUAGE || 'hi';
const APP_BASE_URL = (process.env.APP_BASE_URL || process.env.CORS_ORIGIN || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const AI_CALL_PROVIDER = (process.env.AI_CALL_PROVIDER || (VAPI_PRIVATE_KEY ? 'vapi' : (BOLNA_API_KEY ? 'bolna' : (BLAND_API_KEY ? 'bland' : '')))).toLowerCase();
const AI_CALLING_ENABLED = AI_CALL_PROVIDER === 'vapi' ? Boolean(VAPI_PRIVATE_KEY && VAPI_PHONE_NUMBER_ID && VAPI_ASSISTANT_ID) : AI_CALL_PROVIDER === 'bolna' ? Boolean(BOLNA_API_KEY) : AI_CALL_PROVIDER === 'bland' ? Boolean(BLAND_API_KEY) : false;
// ===================== AI MESSAGE GENERATION =====================
// Uses an OpenAI-compatible chat-completions endpoint. Keep the provider key on the server only.
const AI_MESSAGE_API_URL = String(process.env.AI_MESSAGE_API_URL || 'https://api.openai.com/v1/chat/completions').replace(/\/$/, '');
const AI_MESSAGE_API_KEY = process.env.AI_MESSAGE_API_KEY || process.env.OPENAI_API_KEY || '';
const AI_MESSAGE_MODEL = process.env.AI_MESSAGE_MODEL || 'gpt-4o-mini';
const AI_MESSAGE_ENABLED = Boolean(AI_MESSAGE_API_KEY);


const app = express();
const server = http.createServer(app);
const allowedOrigin = process.env.CORS_ORIGIN || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const io = new Server(server, { cors: { origin: allowedOrigin, credentials: true } });

app.disable('x-powered-by');
app.use(cors({ origin: allowedOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  next();
});
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
// Explicit asset routes keep static files working even when a platform rewrite is configured.
app.get('/style.css', (req,res)=>res.sendFile(path.join(PUBLIC_DIR,'style.css')));
app.get('/app.js', (req,res)=>res.sendFile(path.join(PUBLIC_DIR,'app.js')));
app.get('/logo.png', (req,res)=>res.sendFile(path.join(PUBLIC_DIR,'logo.png')));
app.get('/healthz', (req,res)=>res.json({ok:true,service:'subharambhindia',version:'8.0.0'}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { index: false }));
// Do not expose API endpoints until the persistent database has finished loading.
app.use('/api', async (req, res, next) => { try { await db.ready; next(); } catch { res.status(503).json({ error: 'Database is unavailable' }); } });

const otpStore = new Map();
const loginAttempts = new Map();
const requestWindow = new Map();
const RATE_WINDOW = 60_000;
const MAX_LOGIN_ATTEMPTS = 8;
const MAX_AUTH_REQUESTS = 12;
const MAX_OTP_VERIFY_ATTEMPTS = 5;
const OTP_LOCK_MS = 10 * 60_000;

function rateLimit(key, max, windowMs = RATE_WINDOW) {
  const now = Date.now();
  const entry = requestWindow.get(key);
  if (!entry || now - entry.start >= windowMs) {
    requestWindow.set(key, { start: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }
function requireSecureProductionConfig(){
  if (DEMO_MODE) return;
  if (!process.env.NODE_ENV || process.env.NODE_ENV === 'production') {
    if (!process.env.OTP_PROVIDER && !process.env.OTP_WEBHOOK_URL) {
      console.warn('Production OTP provider is not configured. OTP verification will not send SMS automatically.');
    }
  }
}
requireSecureProductionConfig();
function publicUser(u) { if (!u) return null; const { passwordHash, ...rest } = u; return rest; }
function signToken(userId) { return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d', issuer: 'subharambhindia', audience: 'subharambhindia-app' }); }
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: 'subharambhindia', audience: 'subharambhindia-app' });
    const user = db.data.users.find(u => u.id === payload.userId);
    if (!user) return res.status(401).json({ error: 'Invalid session' });
    req.user = user; next();
  } catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}
function requireBodyString(value, field, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return `${field} is invalid`;
  return null;
}
function chatSummary(chat, currentUserId) {
  const msgs = db.data.messages.filter(m => m.chatId === chat.id && !m.deletedFor?.includes(currentUserId));
  const lastMessage = msgs[msgs.length - 1] || null;
  const unreadCount = msgs.filter(m => m.senderId !== currentUserId && !(m.readBy || []).includes(currentUserId)).length;
  let displayName = chat.name, displayAvatar = chat.avatar;
  if (chat.type === 'direct') {
    const otherId = chat.memberIds.find(id => id !== currentUserId);
    const other = db.data.users.find(u => u.id === otherId);
    displayName = other ? other.name : 'Unknown user'; displayAvatar = other ? other.avatar : null;
  }
  return { id: chat.id, type: chat.type, name: displayName, avatar: displayAvatar, description: chat.description, memberIds: chat.memberIds, adminIds: chat.adminIds, lastMessage, unreadCount, createdAt: chat.createdAt };
}
function getOrCreateDirectChat(userId1, userId2) {
  let chat = db.data.chats.find(c => c.type === 'direct' && c.memberIds.length === 2 && c.memberIds.includes(userId1) && c.memberIds.includes(userId2));
  if (!chat) {
    chat = { id: uuidv4(), type: 'direct', memberIds: [userId1, userId2], name: null, description: null, avatar: null, adminIds: [], createdAt: Date.now() };
    db.data.chats.push(chat); db.save(); joinMembersToChatRoom(chat.memberIds, chat.id);
  }
  return chat;
}
function broadcastChatUpdated(chat) { chat.memberIds.forEach(uid => io.to(`user:${uid}`).emit('chat:updated', chatSummary(chat, uid))); }
const onlineUsers = new Map();
function joinMembersToChatRoom(userIds, chatId) {
  userIds.forEach(uid => (onlineUsers.get(uid) || new Set()).forEach(sid => io.sockets.sockets.get(sid)?.join(chatId)));
}

const storage = multer.diskStorage({ destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')), filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).toLowerCase()}`) });
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024, files: 1 }, fileFilter: (req, file, cb) => {
  const allowed = /^(image|video|audio)\//.test(file.mimetype) || ['application/pdf','text/plain'].includes(file.mimetype);
  cb(allowed ? null : new Error('File type not allowed'), allowed);
} });

// AUTH
app.post('/api/auth/request-otp', async (req, res) => {
  if (!rateLimit(`otp:${clientIp(req)}`, MAX_AUTH_REQUESTS)) return res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
  const phone = normalizePhone(req.body.phone);
  if (!/^\+?[0-9]{6,15}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number' });
  if (!DEMO_MODE && !process.env.OTP_WEBHOOK_URL) return res.status(503).json({ error: 'OTP delivery is not configured. Set OTP_WEBHOOK_URL or enable DEMO_MODE only for local testing.' });
  const otp = DEMO_MODE ? '123456' : String(crypto.randomInt(100000, 1000000));
  otpStore.set(phone, { otpHash: require('crypto').createHash('sha256').update(otp).digest('hex'), expires: Date.now() + 5 * 60 * 1000, attempts: 0 });
  if (!DEMO_MODE) {
    try {
      const r = await fetch(process.env.OTP_WEBHOOK_URL, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ phone, otp }) });
      if (!r.ok) throw new Error(`OTP provider returned ${r.status}`);
    } catch (e) { otpStore.delete(phone); return res.status(502).json({ error: 'OTP delivery failed. Please try again.' }); }
  }
  res.json({ message: DEMO_MODE ? 'DEMO MODE: no SMS is sent.' : 'OTP sent', demoOtp: DEMO_MODE ? otp : undefined });
});
app.post('/api/auth/verify-otp', (req, res) => {
  const phone = normalizePhone(req.body.phone), otp = String(req.body.otp || '').trim();
  if (!rateLimit(`otp-verify-ip:${clientIp(req)}`, 20, 10 * 60_000) || !rateLimit(`otp-verify-phone:${phone}`, MAX_OTP_VERIFY_ATTEMPTS, 10 * 60_000)) return res.status(429).json({ error: 'Too many OTP attempts. Please request a new OTP later.' });
  const entry = otpStore.get(phone);
  if (!entry) return res.status(400).json({ error: 'Invalid or expired OTP' });
  if (entry.lockedUntil && entry.lockedUntil > Date.now()) return res.status(429).json({ error: 'OTP temporarily locked. Please request a new OTP later.' });
  if (entry.expires < Date.now()) { otpStore.delete(phone); return res.status(400).json({ error: 'Invalid or expired OTP' }); }
  const otpHash = require('crypto').createHash('sha256').update(otp).digest('hex');
  if (entry.otpHash !== otpHash) {
    entry.attempts = (entry.attempts || 0) + 1;
    if (entry.attempts >= MAX_OTP_VERIFY_ATTEMPTS) entry.lockedUntil = Date.now() + OTP_LOCK_MS;
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  otpStore.delete(phone);
  const existingUser = db.data.users.find(u => u.phone === phone);
  if (existingUser) { if (isConfiguredOwner(existingUser)) { existingUser.role='owner'; if(!existingUser.email && OWNER_USERNAME && String(existingUser.username||'').toLowerCase()===OWNER_USERNAME) existingUser.email=OWNER_EMAIL||null; } if(!existingUser.permissions) existingUser.permissions={}; db.save(); return res.json({ status: 'login', token: signToken(existingUser.id), user: publicUser(existingUser) }); }
  // Stateless registration token: survives app restarts/redeploys as long as JWT_SECRET is unchanged.
  const tempToken = jwt.sign({ purpose: 'registration', phone }, JWT_SECRET, { expiresIn: '2h', issuer: 'subharambhindia', audience: 'subharambhindia-registration' });
  res.json({ status: 'new_user', tempToken });
});
app.post('/api/auth/complete-profile', async (req, res) => {
  const { tempToken, name, username, password } = req.body;
  let entry;
  try {
    const payload = jwt.verify(String(tempToken || ''), JWT_SECRET, { issuer: 'subharambhindia', audience: 'subharambhindia-registration' });
    if (payload.purpose !== 'registration' || !payload.phone) throw new Error('Invalid registration token');
    entry = { phone: normalizePhone(payload.phone) };
  } catch {
    return res.status(400).json({ error: 'Registration session expired. Please verify your mobile number again.' });
  }
  if ([['name',name,80],['username',username,30],['password',password,128]].some(([f,v,m]) => requireBodyString(v,f,m))) return res.status(400).json({ error: 'Please enter valid profile details' });
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-30 letters/numbers/._-' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.data.users.find(u => u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'Username already taken' });
  const user = { id: uuidv4(), name: name.trim(), username, email: (OWNER_USERNAME && String(username).trim().toLowerCase()===OWNER_USERNAME ? (OWNER_EMAIL||null) : null), phone: entry.phone, passwordHash: await bcrypt.hash(password, 12), about: 'Available', avatar: null, privacy: { lastSeen:'everyone', online:'everyone', profilePhoto:'everyone', status:'everyone', readReceipts:true }, blockedUserIds:[], createdAt:Date.now(), lastSeen:Date.now(), role: ((OWNER_PHONE && normalizePhone(entry.phone) === OWNER_PHONE) || (OWNER_USERNAME && String(username).trim().toLowerCase() === OWNER_USERNAME)) ? 'owner' : 'user', permissions: {} };
  db.data.users.push(user); db.save();
  res.json({ token: signToken(user.id), user: publicUser(user) });
});
app.post('/api/auth/login-password', async (req, res) => {
  const ip = clientIp(req), key = `login:${ip}`;
  if (!rateLimit(key, MAX_LOGIN_ATTEMPTS)) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  const { username, password } = req.body;
  const loginId = String(username || '').trim();
  const normalizedLoginPhone = normalizePhone(loginId);
  const user = db.data.users.find(u => u.username === loginId || normalizePhone(u.phone) === normalizedLoginPhone);
  if (!user || !(await bcrypt.compare(String(password || ''), user.passwordHash))) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: signToken(user.id), user: publicUser(user) });
});
app.get('/api/auth/me', authMiddleware, (req,res)=>res.json({user:publicUser(req.user)}));

// USERS / CONTACTS
app.get('/api/users', authMiddleware, (req,res)=>{
  const q=String(req.query.q||'').toLowerCase().slice(0,80);
  const users=db.data.users.filter(u=>u.id!==req.user.id).filter(u=>!q||u.name.toLowerCase().includes(q)||u.username.toLowerCase().includes(q)||u.phone.includes(q)).map(publicUser);
  res.json({users});
});
app.patch('/api/users/me', authMiddleware, (req,res)=>{ const {name,about,avatar,privacy}=req.body; if(name!==undefined&&requireBodyString(name,'name',80)) return res.status(400).json({error:'Invalid name'}); if(name) req.user.name=name.trim(); if(about!==undefined) req.user.about=String(about).slice(0,300); if(avatar!==undefined) req.user.avatar=avatar; if(privacy) req.user.privacy={...req.user.privacy,...privacy}; db.save(); res.json({user:publicUser(req.user)}); });
app.post('/api/users/me/avatar', authMiddleware, (req,res,next)=>upload.single('file')(req,res,err=>{ if(err) return res.status(400).json({error:err.message}); if(!req.file || !req.file.mimetype.startsWith('image/')) return res.status(400).json({error:'Please select an image'}); req.user.avatar=`/uploads/${req.file.filename}`; db.save(); res.json({user:publicUser(req.user), avatar:req.user.avatar}); }));
app.post('/api/users/block/:userId',authMiddleware,(req,res)=>{if(!db.data.users.some(u=>u.id===req.params.userId))return res.status(404).json({error:'User not found'});if(!req.user.blockedUserIds.includes(req.params.userId))req.user.blockedUserIds.push(req.params.userId);db.save();res.json({blockedUserIds:req.user.blockedUserIds});});
app.post('/api/users/unblock/:userId',authMiddleware,(req,res)=>{req.user.blockedUserIds=req.user.blockedUserIds.filter(id=>id!==req.params.userId);db.save();res.json({blockedUserIds:req.user.blockedUserIds});});

// CHATS
app.get('/api/chats',authMiddleware,(req,res)=>res.json({chats:db.data.chats.filter(c=>c.memberIds.includes(req.user.id)).map(c=>chatSummary(c,req.user.id)).sort((a,b)=>(b.lastMessage?.createdAt||b.createdAt)-(a.lastMessage?.createdAt||a.createdAt))}));
app.post('/api/chats/direct',authMiddleware,(req,res)=>{const other=db.data.users.find(u=>u.id===req.body.otherUserId);if(!other)return res.status(404).json({error:'User not found'});if(req.user.blockedUserIds.includes(other.id)||other.blockedUserIds.includes(req.user.id))return res.status(403).json({error:'Messaging is blocked'});const chat=getOrCreateDirectChat(req.user.id,other.id);res.json({chat:chatSummary(chat,req.user.id)});});
app.post('/api/chats/group',authMiddleware,(req,res)=>{const name=String(req.body.name||'').trim();if(!name||name.length>80)return res.status(400).json({error:'Group name is required'});const requested=Array.isArray(req.body.memberIds)?req.body.memberIds:[];const valid=requested.filter(id=>db.data.users.some(u=>u.id===id));const allMembers=Array.from(new Set([req.user.id,...valid]));const chat={id:uuidv4(),type:'group',name,description:String(req.body.description||'').slice(0,300),avatar:null,memberIds:allMembers,adminIds:[req.user.id],permissions:{onlyAdminsCanMessage:false,onlyAdminsCanEditInfo:true,onlyAdminsCanAddMembers:true},createdAt:Date.now()};db.data.chats.push(chat);db.save();joinMembersToChatRoom(allMembers,chat.id);allMembers.forEach(uid=>io.to(`user:${uid}`).emit('chat:new',chatSummary(chat,uid)));res.json({chat:chatSummary(chat,req.user.id)});});
app.get('/api/chats/:chatId',authMiddleware,(req,res)=>{const chat=db.data.chats.find(c=>c.id===req.params.chatId);if(!chat||!chat.memberIds.includes(req.user.id))return res.status(404).json({error:'Chat not found'});res.json({chat:{...chatSummary(chat,req.user.id),members:chat.memberIds.map(id=>publicUser(db.data.users.find(u=>u.id===id))).filter(Boolean)}});});
app.patch('/api/chats/:chatId',authMiddleware,(req,res)=>{const chat=db.data.chats.find(c=>c.id===req.params.chatId);if(!chat||!chat.memberIds.includes(req.user.id))return res.status(404).json({error:'Chat not found'});if(chat.type==='group'&&chat.permissions?.onlyAdminsCanEditInfo&&!chat.adminIds.includes(req.user.id))return res.status(403).json({error:'Only admins can edit group info'});if(req.body.name)chat.name=String(req.body.name).trim().slice(0,80);if(req.body.description!==undefined)chat.description=String(req.body.description).slice(0,300);if(req.body.avatar!==undefined)chat.avatar=req.body.avatar;db.save();broadcastChatUpdated(chat);res.json({chat:chatSummary(chat,req.user.id)});});
app.post('/api/chats/:chatId/members',authMiddleware,(req,res)=>{const chat=db.data.chats.find(c=>c.id===req.params.chatId);if(!chat||chat.type!=='group'||!chat.memberIds.includes(req.user.id))return res.status(404).json({error:'Group not found'});if(chat.permissions?.onlyAdminsCanAddMembers&&!chat.adminIds.includes(req.user.id))return res.status(403).json({error:'Only admins can add members'});const ids=Array.isArray(req.body.userIds)?req.body.userIds:[];ids.filter(id=>db.data.users.some(u=>u.id===id)).forEach(id=>{if(!chat.memberIds.includes(id))chat.memberIds.push(id);});db.save();joinMembersToChatRoom(chat.memberIds,chat.id);broadcastChatUpdated(chat);res.json({chat:chatSummary(chat,req.user.id)});});
app.delete('/api/chats/:chatId/members/:userId',authMiddleware,(req,res)=>{const chat=db.data.chats.find(c=>c.id===req.params.chatId);if(!chat||chat.type!=='group')return res.status(404).json({error:'Group not found'});const isSelf=req.params.userId===req.user.id;if(!isSelf&&!chat.adminIds.includes(req.user.id))return res.status(403).json({error:'Only admins can remove members'});if(isSelf&&chat.adminIds.includes(req.user.id)&&chat.adminIds.length===1&&chat.memberIds.length>1)return res.status(400).json({error:'You are the only admin. Make another member an admin before leaving.'});chat.memberIds=chat.memberIds.filter(id=>id!==req.params.userId);chat.adminIds=chat.adminIds.filter(id=>id!==req.params.userId);db.save();io.to(`user:${req.params.userId}`).emit('chat:removed',{chatId:chat.id});broadcastChatUpdated(chat);res.json({chat:chatSummary(chat,req.user.id)});});
app.post('/api/chats/:chatId/admins/:userId',authMiddleware,(req,res)=>{const chat=db.data.chats.find(c=>c.id===req.params.chatId);if(!chat||chat.type!=='group'||!chat.adminIds.includes(req.user.id)||!chat.memberIds.includes(req.params.userId))return res.status(403).json({error:'Only admins can promote members'});if(!chat.adminIds.includes(req.params.userId))chat.adminIds.push(req.params.userId);db.save();res.json({chat:chatSummary(chat,req.user.id)});});

// MESSAGES
app.get('/api/chats/:chatId/messages',authMiddleware,(req,res)=>{const chat=db.data.chats.find(c=>c.id===req.params.chatId);if(!chat||!chat.memberIds.includes(req.user.id))return res.status(404).json({error:'Chat not found'});let limit=Math.min(Math.max(parseInt(req.query.limit||'50',10)||50,1),100);const before=req.query.before?parseInt(req.query.before,10):Date.now()+1;const msgs=db.data.messages.filter(m=>m.chatId===chat.id&&m.createdAt<before&&!(m.deletedFor||[]).includes(req.user.id)).sort((a,b)=>b.createdAt-a.createdAt).slice(0,limit).reverse();res.json({messages:msgs});});
app.post('/api/upload',authMiddleware,(req,res,next)=>upload.single('file')(req,res,err=>{if(err)return res.status(400).json({error:err.message});if(!req.file)return res.status(400).json({error:'No file uploaded'});const mediaType=req.file.mimetype.startsWith('image')?'image':req.file.mimetype.startsWith('video')?'video':req.file.mimetype.startsWith('audio')?'audio':'document';res.json({url:`/uploads/${req.file.filename}`,mediaType,originalName:req.file.originalname,size:req.file.size});}));

// STATUS
app.get('/api/status',authMiddleware,(req,res)=>{const cutoff=Date.now()-STATUS_LIFETIME_MS;const active=db.data.statuses.filter(s=>s.createdAt>cutoff);const byUser={};active.forEach(s=>(byUser[s.userId]??=[]).push(s));const feed=Object.entries(byUser).map(([userId,statuses])=>({user:publicUser(db.data.users.find(u=>u.id===userId)),statuses}));res.json({statuses:feed,statusFeed:feed});});
app.post('/api/status',authMiddleware,(req,res)=>{const {type='text',content='',mediaUrl=null}=req.body;if(type!=='text'&&!mediaUrl)return res.status(400).json({error:'Status content required'});const s={id:uuidv4(),userId:req.user.id,type,content:String(content).slice(0,1000),mediaUrl,createdAt:Date.now(),viewers:[]};db.data.statuses.push(s);db.save();io.emit('status:new',s);res.json({status:s});});
app.post('/api/status/:id/view',authMiddleware,(req,res)=>{const s=db.data.statuses.find(x=>x.id===req.params.id);if(!s)return res.status(404).json({error:'Status not found'});if(!s.viewers.includes(req.user.id))s.viewers.push(req.user.id);db.save();res.json({ok:true});});
app.delete('/api/status/:id',authMiddleware,(req,res)=>{const s=db.data.statuses.find(x=>x.id===req.params.id);if(!s||s.userId!==req.user.id)return res.status(404).json({error:'Status not found'});db.data.statuses=db.data.statuses.filter(x=>x.id!==req.params.id);db.save();res.json({ok:true});});

// MARKETING / CRM DEMO
function marketingData(){ if(!Array.isArray(db.data.marketingContacts)) db.data.marketingContacts=[]; if(!Array.isArray(db.data.campaigns)) db.data.campaigns=[]; if(!Array.isArray(db.data.auditLogs)) db.data.auditLogs=[]; if(!Array.isArray(db.data.events)) db.data.events=[]; if(!Array.isArray(db.data.messageTemplates)) db.data.messageTemplates=[]; }
function audit(userId,action,meta={}){marketingData();db.data.auditLogs.push({id:uuidv4(),userId,action,meta,createdAt:Date.now()});if(db.data.auditLogs.length>1000)db.data.auditLogs.shift();db.save();}
app.get('/api/marketing/dashboard',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{marketingData();const mine=db.data.marketingContacts.filter(c=>c.ownerId===businessOwnerId(req.user));const campaigns=db.data.campaigns.filter(c=>c.ownerId===businessOwnerId(req.user));res.json({contacts:mine.length,groups:new Set(mine.map(c=>c.group).filter(Boolean)).size,campaigns:campaigns.length,sent:campaigns.reduce((n,c)=>n+(c.stats?.sent||0),0),delivered:campaigns.reduce((n,c)=>n+(c.stats?.delivered||0),0),read:campaigns.reduce((n,c)=>n+(c.stats?.read||0),0),replies:campaigns.reduce((n,c)=>n+(c.stats?.replies||0),0)});});
app.get('/api/marketing/contacts',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{marketingData();const q=String(req.query.q||'').toLowerCase();res.json({contacts:db.data.marketingContacts.filter(c=>c.ownerId===businessOwnerId(req.user)).filter(c=>!q||c.name.toLowerCase().includes(q)||c.phone.includes(q)).slice(0,500)});});
app.post('/api/marketing/contacts',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{marketingData();const name=String(req.body.name||'').trim(),phone=normalizePhone(req.body.phone);if(!name||name.length>80||!/^[+0-9][0-9]{5,15}$/.test(phone))return res.status(400).json({error:'Enter valid name and phone'});if(db.data.marketingContacts.some(c=>c.ownerId===businessOwnerId(req.user)&&c.phone===phone))return res.status(409).json({error:'Contact already exists'});const c={id:uuidv4(),ownerId:businessOwnerId(req.user),name,phone,group:String(req.body.group||'General').slice(0,50),optIn:req.body.optIn!==false,callingConsent:req.body.callingConsent===true,createdAt:Date.now()};db.data.marketingContacts.push(c);audit(req.user.id,'contact.created',{contactId:c.id});res.json({contact:c});});
app.post('/api/marketing/contacts/import',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{marketingData();const rows=Array.isArray(req.body.contacts)?req.body.contacts:[];if(rows.length>5000)return res.status(400).json({error:'Demo import limit is 5,000 rows per request'});let added=0,skipped=0;for(const r of rows){const name=String(r.name||'').trim(),phone=normalizePhone(r.phone);if(!name||!/^[+0-9][0-9]{5,15}$/.test(phone)||db.data.marketingContacts.some(c=>c.ownerId===businessOwnerId(req.user)&&c.phone===phone)){skipped++;continue;}db.data.marketingContacts.push({id:uuidv4(),ownerId:businessOwnerId(req.user),name,phone,group:String(r.group||'General').slice(0,50),optIn:r.optIn!==false,callingConsent:r.callingConsent===true,createdAt:Date.now()});added++;}audit(req.user.id,'contacts.imported',{added,skipped});res.json({added,skipped});});
app.get('/api/marketing/campaigns',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{marketingData();res.json({campaigns:db.data.campaigns.filter(c=>c.ownerId===businessOwnerId(req.user)).sort((a,b)=>b.createdAt-a.createdAt)});});
app.post('/api/marketing/campaigns',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{
  marketingData(); const ownerId=businessOwnerId(req.user); const name=String(req.body.name||'').trim(),message=String(req.body.message||'').trim();
  const templateId=String(req.body.templateId||'').trim()||null; const template=templateId?db.data.messageTemplates.find(t=>t.id===templateId&&t.ownerId===ownerId&&t.enabled):null;
  if(!name||name.length>100||(!message&&!template))return res.status(400).json({error:'Campaign name and a message/template are required'});
  const eventId=String(req.body.eventId||'').trim()||null; const event=eventId?db.data.events.find(e=>e.id===eventId&&e.ownerId===ownerId):null; if(eventId&&!event)return res.status(400).json({error:'Selected event not found'});
  const filters=typeof req.body.filters==='object'&&req.body.filters?req.body.filters:{};
  const contactIds=Array.isArray(req.body.contactIds)?req.body.contactIds.map(String).slice(0,10000):[];
  const c={id:uuidv4(),ownerId,name,message:message.slice(0,10000),templateId,eventId,filters,contactIds,mediaUrl:String(req.body.mediaUrl||'').trim().slice(0,2048)||null,mediaType:String(req.body.mediaType||'').slice(0,50)||null,scheduledAt:req.body.scheduledAt?String(req.body.scheduledAt):null,mode:'IN_APP',status:'draft',createdAt:Date.now(),stats:{total:campaignContacts({ownerId,filters,contactIds}).length,queued:0,sent:0,delivered:0,read:0,failed:0,replies:0,skipped:0}};
  db.data.campaigns.push(c);audit(req.user.id,'campaign.created',{campaignId:c.id});res.json({campaign:c});
});
app.post('/api/marketing/campaigns/:id/start',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{
  marketingData(); const c=db.data.campaigns.find(x=>x.id===req.params.id&&x.ownerId===businessOwnerId(req.user)); if(!c)return res.status(404).json({error:'Campaign not found'});
  if(c.eventId){const ev=db.data.events.find(e=>e.id===c.eventId);if(!ev||['completed','cancelled','archived'].includes(ev.status))return res.status(409).json({error:'This event is no longer active. Create or select a current event.'});}
  if(c.status==='completed')return res.status(409).json({error:'Campaign already completed'});
  try{const result=dispatchInternalCampaign(c);res.json({campaign:c,result});}catch(e){res.status(409).json({error:e.message});}
});
app.post('/api/marketing/campaigns/:id/pause',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{marketingData();const c=db.data.campaigns.find(x=>x.id===req.params.id&&x.ownerId===businessOwnerId(req.user));if(!c)return res.status(404).json({error:'Campaign not found'});if(c.status==='running'||c.status==='scheduled')c.status='paused';db.save();audit(req.user.id,'campaign.paused',{campaignId:c.id});res.json({campaign:c});});
app.post('/api/marketing/campaigns/:id/cancel',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{marketingData();const c=db.data.campaigns.find(x=>x.id===req.params.id&&x.ownerId===businessOwnerId(req.user));if(!c)return res.status(404).json({error:'Campaign not found'});if(c.status==='completed')return res.status(409).json({error:'Completed campaigns cannot be cancelled'});c.status='cancelled';c.updatedAt=Date.now();db.save();audit(req.user.id,'campaign.cancelled',{campaignId:c.id});res.json({campaign:c});});
// Lightweight scheduler: scheduled in-app campaigns are dispatched once their time arrives.
setInterval(()=>{
  try{
    marketingData(); const now=Date.now();
    for(const c of db.data.campaigns.filter(x=>x.status==='draft'&&x.scheduledAt&&new Date(x.scheduledAt).getTime()<=now)){
      try{dispatchInternalCampaign(c);}catch(e){c.status='failed';c.error=e.message;c.updatedAt=Date.now();db.save();}
    }
  }catch(e){console.error('In-app campaign scheduler error:',e.message);}
},30000);

app.get('/api/security/audit',authMiddleware,(req,res)=>{marketingData();res.json({logs:db.data.auditLogs.filter(x=>x.userId===req.user.id).slice(-100).reverse()});});


// ===================== OWNER / AI CALLING CONTROL CENTER =====================
function isConfiguredOwner(user){
  if(!user) return false;
  const byRole = user.role === 'owner';
  const byPhone = OWNER_PHONE && normalizePhone(user.phone) === OWNER_PHONE;
  const byUsername = OWNER_USERNAME && String(user.username||'').trim().toLowerCase() === OWNER_USERNAME;
  const byEmail = OWNER_EMAIL && String(user.email||'').trim().toLowerCase() === OWNER_EMAIL;
  return Boolean(byRole || byPhone || byUsername || byEmail);
}
function isOwner(req){ return isConfiguredOwner(req.user); }
function requireOwner(req,res,next){ if(!isOwner(req)) return res.status(403).json({error:'Owner access required'}); next(); }
const DEFAULT_ROLE_PERMISSIONS = {
  owner: { dashboard:true, members:true, campaigns:true, aiCalling:true, users:true, activity:true },
  admin: { dashboard:true, members:true, campaigns:true, aiCalling:true, users:false, activity:true },
  manager: { dashboard:true, members:true, campaigns:true, aiCalling:false, users:false, activity:false },
  user: { dashboard:false, members:false, campaigns:false, aiCalling:false, users:false, activity:false }
};
function hasBusinessPermission(user, key){
  if(isConfiguredOwner(user)) return true;
  const base = DEFAULT_ROLE_PERMISSIONS[String(user?.role||'user')] || DEFAULT_ROLE_PERMISSIONS.user;
  if(user?.permissions && Object.prototype.hasOwnProperty.call(user.permissions,key)) return user.permissions[key] === true;
  return base[key] === true;
}
function requireBusinessPermission(key){
  return (req,res,next)=>{
    if(!hasBusinessPermission(req.user,key)) return res.status(403).json({error:`Permission required: ${key}`});
    next();
  };
}
function businessOwnerId(user){
  if(isConfiguredOwner(user)) return user.id;
  const owner=db.data.users.find(u=>isConfiguredOwner(u)) || db.data.users.find(u=>u.role==='owner');
  return owner ? owner.id : user.id;
}

function ensureAutomationData(){
  if(!Array.isArray(db.data.aiCallScripts)) db.data.aiCallScripts=[];
  if(!Array.isArray(db.data.aiCallJobs)) db.data.aiCallJobs=[];
  if(!Array.isArray(db.data.marketingContacts)) db.data.marketingContacts=[];
  if(!Array.isArray(db.data.aiCallCampaigns)) db.data.aiCallCampaigns=[];
  if(!Array.isArray(db.data.events)) db.data.events=[];
  if(!Array.isArray(db.data.messageTemplates)) db.data.messageTemplates=[];
}
function classifyContact(c){
  const raw=String(c.status||'').trim().toLowerCase().replace(/[- ]/g,'_');
  if(raw.includes('expired')) return 'expired';
  if(raw.includes('valid')) return 'valid';
  if(raw.includes('new')) return 'new';
  if(raw.includes('expiring')) return 'expiring_soon';
  if(c.expiryDate){
    const value=String(c.expiryDate).trim();
    const d=/^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:59`) : new Date(value);
    if(!Number.isNaN(d.getTime())){
      const now=new Date();
      const todayEnd=new Date(now.getFullYear(),now.getMonth(),now.getDate(),23,59,59,999);
      if(d.getTime()<todayEnd.getTime()) return 'expired';
      const days=(d.getTime()-todayEnd.getTime())/86400000;
      if(days<=7) return 'expiring_soon';
      return 'valid';
    }
  }
  return raw ? raw : 'unknown';
}
app.get('/api/owner/overview',authMiddleware,requireOwner,(req,res)=>{
  ensureAutomationData();
  const contacts=db.data.marketingContacts;
  const counts={total:contacts.length,expired:0,valid:0,new:0,unknown:0};
  contacts.forEach(c=>counts[classifyContact(c)]++);
  const jobs=db.data.aiCallJobs;
  res.json({role:req.user.role||'owner',counts,scripts:db.data.aiCallScripts.length,jobs:{total:jobs.length,queued:jobs.filter(j=>j.status==='queued').length,completed:jobs.filter(j=>j.status==='completed').length,failed:jobs.filter(j=>j.status==='failed').length}});
});
app.get('/api/owner/contacts',authMiddleware,requireBusinessPermission('members'),(req,res)=>{
  ensureAutomationData();
  const ownerId=businessOwnerId(req.user), q=String(req.query.q||'').toLowerCase().slice(0,80), status=String(req.query.status||'all').toLowerCase();
  let contacts=db.data.marketingContacts.filter(c=>c.ownerId===ownerId);
  if(q) contacts=contacts.filter(c=>Object.values({name:c.name,phone:c.phone,memberId:c.memberId,salonName:c.salonName,city:c.city,category:c.category,email:c.email,instagram:c.instagram}).some(v=>String(v||'').toLowerCase().includes(q)));
  if(status!=='all') contacts=contacts.filter(c=>classifyContact(c)===status);
  const page=Math.max(1,parseInt(req.query.page||1,10)||1), pageSize=Math.min(100,Math.max(10,parseInt(req.query.pageSize||50,10)||50));
  const total=contacts.length, startIndex=(page-1)*pageSize;
  res.json({contacts:contacts.slice(startIndex,startIndex+pageSize).map(c=>({...c,computedStatus:classifyContact(c)})),page,pageSize,total,totalPages:Math.ceil(total/pageSize)});
});
app.patch('/api/owner/contacts/:id',authMiddleware,requireBusinessPermission('members'),(req,res)=>{
  ensureAutomationData();
  const ownerId=businessOwnerId(req.user);
  const c=db.data.marketingContacts.find(x=>x.id===req.params.id&&x.ownerId===ownerId);
  if(!c)return res.status(404).json({error:'Member not found'});
  const fields=['name','phone','phone2','memberId','status','renewalTime','dob','salonName','joiningDate','internalCode','payment','paymentCode','paymentStatus','category','city','reference','closeBy','serviceManager','address','pinCode','area','email','experience','graphics','reelDone','logo','visitingCard','instagram','expiryDate','contentType','callingType','callingConsent','optIn','notes'];
  for(const k of fields) if(req.body[k]!==undefined){
    if(['callingConsent','optIn'].includes(k)) c[k]=!!req.body[k];
    else if(k==='phone'||k==='phone2') c[k]=normalizePhone(req.body[k]);
    else if(k==='name' && !String(req.body[k]).trim()) return res.status(400).json({error:'Name cannot be empty'});
    else c[k]=typeof req.body[k]==='string'?String(req.body[k]).slice(0,k==='notes'?500:5000):req.body[k];
  }
  if(req.body.rawData && typeof req.body.rawData==='object') c.rawData={...(c.rawData||{}),...req.body.rawData};
  if(!c.name || (!c.phone && !c.memberId)) return res.status(400).json({error:'Name and phone or member ID are required'});
  c.updatedAt=Date.now(); db.save(); audit(req.user.id,'contact.updated',{contactId:c.id});
  res.json({contact:{...c,computedStatus:classifyContact(c)}});
});
app.post('/api/owner/import-xlsx',authMiddleware,requireBusinessPermission('members'),(req,res,next)=>{
  ensureAutomationData();
  uploadExcel.single('file')(req,res,err=>{
    if(err) return res.status(400).json({error:err.message});
    try{
      if(!req.file) return res.status(400).json({error:'Select an Excel file'});
      const {sheetName,rows}=readWorkbook(req.file.path);
      if(rows.length>10000) return res.status(400).json({error:'Maximum 10,000 rows per import'});
      const ownerId=businessOwnerId(req.user);
      let added=0,updated=0,skipped=0;
      const seen=new Set();
      for(const row of rows){
        const name=String(row.name||'').trim();
        const phone=normalizeExcelPhone(row.phone||'');
        const memberId=String(row.memberId||'').trim();
        if(!name || (!phone && !memberId)){ skipped++; continue; }
        const key=memberId ? `id:${memberId.toLowerCase()}` : `phone:${phone}`;
        if(seen.has(key)){ skipped++; continue; }
        seen.add(key);
        let existing=db.data.marketingContacts.find(c=>c.ownerId===ownerId && ((memberId && c.memberId===memberId) || (!memberId && phone && c.phone===phone)));
        const preservedExpiry=existing?.expiryDate || null;
        const preservedConsent=existing?.optIn;
        const preservedCalling=existing?.callingConsent;
        const record={
          ...(existing||{}), id:existing?.id||uuidv4(), ownerId, ...row, phone, memberId,
          expiryDate:preservedExpiry,
          optIn:preservedConsent===undefined ? true : preservedConsent,
          callingConsent:preservedCalling===undefined ? false : preservedCalling,
          createdAt:existing?.createdAt||Date.now(), updatedAt:Date.now()
        };
        // Do not let an empty import overwrite a manually edited expiry date.
        if(existing) Object.assign(existing,record); else db.data.marketingContacts.push(record);
        existing ? updated++ : added++;
      }
      db.save(); audit(req.user.id,'contacts.xlsx_imported',{added,updated,skipped,rows:rows.length,sheetName,columns:COLUMNS.length});
      res.json({added,updated,skipped,totalRows:rows.length,sheetName,columns:COLUMNS});
    }catch(e){console.error(e);res.status(400).json({error:'Could not read Excel file: '+String(e.message||e)});}
    finally{ try{ if(req.file?.path) require('fs').unlinkSync(req.file.path); }catch{} }
  });
});
app.get('/api/owner/contacts/export.xlsx',authMiddleware,requireBusinessPermission('members'),(req,res)=>{
  ensureAutomationData();
  const ownerId=businessOwnerId(req.user);
  const contacts=db.data.marketingContacts.filter(c=>c.ownerId===ownerId);
  const rows=contacts.map(c=>{
    const raw={...(c.rawData||{})};
    const values={...raw};
    values['Exp/Active']=c.status || raw['Exp/Active'] || '';
    values['Renuwal Time']=c.renewalTime ?? raw['Renuwal Time'] ?? '';
    values['NAME']=c.name||'';
    values['☎♦⪼Contact 1⪻♦']=c.phone||'';
    values['☎♦⪼Contact 2⪻♦']=c.phone2||'';
    values['ID Number']=c.memberId||'';
    values['Joining Date']=c.joiningDate||'';
    values['Payment Status']=c.paymentStatus||'';
    values['Catgory(Salon name)']=c.category||'';
    values['City']=c.city||''; values['Address']=c.address||''; values['Pin Code']=c.pinCode||''; values['Area']=c.area||'';
    values['Email addresss']=c.email||''; values['EXP.']=c.experience||''; values["Insta id"]=c.instagram||'';
    return values;
  });
  const ws=XLSX.utils.json_to_sheet(rows,{header:COLUMNS});
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'Import Data');
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="SubhArambh-Members-Export.xlsx"');
  res.send(buf);
});
// MESSAGE TEMPLATE LIBRARY
app.get('/api/owner/message-templates',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{
  marketingData(); const ownerId=businessOwnerId(req.user);
  res.json({templates:db.data.messageTemplates.filter(t=>t.ownerId===ownerId).sort((a,b)=>b.updatedAt-a.updatedAt)});
});
app.post('/api/owner/message-templates',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{
  marketingData(); const name=String(req.body.name||'').trim(), body=String(req.body.body||'').trim();
  if(!name||!body)return res.status(400).json({error:'Template name and message are required'});
  const t={id:uuidv4(),ownerId:businessOwnerId(req.user),name:name.slice(0,100),body:body.slice(0,10000),mediaUrl:String(req.body.mediaUrl||'').trim().slice(0,2048)||null,mediaType:String(req.body.mediaType||'').slice(0,50)||null,enabled:req.body.enabled!==false,createdAt:Date.now(),updatedAt:Date.now()};
  db.data.messageTemplates.push(t);db.save();audit(req.user.id,'message_template.created',{templateId:t.id});res.json({template:t});
});
app.patch('/api/owner/message-templates/:id',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{
  marketingData(); const t=db.data.messageTemplates.find(x=>x.id===req.params.id&&x.ownerId===businessOwnerId(req.user));
  if(!t)return res.status(404).json({error:'Template not found'});
  if(req.body.name!==undefined)t.name=String(req.body.name).trim().slice(0,100);
  if(req.body.body!==undefined)t.body=String(req.body.body).slice(0,10000);
  if(req.body.mediaUrl!==undefined)t.mediaUrl=String(req.body.mediaUrl||'').trim().slice(0,2048)||null;
  if(req.body.mediaType!==undefined)t.mediaType=String(req.body.mediaType||'').slice(0,50)||null;
  if(req.body.enabled!==undefined)t.enabled=!!req.body.enabled;
  t.updatedAt=Date.now();db.save();audit(req.user.id,'message_template.updated',{templateId:t.id});res.json({template:t});
});
app.delete('/api/owner/message-templates/:id',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{
  marketingData(); const i=db.data.messageTemplates.findIndex(x=>x.id===req.params.id&&x.ownerId===businessOwnerId(req.user));
  if(i<0)return res.status(404).json({error:'Template not found'});
  db.data.messageTemplates.splice(i,1);db.save();audit(req.user.id,'message_template.deleted',{templateId:req.params.id});res.json({ok:true});
});


// ===================== AI MESSAGING =====================
function ensureAiMessageData(){ if(!Array.isArray(db.data.aiMessageDrafts)) db.data.aiMessageDrafts=[]; }
function aiMessageOwner(req){ return businessOwnerId(req.user); }
function safeEventForAI(event){ return event ? {name:event.name,type:event.type,artist:event.artist,topic:event.topic,date:event.date,time:event.time,location:event.location,zoomLink:event.zoomLink||'',mediaUrl:event.mediaUrl||'',status:event.status} : null; }
async function generateAIMessage({instruction,event,template,language='Hindi'}){
  if(!AI_MESSAGE_ENABLED) throw new Error('AI messaging is not configured. Set AI_MESSAGE_API_KEY (or OPENAI_API_KEY) on the server.');
  const system = `You write concise, respectful business messages for registered app users. Language: ${language}. Never invent dates, prices, artists, locations, offers or policies. Use only supplied facts. Do not mention that you are an AI. Return only the final message text.`;
  const user = JSON.stringify({instruction: String(instruction||'').slice(0,3000), event:safeEventForAI(event), template: template?String(template.body||'').slice(0,6000):null, allowedVariables:['{name}','{artist}','{topic}','{event}','{class_name}','{date}','{time}','{location}','{zoom_link}']});
  const r=await fetch(AI_MESSAGE_API_URL,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${AI_MESSAGE_API_KEY}`},body:JSON.stringify({model:AI_MESSAGE_MODEL,temperature:0.4,messages:[{role:'system',content:system},{role:'user',content:user}]})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error?.message || d.message || `AI message provider failed (${r.status})`);
  const text=d.choices?.[0]?.message?.content?.trim();
  if(!text) throw new Error('AI provider returned an empty message');
  return text.slice(0,10000);
}
app.get('/api/owner/ai-messages/drafts',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{ensureAiMessageData();res.json({drafts:db.data.aiMessageDrafts.filter(x=>x.ownerId===aiMessageOwner(req)).sort((a,b)=>b.createdAt-a.createdAt).slice(0,200),configured:AI_MESSAGE_ENABLED,model:AI_MESSAGE_MODEL});});
app.post('/api/owner/ai-messages/generate',authMiddleware,requireBusinessPermission('campaigns'),async(req,res)=>{
  ensureAiMessageData();
  if(!rateLimit(`ai-msg:${req.user.id}`,20,60*60*1000)) return res.status(429).json({error:'Too many AI message generations. Try again later.'});
  const ownerId=aiMessageOwner(req), instruction=String(req.body.instruction||'').trim(), eventId=String(req.body.eventId||'').trim(), templateId=String(req.body.templateId||'').trim();
  if(!instruction) return res.status(400).json({error:'Tell AI what message you want'});
  const event=eventId?db.data.events.find(e=>e.id===eventId&&e.ownerId===ownerId):null;
  const template=templateId?db.data.messageTemplates.find(t=>t.id===templateId&&t.ownerId===ownerId):null;
  if(eventId&&!event)return res.status(404).json({error:'Event not found'});
  try{
    const body=await generateAIMessage({instruction,event,template,language:String(req.body.language||'Hindi')});
    const draft={id:uuidv4(),ownerId,instruction,eventId:event?.id||null,templateId:template?.id||null,body,mediaUrl:event?.mediaUrl||template?.mediaUrl||null,mediaType:event?.mediaType||template?.mediaType||null,zoomLink:event?.zoomLink||'',status:'draft',approved:false,createdAt:Date.now(),updatedAt:Date.now()};
    db.data.aiMessageDrafts.push(draft); db.save(); audit(req.user.id,'ai_message.generated',{draftId:draft.id,eventId:draft.eventId});
    res.json({draft,configured:true});
  }catch(e){res.status(502).json({error:e.message});}
});
app.patch('/api/owner/ai-messages/drafts/:id',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{ensureAiMessageData();const d=db.data.aiMessageDrafts.find(x=>x.id===req.params.id&&x.ownerId===aiMessageOwner(req));if(!d)return res.status(404).json({error:'Draft not found'});if(d.status==='sent')return res.status(409).json({error:'Sent draft cannot be edited'});if(req.body.body!==undefined){const body=String(req.body.body).trim();if(!body||body.length>10000)return res.status(400).json({error:'Message is invalid'});d.body=body;}d.updatedAt=Date.now();d.approved=false;d.status='draft';db.save();audit(req.user.id,'ai_message.draft_updated',{draftId:d.id});res.json({draft:d});});
app.post('/api/owner/ai-messages/drafts/:id/approve',authMiddleware,requireOwner,(req,res)=>{ensureAiMessageData();const d=db.data.aiMessageDrafts.find(x=>x.id===req.params.id&&x.ownerId===aiMessageOwner(req));if(!d)return res.status(404).json({error:'Draft not found'});if(!d.body)return res.status(400).json({error:'Draft is empty'});d.approved=true;d.status='approved';d.approvedBy=req.user.id;d.approvedAt=Date.now();d.updatedAt=Date.now();db.save();audit(req.user.id,'ai_message.approved',{draftId:d.id});res.json({draft:d});});
app.post('/api/owner/ai-messages/drafts/:id/send',authMiddleware,requireOwner,(req,res)=>{ensureAiMessageData();const d=db.data.aiMessageDrafts.find(x=>x.id===req.params.id&&x.ownerId===aiMessageOwner(req));if(!d)return res.status(404).json({error:'Draft not found'});if(!d.approved)return res.status(409).json({error:'Owner approval is required before sending'});const ownerId=aiMessageOwner(req);const eventId=String(req.body.eventId||d.eventId||'').trim();const event=eventId?db.data.events.find(e=>e.id===eventId&&e.ownerId===ownerId):null;if(eventId&&!event)return res.status(404).json({error:'Event not found'});if(event&&['completed','cancelled','archived'].includes(event.status))return res.status(409).json({error:'This event is no longer active.'});const campaign={id:uuidv4(),ownerId,name:String(req.body.name||`AI Message — ${new Date().toLocaleDateString()}`).slice(0,150),message:d.body,templateId:null,eventId:event?.id||null,filters:{status:String(req.body.filters?.status||'all').toLowerCase(),category:String(req.body.filters?.category||'').slice(0,100),city:String(req.body.filters?.city||'').slice(0,100)},contactIds:Array.isArray(req.body.contactIds)?req.body.contactIds:[],mediaUrl:String(req.body.mediaUrl||d.mediaUrl||event?.mediaUrl||'').trim().slice(0,2048)||null,mediaType:String(req.body.mediaType||d.mediaType||event?.mediaType||'').slice(0,50)||null,scheduledAt:null,mode:'IN_APP',status:'draft',createdAt:Date.now(),stats:{total:0,queued:0,sent:0,delivered:0,read:0,failed:0,replies:0,skipped:0}};db.data.campaigns.push(campaign);d.status='approved';d.sentCampaignId=campaign.id;d.updatedAt=Date.now();db.save();let result;try{result=dispatchInternalCampaign(campaign);}catch(e){return res.status(409).json({error:e.message});}d.status='sent';d.sentAt=Date.now();db.save();audit(req.user.id,'ai_message.sent',{draftId:d.id,campaignId:campaign.id,...result});res.json({draft:d,campaign,result});});

// EVENTS / CLASSES / SEMINARS / TOPICS
function eventOwner(req){ return businessOwnerId(req.user); }
app.get('/api/owner/events',authMiddleware,requireBusinessPermission('members'),(req,res)=>{
  ensureAutomationData();
  const q=String(req.query.q||'').trim().toLowerCase();
  const status=String(req.query.status||'all').toLowerCase();
  const items=db.data.events.filter(e=>e.ownerId===eventOwner(req)).filter(e=>!q||[e.name,e.artist,e.topic,e.type,e.location].some(v=>String(v||'').toLowerCase().includes(q))).filter(e=>status==='all'||e.status===status).sort((a,b)=>(b.date||'').localeCompare(a.date||'')||b.createdAt-a.createdAt);
  res.json({events:items});
});
app.post('/api/owner/events',authMiddleware,requireBusinessPermission('members'),(req,res)=>{
  ensureAutomationData();
  const e={id:uuidv4(),ownerId:eventOwner(req),name:String(req.body.name||'').trim().slice(0,150),type:String(req.body.type||'seminar').trim().slice(0,50),artist:String(req.body.artist||'').trim().slice(0,100),topic:String(req.body.topic||'').trim().slice(0,150),date:String(req.body.date||'').trim().slice(0,30),time:String(req.body.time||'').trim().slice(0,30),location:String(req.body.location||'').trim().slice(0,150),zoomLink:String(req.body.zoomLink||'').trim().slice(0,2048),script:String(req.body.script||'').slice(0,10000),mediaUrl:String(req.body.mediaUrl||'').trim().slice(0,2048),mediaType:String(req.body.mediaType||'').slice(0,50),status:String(req.body.status||'draft').toLowerCase(),createdAt:Date.now(),updatedAt:Date.now()};
  if(!e.name) return res.status(400).json({error:'Event name is required'});
  if(!['draft','scheduled','active','completed','cancelled','archived'].includes(e.status)) e.status='draft';
  db.data.events.push(e);db.save();audit(req.user.id,'event.created',{eventId:e.id});res.json({event:e});
});
app.patch('/api/owner/events/:id',authMiddleware,requireBusinessPermission('members'),(req,res)=>{
  ensureAutomationData();const e=db.data.events.find(x=>x.id===req.params.id&&x.ownerId===eventOwner(req));if(!e)return res.status(404).json({error:'Event not found'});
  for(const k of ['name','type','artist','topic','date','time','location','zoomLink','script','mediaUrl','mediaType']) if(req.body[k]!==undefined){ const max=k==='script'?10000:(k==='zoomLink'||k==='mediaUrl'?2048:200); e[k]=String(req.body[k]||'').trim().slice(0,max); }
  if(req.body.status!==undefined && ['draft','scheduled','active','completed','cancelled','archived'].includes(String(req.body.status)))e.status=String(req.body.status);
  e.updatedAt=Date.now();db.save();audit(req.user.id,'event.updated',{eventId:e.id});res.json({event:e});
});
app.post('/api/owner/events/:id/archive',authMiddleware,requireBusinessPermission('members'),(req,res)=>{ensureAutomationData();const e=db.data.events.find(x=>x.id===req.params.id&&x.ownerId===eventOwner(req));if(!e)return res.status(404).json({error:'Event not found'});e.status='archived';e.updatedAt=Date.now();db.save();audit(req.user.id,'event.archived',{eventId:e.id});res.json({event:e});});
app.post('/api/owner/events/:id/restore',authMiddleware,requireBusinessPermission('members'),(req,res)=>{ensureAutomationData();const e=db.data.events.find(x=>x.id===req.params.id&&x.ownerId===eventOwner(req));if(!e)return res.status(404).json({error:'Event not found'});e.status='draft';e.updatedAt=Date.now();db.save();audit(req.user.id,'event.restored',{eventId:e.id});res.json({event:e});});
app.delete('/api/owner/events/:id',authMiddleware,requireOwner,(req,res)=>{ensureAutomationData();const i=db.data.events.findIndex(x=>x.id===req.params.id&&x.ownerId===eventOwner(req));if(i<0)return res.status(404).json({error:'Event not found'});const e=db.data.events[i];if(e.status!=='archived')return res.status(409).json({error:'Archive the event before permanent deletion'});db.data.events.splice(i,1);db.save();audit(req.user.id,'event.deleted',{eventId:e.id});res.json({ok:true});});

app.get('/api/owner/scripts',authMiddleware,requireBusinessPermission('aiCalling'),(req,res)=>{ensureAutomationData();res.json({scripts:db.data.aiCallScripts});});
// Pushes the owner's Admin Panel script text to Bolna as the Agent's live prompt, so the
// script written here is the ONLY place it needs to be edited - no manual dashboard copying.
// Creates a new Bolna Agent the first time, updates the same one on later edits.
async function syncScriptToBolnaAgent(s){
  if (AI_CALL_PROVIDER !== 'bolna' || !BOLNA_API_KEY) return; // Bolna not the active provider - nothing to sync
  const agentConfig = {
    agent_name: s.name,
    agent_type: 'other',
    agent_welcome_message: s.script.split('\n')[0].slice(0,300) || 'Namaste!',
    webhook_url: `${APP_BASE_URL}/api/webhooks/ai-calls/bolna`,
    tasks: [{
      task_type: 'conversation',
      toolchain: { execution: 'parallel', pipelines: [['transcriber','llm','synthesizer']] },
      tools_config: {
        transcriber: { provider: 'deepgram', language: BLAND_LANGUAGE || 'hi', stream: true, encoding: 'linear16' },
        llm_agent: { agent_type: 'simple_llm_agent', agent_flow_type: 'streaming', llm_config: { provider: 'openai', model: 'gpt-4o-mini' } },
        synthesizer: { audio_format: 'wav', provider: 'sarvam', stream: true, provider_config: { voice: 'meera' }, buffer_size: 100 }
      },
      task_config: { hangup_after_silence: 30 }
    }],
    agent_prompts: { task_1: { system_prompt: s.script } }
  };
  const url = s.bolnaAgentId ? `https://api.bolna.ai/v2/agent/${s.bolnaAgentId}` : 'https://api.bolna.ai/v2/agent';
  const method = s.bolnaAgentId ? 'PUT' : 'POST';
  const resp = await fetch(url, { method, headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${BOLNA_API_KEY}` }, body: JSON.stringify({ agent_config: agentConfig, agent_prompts: agentConfig.agent_prompts }) });
  const data = await resp.json().catch(()=>({}));
  if (!resp.ok) throw new Error(data.message || data.error || `Bolna agent sync failed (${resp.status})`);
  if (data.agent_id) s.bolnaAgentId = data.agent_id;
}
app.post('/api/owner/scripts',authMiddleware,requireBusinessPermission('aiCalling'),async(req,res)=>{
  ensureAutomationData();
  const name=String(req.body.name||'').trim(),matchStatus=String(req.body.matchStatus||'unknown').toLowerCase(),script=String(req.body.script||'').trim();
  if(!name||!script)return res.status(400).json({error:'Script name and script are required'});
  const s={id:uuidv4(),name,matchStatus,script,bolnaAgentId:String(req.body.bolnaAgentId||'').trim()||null,enabled:req.body.enabled!==false,createdAt:Date.now(),updatedAt:Date.now()};
  db.data.aiCallScripts.push(s); db.save(); audit(req.user.id,'ai_script.created',{scriptId:s.id});
  let bolnaSyncError=null;
  try{ await syncScriptToBolnaAgent(s); db.save(); }catch(e){ bolnaSyncError=String(e.message||e); audit(req.user.id,'ai_script.bolna_sync_failed',{scriptId:s.id,error:bolnaSyncError}); }
  res.json({script:s, bolnaSyncError});
});
app.patch('/api/owner/scripts/:id',authMiddleware,requireBusinessPermission('aiCalling'),async(req,res)=>{
  ensureAutomationData();
  const s=db.data.aiCallScripts.find(x=>x.id===req.params.id);
  if(!s)return res.status(404).json({error:'Script not found'});
  if(req.body.name!==undefined)s.name=String(req.body.name).slice(0,100);
  if(req.body.script!==undefined)s.script=String(req.body.script).slice(0,10000);
  if(req.body.matchStatus!==undefined)s.matchStatus=String(req.body.matchStatus).toLowerCase();
  if(req.body.bolnaAgentId!==undefined)s.bolnaAgentId=String(req.body.bolnaAgentId).trim()||null;
  if(req.body.enabled!==undefined)s.enabled=!!req.body.enabled;
  s.updatedAt=Date.now(); db.save();
  let bolnaSyncError=null;
  try{ await syncScriptToBolnaAgent(s); db.save(); }catch(e){ bolnaSyncError=String(e.message||e); audit(req.user.id,'ai_script.bolna_sync_failed',{scriptId:s.id,error:bolnaSyncError}); }
  res.json({script:s, bolnaSyncError});
});
app.delete('/api/owner/scripts/:id',authMiddleware,requireBusinessPermission('aiCalling'),(req,res)=>{ensureAutomationData();const i=db.data.aiCallScripts.findIndex(x=>x.id===req.params.id);if(i<0)return res.status(404).json({error:'Script not found'});db.data.aiCallScripts.splice(i,1);db.save();res.json({ok:true});});
app.post('/api/owner/ai-calls/queue',authMiddleware,requireBusinessPermission('aiCalling'),(req,res)=>{ensureAutomationData();const ids=Array.isArray(req.body.contactIds)?req.body.contactIds:[];const scriptId=String(req.body.scriptId||'');const script=db.data.aiCallScripts.find(s=>s.id===scriptId&&s.enabled);if(!script)return res.status(400).json({error:'Select an enabled AI call script'});const selected=db.data.marketingContacts.filter(c=>ids.includes(c.id)&&c.optIn&&c.callingConsent===true);const jobs=[];for(const c of selected){const job={id:uuidv4(),ownerId:businessOwnerId(req.user),contactId:c.id,phone:c.phone,name:c.name,scriptId:script.id,script:script.script,status:'queued',provider:'not_configured',createdAt:Date.now(),attempts:0};db.data.aiCallJobs.push(job);jobs.push(job);}db.save();audit(req.user.id,'ai_calls.queued',{count:jobs.length,scriptId});res.json({queued:jobs.length,jobs});});
app.get('/api/owner/ai-calls/jobs',authMiddleware,requireBusinessPermission('aiCalling'),(req,res)=>{ensureAutomationData();res.json({jobs:db.data.aiCallJobs.slice(-500).reverse()});});
app.post('/api/owner/ai-calls/auto-queue',authMiddleware,requireBusinessPermission('aiCalling'),(req,res)=>{ensureAutomationData();const enabled=db.data.aiCallScripts.filter(s=>s.enabled);const byStatus=new Map(enabled.map(s=>[s.matchStatus,s]));const candidates=db.data.marketingContacts.filter(c=>c.optIn&&c.callingConsent===true).filter(c=>!db.data.aiCallJobs.some(j=>j.contactId===c.id&&['queued','running','completed'].includes(j.status)));let queued=0;for(const c of candidates){const s=byStatus.get(classifyContact(c));if(!s)continue;db.data.aiCallJobs.push({id:uuidv4(),ownerId:businessOwnerId(req.user),contactId:c.id,phone:c.phone,name:c.name,scriptId:s.id,script:s.script,status:'queued',provider:'not_configured',createdAt:Date.now(),attempts:0});queued++;}db.save();audit(req.user.id,'ai_calls.auto_queued',{queued});res.json({queued});});
// Places a real outbound AI voice call for one queued job via Bland AI.
async function placeBlandCall(job){
  const webhookUrl = `${APP_BASE_URL}/api/webhooks/ai-calls/bland/${job.id}`;
  const resp = await fetch('https://api.bland.ai/v1/calls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'authorization': BLAND_API_KEY },
    body: JSON.stringify({
      phone_number: job.phone,
      task: job.script, // the owner-authored script becomes the AI's conversation instructions
      voice_id: BLAND_VOICE_ID,
      language: BLAND_LANGUAGE,
      webhook_url: webhookUrl,
      record: true,
      request_data: { contact_name: job.name || '', job_id: job.id }
    })
  });
  const data = await resp.json().catch(()=>({}));
  if (!resp.ok || data.status === 'error') throw new Error(data.message || data.error || `Bland AI request failed (${resp.status})`);
  return data.call_id;
}
// Places a real outbound AI voice call via Bolna AI (cheaper, India-focused).
// Bolna calls run through a pre-built "Agent" configured in the Bolna dashboard (script/prompt,
// voice, language all live there) - so each aiCallScript must carry the matching bolnaAgentId.
async function placeBolnaCall(job, script){
  if (!script?.bolnaAgentId) throw new Error('This script has no Bolna Agent ID. Create/paste your script in the Bolna dashboard, then add its Agent ID to this script.');
  const resp = await fetch('https://api.bolna.ai/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${BOLNA_API_KEY}` },
    body: JSON.stringify({
      agent_id: script.bolnaAgentId,
      recipient_phone_number: job.phone,
      user_data: { customer_name: job.name || '', job_id: job.id }
    })
  });
  const data = await resp.json().catch(()=>({}));
  if (!resp.ok) throw new Error(data.message || data.error || `Bolna AI request failed (${resp.status})`);
  return data.execution_id;
}
// Places a real outbound AI voice call via Vapi. Uses the account's default phone number + assistant
// (from env), unless the script itself carries an override assistant ID (script.bolnaAgentId is reused
// as a generic "provider agent/assistant ID" field so the same admin UI field works for any provider).
async function placeVapiCall(job, script){
  const assistantId = (script && script.bolnaAgentId) || VAPI_ASSISTANT_ID;
  if (!assistantId) throw new Error('No Vapi Assistant ID configured. Set VAPI_ASSISTANT_ID in your environment, or paste one into this script.');
  if (!VAPI_PHONE_NUMBER_ID) throw new Error('VAPI_PHONE_NUMBER_ID is not set in your environment.');
  const resp = await fetch('https://api.vapi.ai/call/phone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${VAPI_PRIVATE_KEY}` },
    body: JSON.stringify({
      phoneNumberId: VAPI_PHONE_NUMBER_ID,
      assistantId: assistantId,
      customer: { number: job.phone, name: job.name || '' }
    })
  });
  const data = await resp.json().catch(()=>({}));
  if (!resp.ok) throw new Error(data.message || data.error || `Vapi request failed (${resp.status})`);
  return data.id || data.callId;
}


function normalizeStatuses(value){
  const allowed=['valid','expired','new','expiring_soon','unknown'];
  const arr=Array.isArray(value)?value:[value];
  const out=arr.map(x=>String(x||'').toLowerCase()).filter(x=>allowed.includes(x));
  return Array.from(new Set(out));
}
function campaignCandidates(campaign){
  const targets=campaign.targetStatuses||[];
  return db.data.marketingContacts.filter(c=>{
    if(campaign.ownerId && c.ownerId!==campaign.ownerId) return false;
    if(!c.optIn || c.callingConsent!==true) return false;
    const st=classifyContact(c);
    return targets.length===0 || targets.includes(st);
  });
}
function createCampaignJobs(campaign){
  const existing=new Set(db.data.aiCallJobs.filter(j=>j.campaignId===campaign.id).map(j=>j.contactId));
  const script=db.data.aiCallScripts.find(x=>x.id===campaign.scriptId && x.enabled);
  if(!script) throw new Error('Selected AI script is missing or disabled');
  let queued=0, skipped=0;
  for(const c of campaignCandidates(campaign)){
    if(existing.has(c.id)){skipped++;continue;}
    db.data.aiCallJobs.push({
      id:uuidv4(), ownerId:campaign.ownerId, campaignId:campaign.id, contactId:c.id,
      phone:c.phone,name:c.name,scriptId:script.id,script:script.script,
      status:'queued',provider:'not_configured',createdAt:Date.now(),attempts:0
    });
    queued++;
  }
  campaign.stats={...(campaign.stats||{}),queued,skipped,total:queued+skipped};
  return {queued,skipped};
}
app.get('/api/owner/ai-calls/campaigns',authMiddleware,requireBusinessPermission('aiCalling'),(req,res)=>{
  ensureAutomationData();
  res.json({campaigns:db.data.aiCallCampaigns.filter(c=>c.ownerId===businessOwnerId(req.user)).sort((a,b)=>b.createdAt-a.createdAt)});
});
app.post('/api/owner/ai-calls/campaigns',authMiddleware,requireBusinessPermission('aiCalling'),(req,res)=>{
  ensureAutomationData();
  const name=String(req.body.name||'').trim().slice(0,100);
  const scriptId=String(req.body.scriptId||'');
  const script=db.data.aiCallScripts.find(x=>x.id===scriptId&&x.enabled);
  if(!name||!script)return res.status(400).json({error:'Campaign name and an enabled AI script are required'});
  const startAt=new Date(req.body.startAt).getTime(), endAt=new Date(req.body.endAt).getTime();
  if(!Number.isFinite(startAt)||!Number.isFinite(endAt)||endAt<=startAt)return res.status(400).json({error:'Enter a valid start and end date/time'});
  const concurrency=Math.max(1,Math.min(10,parseInt(req.body.concurrency||1,10)||1));
  const targets=normalizeStatuses(req.body.targetStatuses);
  const c={id:uuidv4(),ownerId:businessOwnerId(req.user),name,scriptId,targetStatuses:targets,startAt,endAt,concurrency,status:'scheduled',createdAt:Date.now(),stats:{total:0,queued:0,started:0,completed:0,failed:0}};
  db.data.aiCallCampaigns.push(c);db.save();audit(req.user.id,'ai_campaign.created',{campaignId:c.id,targetStatuses:targets,startAt,endAt,concurrency});
  res.json({campaign:c});
});
app.post('/api/owner/ai-calls/campaigns/:id/cancel',authMiddleware,requireBusinessPermission('aiCalling'),(req,res)=>{
  ensureAutomationData();
  const c=db.data.aiCallCampaigns.find(x=>x.id===req.params.id&&x.ownerId===businessOwnerId(req.user));
  if(!c)return res.status(404).json({error:'AI calling campaign not found'});
  if(['completed','cancelled'].includes(c.status))return res.json({campaign:c});
  c.status='cancelled';c.cancelledAt=Date.now();
  db.data.aiCallJobs.filter(j=>j.campaignId===c.id&&j.status==='queued').forEach(j=>{j.status='cancelled';j.updatedAt=Date.now();});
  db.save();audit(req.user.id,'ai_campaign.cancelled',{campaignId:c.id});
  res.json({campaign:c});
});
async function processAiCallScheduler(){
  ensureAutomationData();
  const now=Date.now();
  for(const c of db.data.aiCallCampaigns){
    if(['cancelled','completed','failed'].includes(c.status))continue;
    if(now < c.startAt)continue;
    if(now >= c.endAt){
      if(c.status!=='completed'){
        db.data.aiCallJobs.filter(j=>j.campaignId===c.id&&j.status==='queued').forEach(j=>{j.status='expired_window';j.updatedAt=now;});
        c.status='completed';c.completedAt=now;db.save();audit(c.ownerId,'ai_campaign.completed',{campaignId:c.id,reason:'end_time'});
      }
      continue;
    }
    if(!AI_CALLING_ENABLED){
      c.status='failed';c.error='AI provider is not configured';c.updatedAt=now;db.save();
      continue;
    }
    if(c.status==='scheduled'){
      try{const result=createCampaignJobs(c);c.status='running';c.startedAt=now;c.stats={...(c.stats||{}),...result};db.save();audit(c.ownerId,'ai_campaign.started',{campaignId:c.id,...result});}
      catch(e){c.status='failed';c.error=String(e.message||e);db.save();continue;}
    }
    const running=db.data.aiCallJobs.filter(j=>j.campaignId===c.id&&j.status==='running').length;
    const slots=Math.max(0,(c.concurrency||1)-running);
    if(slots>0){
      const jobs=db.data.aiCallJobs.filter(j=>j.campaignId===c.id&&j.status==='queued').slice(0,slots);
      for(const j of jobs){
        try{await startAiCallJob(j,c.ownerId);c.stats.started=(c.stats.started||0)+1;}
        catch(e){c.stats.failed=(c.stats.failed||0)+1;}
      }
      db.save();
    }
  }
}
setInterval(()=>{processAiCallScheduler().catch(err=>console.error('AI scheduler error:',err.message));},15000);
setTimeout(()=>{processAiCallScheduler().catch(()=>{});},3000);
async function startAiCallJob(j, actorId){
  ensureAutomationData();
  if(!j) throw new Error('Call job not found');
  if(!AI_CALLING_ENABLED) throw new Error('AI voice/telephony provider is not configured. Set VAPI_PRIVATE_KEY (+VAPI_PHONE_NUMBER_ID + VAPI_ASSISTANT_ID), or BOLNA_API_KEY, or BLAND_API_KEY in your environment.');
  try{
    let providerCallId;
    const script = db.data.aiCallScripts.find(x=>x.id===j.scriptId);
    if (AI_CALL_PROVIDER === 'vapi') providerCallId = await placeVapiCall(j, script);
    else if (AI_CALL_PROVIDER === 'bolna') providerCallId = await placeBolnaCall(j, script);
    else providerCallId = await placeBlandCall(j);
    j.status='running'; j.provider=AI_CALL_PROVIDER; j.providerCallId=providerCallId; j.error=null;
    j.startedAt=Date.now(); j.updatedAt=Date.now(); j.attempts=(j.attempts||0)+1;
    db.save(); audit(actorId||j.ownerId,'ai_call.started',{jobId:j.id,provider:AI_CALL_PROVIDER,providerCallId});
    return j;
  }catch(e){
    j.status='failed'; j.provider=AI_CALL_PROVIDER; j.error=String(e.message||e); j.updatedAt=Date.now();
    db.save(); audit(actorId||j.ownerId,'ai_call.failed_to_start',{jobId:j.id,error:j.error});
    throw e;
  }
}
app.post('/api/owner/ai-calls/:id/run',authMiddleware,requireBusinessPermission('aiCalling'),async(req,res)=>{
  ensureAutomationData();
  const j=db.data.aiCallJobs.find(x=>x.id===req.params.id);
  if(!j)return res.status(404).json({error:'Call job not found'});
  if(j.status!=='queued')return res.status(409).json({error:'Only queued jobs can be started',job:j});
  try{
    const job=await startAiCallJob(j,req.user.id);
    res.json({job});
  }catch(e){
    res.status(502).json({error:'Could not start the AI call: '+String(e.message||e),job:j});
  }
});
// Bland AI calls this URL back when the call finishes (one URL per job, since Bland accepts a
// webhook_url per call request).
app.post('/api/webhooks/ai-calls/bland/:jobId', express.json({limit:'1mb'}), (req,res)=>{
  ensureAutomationData();
  const j = db.data.aiCallJobs.find(x=>x.id===req.params.jobId);
  if(!j) return res.status(404).json({error:'Unknown job'});
  const body = req.body || {};
  j.status = body.completed===false ? 'failed' : 'completed';
  j.transcript = body.concatenated_transcript || body.transcript || null;
  j.summary = body.summary || null;
  j.durationSeconds = body.call_length ? Math.round(body.call_length*60) : (body.corrected_duration || null);
  j.answeredBy = body.answered_by || null;
  j.completedAt = Date.now(); j.updatedAt = Date.now();
  db.save();
  audit(j.ownerId,'ai_call.webhook_received',{jobId:j.id,status:j.status});
  res.json({ok:true});
});
// Bolna AI's webhook is configured once per Agent in Bolna's dashboard (not per call), so it
// posts here without a job id in the URL - we match the job by the execution id we stored.
app.post('/api/webhooks/ai-calls/bolna', express.json({limit:'1mb'}), (req,res)=>{
  ensureAutomationData();
  const body = req.body || {};
  const executionId = String(body.id ?? body.execution_id ?? '');
  const j = db.data.aiCallJobs.find(x=>String(x.providerCallId)===executionId);
  if(!j) return res.status(404).json({error:'Unknown job'});
  j.status = body.status==='completed' ? 'completed' : (body.status==='error' ? 'failed' : j.status);
  j.transcript = body.transcript || null;
  j.durationSeconds = body.conversation_duration || body.telephony_data?.duration || null;
  j.answeredBy = body.answered_by_voice_mail ? 'voicemail' : 'human';
  j.recordingUrl = body.telephony_data?.recording_url || null;
  j.completedAt = Date.now(); j.updatedAt = Date.now();
  db.save();
  audit(j.ownerId,'ai_call.webhook_received',{jobId:j.id,status:j.status});
  res.json({ok:true});
});
const uploadExcel=multer({dest:path.join(__dirname,'uploads'),limits:{fileSize:10*1024*1024},fileFilter:(req,file,cb)=>{const ok=['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-excel'].includes(file.mimetype)||/\\.(xlsx|xls)$/i.test(file.originalname);cb(ok?null:new Error('Only .xlsx or .xls files are allowed'),ok);}});

app.get('/api/presence',authMiddleware,(req,res)=>res.json({onlineUserIds:Array.from(onlineUsers.keys())}));


// ===================== BUSINESS BROADCAST / PERMISSIONS =====================
function hasRole(user, roles){ return roles.includes(user?.role); }
function canManageBusiness(user){ return hasRole(user,['owner','admin','manager']); }
function ownerOrBusinessManager(req,res,next){
  if(!canManageBusiness(req.user)) return res.status(403).json({error:'Business permission required'});
  next();
}
function userByPhone(phone){ const target=normalizePhone(phone); return db.data.users.find(u=>normalizePhone(u.phone)===target); }
function campaignContacts(campaign){
  const f=campaign.filters||{}; const ownerId=campaign.ownerId;
  return db.data.marketingContacts.filter(c=>{
    if(c.ownerId!==ownerId || !c.optIn) return false;
    const st=classifyContact(c);
    if(f.status && f.status!=='all' && st!==String(f.status).toLowerCase()) return false;
    if(f.group && String(f.group).toLowerCase()!=='all' && String(c.group||'').toLowerCase()!==String(f.group).toLowerCase() && st!==String(f.group).toLowerCase()) return false;
    if(f.category && String(c.category||'').toLowerCase()!==String(f.category).toLowerCase()) return false;
    if(f.city && String(c.city||'').toLowerCase()!==String(f.city).toLowerCase()) return false;
    if(f.artist && String(c.artist||'').toLowerCase()!==String(f.artist).toLowerCase()) return false;
    if(Array.isArray(campaign.contactIds) && campaign.contactIds.length && !campaign.contactIds.includes(c.id)) return false;
    return true;
  });
}
function renderCampaignMessage(template,campaign,contact,event){
  let text=String(template?.body||campaign.message||'');
  const vars={name:contact.name||'Customer',artist:contact.artist||event?.artist||'',topic:contact.topic||event?.topic||'',event:event?.name||'',class_name:event?.name||'',date:event?.date||'',time:event?.time||'',location:event?.location||'',zoom_link:event?.zoomLink||''};
  return text.replace(/\{([a-z_]+)\}/gi,(m,k)=>Object.prototype.hasOwnProperty.call(vars,k.toLowerCase())?vars[k.toLowerCase()]:m);
}
function dispatchInternalCampaign(campaign){
  const contacts=campaignContacts(campaign);
  const template=campaign.templateId?db.data.messageTemplates.find(t=>t.id===campaign.templateId&&t.ownerId===campaign.ownerId):null;
  const event=campaign.eventId?db.data.events.find(e=>e.id===campaign.eventId&&e.ownerId===campaign.ownerId):null;
  if(campaign.eventId && (!event || ['completed','cancelled','archived'].includes(event.status))) throw new Error('This event is no longer active.');
  let sent=0,skipped=0,failed=0;
  for(const c of contacts){
    const recipient=userByPhone(c.phone);
    if(!recipient || recipient.id===campaign.ownerId){ skipped++; continue; }
    const chat=getOrCreateDirectChat(campaign.ownerId,recipient.id);
    const text=renderCampaignMessage(template,campaign,c,event);
    const m={id:uuidv4(),chatId:chat.id,senderId:campaign.ownerId,text:text.slice(0,5000),mediaUrl:template?.mediaUrl||campaign.mediaUrl||null,mediaType:template?.mediaType||campaign.mediaType||null,replyTo:null,reactions:{},edited:false,createdAt:Date.now(),deliveredTo:[campaign.ownerId],readBy:[campaign.ownerId],deletedFor:[],campaignId:campaign.id};
    db.data.messages.push(m); io.to(chat.id).emit('message:new',m); io.to(`user:${recipient.id}`).emit('campaign:message',{campaignId:campaign.id,message:m}); sent++;
  }
  campaign.stats={total:contacts.length,queued:0,sent,delivered:sent,read:0,failed,skipped,replies:0};
  campaign.status='completed';campaign.mode='IN_APP';campaign.completedAt=Date.now();db.save();
  audit(campaign.ownerId,'campaign.internal_broadcast_completed',{campaignId:campaign.id,sent,skipped,total:contacts.length});
  return {sent,skipped,failed,total:contacts.length};
}

app.get('/api/business/users',authMiddleware,requireOwner,(req,res)=>{
  res.json({users:db.data.users.map(u=>({id:u.id,name:u.name,username:u.username,phone:u.phone,role:u.role||'user',permissions:u.permissions||{}}))});
});
app.patch('/api/business/users/:id',authMiddleware,requireOwner,(req,res)=>{
  const u=db.data.users.find(x=>x.id===req.params.id); if(!u) return res.status(404).json({error:'User not found'});
  if(u.id===req.user.id && req.body.role && req.body.role!=='owner') return res.status(400).json({error:'Owner cannot demote self'});
  const role=String(req.body.role||u.role||'user').toLowerCase(); if(!['owner','admin','manager','user'].includes(role)) return res.status(400).json({error:'Invalid role'});
  if(u.id!==req.user.id){ if(u.role==='owner' && role!=='owner') return res.status(403).json({error:'Owner role cannot be removed'}); u.role=role; }
  if(req.body.permissions && typeof req.body.permissions==='object') u.permissions=req.body.permissions;
  db.save(); audit(req.user.id,'user.role_updated',{userId:u.id,role:u.role}); res.json({user:publicUser(u)});
});
app.post('/api/marketing/campaigns/:id/send-internal',authMiddleware,requireBusinessPermission('campaigns'),(req,res)=>{
  marketingData(); const c=db.data.campaigns.find(x=>x.id===req.params.id&&x.ownerId===businessOwnerId(req.user)); if(!c) return res.status(404).json({error:'Campaign not found'});
  if(c.status==='completed') return res.status(409).json({error:'Campaign already completed'});
  const result=dispatchInternalCampaign(c); res.json({campaign:c,result});
});

// ===================== WEBRTC CALL SIGNALING =====================
function validCallChat(userId, chatId, targetUserId){
  const chat=db.data.chats.find(c=>c.id===chatId);
  return !!(chat && chat.memberIds.includes(userId) && chat.memberIds.includes(targetUserId));
}
// SOCKETS
io.use(async (socket,next)=>{try{await db.ready;const token=socket.handshake.auth?.token;const p=jwt.verify(token||'',JWT_SECRET,{issuer:'subharambhindia',audience:'subharambhindia-app'});if(!db.data.users.some(u=>u.id===p.userId))return next(new Error('Invalid session'));socket.userId=p.userId;next();}catch{next(new Error('Invalid or expired token'));}});
io.on('connection',socket=>{const userId=socket.userId;
  socket.on('call:start',({callId,chatId,targetUserId,kind}={})=>{
    if(!callId||!chatId||!targetUserId||!['audio','video'].includes(kind)||!validCallChat(userId,chatId,targetUserId)) return socket.emit('call:error',{error:'Invalid call request'});
    const caller=db.data.users.find(u=>u.id===userId);
    io.to(`user:${targetUserId}`).emit('call:incoming',{callId,chatId,callerId:userId,callerName:caller?.name||'User',callerAvatar:caller?.avatar||null,kind});
  });
  socket.on('call:offer',({callId,chatId,targetUserId,offer}={})=>{
    if(!callId||!chatId||!targetUserId||!offer||!validCallChat(userId,chatId,targetUserId)) return;
    io.to(`user:${targetUserId}`).emit('call:offer',{callId,chatId,fromUserId:userId,offer});
  });
  socket.on('call:answer',({callId,chatId,targetUserId,answer}={})=>{
    if(!callId||!chatId||!targetUserId||!answer||!validCallChat(userId,chatId,targetUserId)) return;
    io.to(`user:${targetUserId}`).emit('call:answer',{callId,chatId,fromUserId:userId,answer});
  });
  socket.on('call:ice',({callId,chatId,targetUserId,candidate}={})=>{
    if(!callId||!chatId||!targetUserId||!candidate||!validCallChat(userId,chatId,targetUserId)) return;
    io.to(`user:${targetUserId}`).emit('call:ice',{callId,chatId,fromUserId:userId,candidate});
  });
  socket.on('call:end',({callId,chatId,targetUserId,reason}={})=>{
    if(!callId||!chatId||!targetUserId||!validCallChat(userId,chatId,targetUserId)) return;
    io.to(`user:${targetUserId}`).emit('call:end',{callId,fromUserId:userId,reason:reason||'ended'});
  });
if(!onlineUsers.has(userId))onlineUsers.set(userId,new Set());onlineUsers.get(userId).add(socket.id);socket.join(`user:${userId}`);db.data.chats.filter(c=>c.memberIds.includes(userId)).forEach(c=>socket.join(c.id));io.emit('presence:online',{userId});
  socket.on('message:send',({chatId,text,mediaUrl,mediaType,replyTo}={})=>{const chat=db.data.chats.find(c=>c.id===chatId);if(!chat||!chat.memberIds.includes(userId))return;if(chat.type==='group'&&chat.permissions?.onlyAdminsCanMessage&&!chat.adminIds.includes(userId))return socket.emit('error:message',{error:'Only admins can send messages in this group'});const blocked=chat.memberIds.some(id=>id!==userId&&db.data.users.find(u=>u.id===id)?.blockedUserIds?.includes(userId));if(blocked)return socket.emit('error:message',{error:'Messaging is blocked'});const safeText=String(text||'').slice(0,5000);if(!safeText&&!mediaUrl)return;const m={id:uuidv4(),chatId,senderId:userId,text:safeText,mediaUrl:mediaUrl||null,mediaType:mediaType||null,replyTo:replyTo||null,reactions:{},edited:false,createdAt:Date.now(),deliveredTo:[userId],readBy:[userId],deletedFor:[]};db.data.messages.push(m);db.save();io.to(chatId).emit('message:new',m);});
  socket.on('message:typing',({chatId}={})=>{const chat=db.data.chats.find(c=>c.id===chatId);if(chat?.memberIds.includes(userId))socket.to(chatId).emit('message:typing',{chatId,userId});});
  socket.on('message:read',({chatId,messageIds=[]}={})=>{const chat=db.data.chats.find(c=>c.id===chatId);if(!chat?.memberIds.includes(userId)||!Array.isArray(messageIds))return;let changed=false;db.data.messages.forEach(m=>{if(m.chatId===chatId&&messageIds.includes(m.id)&&!m.readBy.includes(userId)){m.readBy.push(userId);changed=true;}});if(changed){db.save();io.to(chatId).emit('message:read',{chatId,messageIds,userId});}});
  socket.on('message:react',({messageId,emoji}={})=>{const m=db.data.messages.find(x=>x.id===messageId),chat=m&&db.data.chats.find(c=>c.id===m.chatId);if(!m||!chat?.memberIds.includes(userId)||typeof emoji!=='string'||emoji.length>8)return;if(!m.reactions[emoji])m.reactions[emoji]=[];const idx=m.reactions[emoji].indexOf(userId);if(idx>=0)m.reactions[emoji].splice(idx,1);else m.reactions[emoji].push(userId);db.save();io.to(m.chatId).emit('message:reacted',{messageId,reactions:m.reactions});});
  socket.on('message:edit',({messageId,text}={})=>{const m=db.data.messages.find(x=>x.id===messageId&&x.senderId===userId),chat=m&&db.data.chats.find(c=>c.id===m.chatId);if(!m||!chat?.memberIds.includes(userId)||typeof text!=='string')return;m.text=text.slice(0,5000);m.edited=true;db.save();io.to(m.chatId).emit('message:edited',{messageId,text:m.text,edited:true});});
  socket.on('message:delete',({messageId,forEveryone}={})=>{const m=db.data.messages.find(x=>x.id===messageId),chat=m&&db.data.chats.find(c=>c.id===m.chatId);if(!m||!chat?.memberIds.includes(userId))return;if(forEveryone&&m.senderId===userId){m.text='';m.mediaUrl=null;m.deletedForEveryone=true;db.save();io.to(m.chatId).emit('message:deletedForEveryone',{messageId});}else{if(!m.deletedFor.includes(userId))m.deletedFor.push(userId);db.save();socket.emit('message:deletedForMe',{messageId});}});
  socket.on('disconnect',()=>{const set=onlineUsers.get(userId);if(set){set.delete(socket.id);if(set.size===0){onlineUsers.delete(userId);const user=db.data.users.find(u=>u.id===userId);if(user){user.lastSeen=Date.now();db.save();}io.emit('presence:offline',{userId,lastSeen:Date.now()});}}});
});

app.get('/admin',(req,res)=>res.sendFile(path.join(PUBLIC_DIR,'admin.html')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{console.error(err.message);if(!res.headersSent)res.status(500).json({error:'Internal server error'});});
db.ready.then(() => server.listen(PORT,()=>console.log(`\n SubhArambhIndia v6 running at http://localhost:${PORT}\n Demo mode: ${DEMO_MODE} | PostgreSQL: ${db.isPostgres}\n`))).catch(err=>{ console.error('Server startup aborted:',err.message); process.exit(1); });

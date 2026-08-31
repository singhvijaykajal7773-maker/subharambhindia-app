require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { Server } = require('socket.io');
const XLSX = require('xlsx');
const db = require('./db');

function normalizePhone(value) {
  let p = String(value ?? '').trim().replace(/[^0-9+]/g, '');
  if (p.startsWith('+91')) p = p.slice(3);
  else if (p.startsWith('91') && p.length === 12) p = p.slice(2);
  if (p.length === 10) return '+91' + p;
  return p.startsWith('+') ? p : (p ? '+' + p : '');
}
const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET;
const DEMO_MODE = String(process.env.DEMO_MODE ?? 'true') === 'true';
const OWNER_PHONE = normalizePhone(process.env.OWNER_PHONE || '');
const STATUS_LIFETIME_MS = 24 * 60 * 60 * 1000;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be set to a random string of at least 32 characters.');
  process.exit(1);
}

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
app.get('/healthz', (req,res)=>res.json({ok:true,service:'subharambhindia',version:'3.0.0'}));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { index: false }));

const otpStore = new Map();
const tempTokens = new Map();
const loginAttempts = new Map();
const requestWindow = new Map();
const RATE_WINDOW = 60_000;
const MAX_LOGIN_ATTEMPTS = 8;
const MAX_AUTH_REQUESTS = 12;

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
app.post('/api/auth/request-otp', (req, res) => {
  if (!rateLimit(`otp:${clientIp(req)}`, MAX_AUTH_REQUESTS)) return res.status(429).json({ error: 'Too many OTP requests. Try again later.' });
  const phone = String(req.body.phone || '').replace(/\s+/g, '');
  if (!/^\+?[0-9]{6,15}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid phone number' });
  const otp = DEMO_MODE ? '123456' : String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(phone, { otp, expires: Date.now() + 5 * 60 * 1000 });
  res.json({ message: DEMO_MODE ? 'DEMO MODE: no SMS is sent.' : 'OTP sent', demoOtp: DEMO_MODE ? otp : undefined });
});
app.post('/api/auth/verify-otp', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s+/g, ''), otp = String(req.body.otp || '');
  const entry = otpStore.get(phone);
  if (!entry || entry.expires < Date.now() || entry.otp !== otp) return res.status(400).json({ error: 'Invalid or expired OTP' });
  otpStore.delete(phone);
  const existingUser = db.data.users.find(u => u.phone === phone);
  if (existingUser) { if (OWNER_PHONE && normalizePhone(existingUser.phone) === OWNER_PHONE) existingUser.role='owner'; db.save(); return res.json({ status: 'login', token: signToken(existingUser.id), user: publicUser(existingUser) }); }
  const tempToken = uuidv4(); tempTokens.set(tempToken, { phone, expires: Date.now() + 15 * 60 * 1000 });
  res.json({ status: 'new_user', tempToken });
});
app.post('/api/auth/complete-profile', async (req, res) => {
  const { tempToken, name, username, password } = req.body;
  const entry = tempTokens.get(tempToken);
  if (!entry || entry.expires < Date.now()) return res.status(400).json({ error: 'Registration session expired' });
  if ([['name',name,80],['username',username,30],['password',password,128]].some(([f,v,m]) => requireBodyString(v,f,m))) return res.status(400).json({ error: 'Please enter valid profile details' });
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-30 letters/numbers/._-' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.data.users.find(u => u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'Username already taken' });
  tempTokens.delete(tempToken);
  const user = { id: uuidv4(), name: name.trim(), username, phone: entry.phone, passwordHash: await bcrypt.hash(password, 12), about: 'Available', avatar: null, privacy: { lastSeen:'everyone', online:'everyone', profilePhoto:'everyone', status:'everyone', readReceipts:true }, blockedUserIds:[], createdAt:Date.now(), lastSeen:Date.now(), role: (OWNER_PHONE && normalizePhone(entry.phone) === OWNER_PHONE) ? 'owner' : 'user' };
  db.data.users.push(user); db.save();
  res.json({ token: signToken(user.id), user: publicUser(user) });
});
app.post('/api/auth/login-password', async (req, res) => {
  const ip = clientIp(req), key = `login:${ip}`;
  if (!rateLimit(key, MAX_LOGIN_ATTEMPTS)) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  const { username, password } = req.body;
  const user = db.data.users.find(u => u.username === username || u.phone === username);
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
function marketingData(){ if(!Array.isArray(db.data.marketingContacts)) db.data.marketingContacts=[]; if(!Array.isArray(db.data.campaigns)) db.data.campaigns=[]; if(!Array.isArray(db.data.auditLogs)) db.data.auditLogs=[]; }
function audit(userId,action,meta={}){marketingData();db.data.auditLogs.push({id:uuidv4(),userId,action,meta,createdAt:Date.now()});if(db.data.auditLogs.length>1000)db.data.auditLogs.shift();db.save();}
app.get('/api/marketing/dashboard',authMiddleware,(req,res)=>{marketingData();const mine=db.data.marketingContacts.filter(c=>c.ownerId===req.user.id);const campaigns=db.data.campaigns.filter(c=>c.ownerId===req.user.id);res.json({contacts:mine.length,groups:new Set(mine.map(c=>c.group).filter(Boolean)).size,campaigns:campaigns.length,sent:campaigns.reduce((n,c)=>n+(c.stats?.sent||0),0),delivered:campaigns.reduce((n,c)=>n+(c.stats?.delivered||0),0),read:campaigns.reduce((n,c)=>n+(c.stats?.read||0),0),replies:campaigns.reduce((n,c)=>n+(c.stats?.replies||0),0)});});
app.get('/api/marketing/contacts',authMiddleware,(req,res)=>{marketingData();const q=String(req.query.q||'').toLowerCase();res.json({contacts:db.data.marketingContacts.filter(c=>c.ownerId===req.user.id).filter(c=>!q||c.name.toLowerCase().includes(q)||c.phone.includes(q)).slice(0,500)});});
app.post('/api/marketing/contacts',authMiddleware,(req,res)=>{marketingData();const name=String(req.body.name||'').trim(),phone=String(req.body.phone||'').replace(/\s+/g,'');if(!name||name.length>80||!/^[+0-9][0-9]{5,15}$/.test(phone))return res.status(400).json({error:'Enter valid name and phone'});if(db.data.marketingContacts.some(c=>c.ownerId===req.user.id&&c.phone===phone))return res.status(409).json({error:'Contact already exists'});const c={id:uuidv4(),ownerId:req.user.id,name,phone,group:String(req.body.group||'General').slice(0,50),optIn:req.body.optIn!==false,createdAt:Date.now()};db.data.marketingContacts.push(c);audit(req.user.id,'contact.created',{contactId:c.id});res.json({contact:c});});
app.post('/api/marketing/contacts/import',authMiddleware,(req,res)=>{marketingData();const rows=Array.isArray(req.body.contacts)?req.body.contacts:[];if(rows.length>5000)return res.status(400).json({error:'Demo import limit is 5,000 rows per request'});let added=0,skipped=0;for(const r of rows){const name=String(r.name||'').trim(),phone=String(r.phone||'').replace(/\s+/g,'');if(!name||!/^[+0-9][0-9]{5,15}$/.test(phone)||db.data.marketingContacts.some(c=>c.ownerId===req.user.id&&c.phone===phone)){skipped++;continue;}db.data.marketingContacts.push({id:uuidv4(),ownerId:req.user.id,name,phone,group:String(r.group||'General').slice(0,50),optIn:r.optIn!==false,createdAt:Date.now()});added++;}audit(req.user.id,'contacts.imported',{added,skipped});res.json({added,skipped});});
app.get('/api/marketing/campaigns',authMiddleware,(req,res)=>{marketingData();res.json({campaigns:db.data.campaigns.filter(c=>c.ownerId===req.user.id).sort((a,b)=>b.createdAt-a.createdAt)});});
app.post('/api/marketing/campaigns',authMiddleware,(req,res)=>{marketingData();const name=String(req.body.name||'').trim(),message=String(req.body.message||'').trim();if(!name||name.length>100||!message||message.length>2000)return res.status(400).json({error:'Campaign name and message are required'});const audience=String(req.body.group||'All');const recipients=db.data.marketingContacts.filter(c=>c.ownerId===req.user.id&&c.optIn&&(audience==='All'||c.group===audience));const c={id:uuidv4(),ownerId:req.user.id,name,message,group:audience,mode:'DEMO',status:'draft',createdAt:Date.now(),stats:{total:recipients.length,queued:0,sent:0,delivered:0,read:0,failed:0,replies:0}};db.data.campaigns.push(c);audit(req.user.id,'campaign.created',{campaignId:c.id});res.json({campaign:c});});
app.post('/api/marketing/campaigns/:id/start',authMiddleware,(req,res)=>{marketingData();const c=db.data.campaigns.find(x=>x.id===req.params.id&&x.ownerId===req.user.id);if(!c)return res.status(404).json({error:'Campaign not found'});if(c.status==='running')return res.json({campaign:c});const recipients=db.data.marketingContacts.filter(x=>x.ownerId===req.user.id&&x.optIn&&(c.group==='All'||x.group===c.group));c.status='running';c.stats={total:recipients.length,queued:recipients.length,sent:0,delivered:0,read:0,failed:0,replies:0};db.save();audit(req.user.id,'campaign.started',{campaignId:c.id});let i=0;const tick=()=>{const current=db.data.campaigns.find(x=>x.id===c.id);if(!current||current.status!=='running'||i>=recipients.length){if(current&&current.status==='running')current.status='completed';if(current)db.save();return;}i++;current.stats.queued=Math.max(0,current.stats.queued-1);current.stats.sent++;if(i%10!==0||i===recipients.length)current.stats.delivered++;if(i%25===0)current.stats.read++;db.save();setTimeout(tick,60);};tick();res.json({campaign:c});});
app.post('/api/marketing/campaigns/:id/pause',authMiddleware,(req,res)=>{marketingData();const c=db.data.campaigns.find(x=>x.id===req.params.id&&x.ownerId===req.user.id);if(!c)return res.status(404).json({error:'Campaign not found'});if(c.status==='running')c.status='paused';db.save();audit(req.user.id,'campaign.paused',{campaignId:c.id});res.json({campaign:c});});
app.get('/api/security/audit',authMiddleware,(req,res)=>{marketingData();res.json({logs:db.data.auditLogs.filter(x=>x.userId===req.user.id).slice(-100).reverse()});});


// ===================== OWNER / AI CALLING CONTROL CENTER =====================
function isOwner(req){ return req.user?.role === 'owner' || (OWNER_PHONE && normalizePhone(req.user?.phone) === OWNER_PHONE); }
function requireOwner(req,res,next){ if(!isOwner(req)) return res.status(403).json({error:'Owner access required'}); next(); }
function ensureAutomationData(){
  if(!Array.isArray(db.data.aiCallScripts)) db.data.aiCallScripts=[];
  if(!Array.isArray(db.data.aiCallJobs)) db.data.aiCallJobs=[];
  if(!Array.isArray(db.data.marketingContacts)) db.data.marketingContacts=[];
}
function classifyContact(c){
  const status=String(c.status||'').toLowerCase();
  if(status.includes('expire')) return 'expired';
  if(status.includes('new')) return 'new';
  if(status.includes('valid')) return 'valid';
  if(c.expiryDate){ const d=new Date(c.expiryDate); if(!Number.isNaN(d.getTime()) && d.getTime()<Date.now()) return 'expired'; }
  return 'unknown';
}
app.get('/api/owner/overview',authMiddleware,requireOwner,(req,res)=>{
  ensureAutomationData();
  const contacts=db.data.marketingContacts;
  const counts={total:contacts.length,expired:0,valid:0,new:0,unknown:0};
  contacts.forEach(c=>counts[classifyContact(c)]++);
  const jobs=db.data.aiCallJobs;
  res.json({role:req.user.role||'owner',counts,scripts:db.data.aiCallScripts.length,jobs:{total:jobs.length,queued:jobs.filter(j=>j.status==='queued').length,completed:jobs.filter(j=>j.status==='completed').length,failed:jobs.filter(j=>j.status==='failed').length}});
});
app.get('/api/owner/contacts',authMiddleware,requireOwner,(req,res)=>{
  ensureAutomationData(); const q=String(req.query.q||'').toLowerCase(); const status=String(req.query.status||'all');
  let contacts=db.data.marketingContacts.filter(c=>!q||String(c.name).toLowerCase().includes(q)||String(c.phone).includes(q));
  if(status!=='all') contacts=contacts.filter(c=>classifyContact(c)===status);
  res.json({contacts:contacts.slice(0,5000).map(c=>({...c,computedStatus:classifyContact(c)}))});
});
app.post('/api/owner/import-xlsx',authMiddleware,requireOwner,(req,res,next)=>{
  ensureAutomationData();
  uploadExcel.single('file')(req,res,err=>{
    if(err) return res.status(400).json({error:err.message});
    try{
      if(!req.file) return res.status(400).json({error:'Select an Excel file'});
      const wb=XLSX.readFile(req.file.path); const sheet=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(sheet,{defval:''});
      if(rows.length>10000) return res.status(400).json({error:'Maximum 10,000 rows per import'});
      let added=0,updated=0,skipped=0;
      const norm=v=>String(v??'').trim();
      for(const r of rows){
        const name=norm(r.name||r.Name||r['Customer Name']||r['customer_name']);
        const phone=norm(r.phone||r.Phone||r.Mobile||r['Mobile Number']).replace(/\\s+/g,'');
        if(!name || !/^\\+?[0-9]{6,15}$/.test(phone)){skipped++;continue;}
        const data={name,phone,group:norm(r.group||r.Group||'General').slice(0,50),optIn:String(r.optIn??r.OptIn??r['Opt In']??'true').toLowerCase()!=='false',status:norm(r.status||r.Status||r.Category||r.Type).toLowerCase(),expiryDate:norm(r.expiryDate||r['Expiry Date']||r.Expiry||'')||null,contentType:norm(r.contentType||r['Content Type']||r.Content||''),callingType:norm(r.callingType||r['Calling Type']||r.Call||''),notes:norm(r.notes||r.Notes||r.Remark||'').slice(0,500)};
        const existing=db.data.marketingContacts.find(c=>c.phone===phone);
        if(existing){Object.assign(existing,data);updated++;}else{db.data.marketingContacts.push({id:uuidv4(),ownerId:req.user.id,...data,createdAt:Date.now()});added++;}
      }
      db.save(); audit(req.user.id,'contacts.xlsx_imported',{added,updated,skipped,rows:rows.length});
      res.json({added,updated,skipped,totalRows:rows.length});
    }catch(e){console.error(e);res.status(400).json({error:'Could not read Excel file'});}
  });
});
app.get('/api/owner/scripts',authMiddleware,requireOwner,(req,res)=>{ensureAutomationData();res.json({scripts:db.data.aiCallScripts});});
app.post('/api/owner/scripts',authMiddleware,requireOwner,(req,res)=>{ensureAutomationData();const name=String(req.body.name||'').trim(),matchStatus=String(req.body.matchStatus||'unknown').toLowerCase(),script=String(req.body.script||'').trim();if(!name||!script)return res.status(400).json({error:'Script name and script are required'});const s={id:uuidv4(),name,matchStatus,script,enabled:req.body.enabled!==false,createdAt:Date.now(),updatedAt:Date.now()};db.data.aiCallScripts.push(s);db.save();audit(req.user.id,'ai_script.created',{scriptId:s.id});res.json({script:s});});
app.patch('/api/owner/scripts/:id',authMiddleware,requireOwner,(req,res)=>{ensureAutomationData();const s=db.data.aiCallScripts.find(x=>x.id===req.params.id);if(!s)return res.status(404).json({error:'Script not found'});if(req.body.name!==undefined)s.name=String(req.body.name).slice(0,100);if(req.body.script!==undefined)s.script=String(req.body.script).slice(0,10000);if(req.body.matchStatus!==undefined)s.matchStatus=String(req.body.matchStatus).toLowerCase();if(req.body.enabled!==undefined)s.enabled=!!req.body.enabled;s.updatedAt=Date.now();db.save();res.json({script:s});});
app.delete('/api/owner/scripts/:id',authMiddleware,requireOwner,(req,res)=>{ensureAutomationData();const i=db.data.aiCallScripts.findIndex(x=>x.id===req.params.id);if(i<0)return res.status(404).json({error:'Script not found'});db.data.aiCallScripts.splice(i,1);db.save();res.json({ok:true});});
app.post('/api/owner/ai-calls/queue',authMiddleware,requireOwner,(req,res)=>{ensureAutomationData();const ids=Array.isArray(req.body.contactIds)?req.body.contactIds:[];const scriptId=String(req.body.scriptId||'');const script=db.data.aiCallScripts.find(s=>s.id===scriptId&&s.enabled);if(!script)return res.status(400).json({error:'Select an enabled AI call script'});const selected=db.data.marketingContacts.filter(c=>ids.includes(c.id)&&c.optIn);const jobs=[];for(const c of selected){const job={id:uuidv4(),ownerId:req.user.id,contactId:c.id,phone:c.phone,name:c.name,scriptId:script.id,script:script.script,status:'queued',provider:'not_configured',createdAt:Date.now(),attempts:0};db.data.aiCallJobs.push(job);jobs.push(job);}db.save();audit(req.user.id,'ai_calls.queued',{count:jobs.length,scriptId});res.json({queued:jobs.length,jobs});});
app.get('/api/owner/ai-calls/jobs',authMiddleware,requireOwner,(req,res)=>{ensureAutomationData();res.json({jobs:db.data.aiCallJobs.slice(-500).reverse()});});
app.post('/api/owner/ai-calls/auto-queue',authMiddleware,requireOwner,(req,res)=>{ensureAutomationData();const enabled=db.data.aiCallScripts.filter(s=>s.enabled);const byStatus=new Map(enabled.map(s=>[s.matchStatus,s]));const candidates=db.data.marketingContacts.filter(c=>c.optIn).filter(c=>!db.data.aiCallJobs.some(j=>j.contactId===c.id&&['queued','running','completed'].includes(j.status)));let queued=0;for(const c of candidates){const s=byStatus.get(classifyContact(c));if(!s)continue;db.data.aiCallJobs.push({id:uuidv4(),ownerId:req.user.id,contactId:c.id,phone:c.phone,name:c.name,scriptId:s.id,script:s.script,status:'queued',provider:'not_configured',createdAt:Date.now(),attempts:0});queued++;}db.save();audit(req.user.id,'ai_calls.auto_queued',{queued});res.json({queued});});
app.post('/api/owner/ai-calls/:id/run',authMiddleware,requireOwner,(req,res)=>{ensureAutomationData();const j=db.data.aiCallJobs.find(x=>x.id===req.params.id);if(!j)return res.status(404).json({error:'Call job not found'});j.status='failed';j.provider='not_configured';j.error='AI voice/telephony provider is not configured. Configure an approved provider before placing real calls.';j.updatedAt=Date.now();db.save();audit(req.user.id,'ai_call.blocked_provider_missing',{jobId:j.id});res.status(409).json({error:j.error,job:j});});
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
function dispatchInternalCampaign(campaign){
  const contacts=db.data.marketingContacts.filter(c=>c.ownerId===campaign.ownerId && c.optIn && (campaign.group==='All' || c.group===campaign.group || campaign.group===classifyContact(c)));
  let sent=0, skipped=0;
  for(const c of contacts){
    const recipient=userByPhone(c.phone);
    if(!recipient || recipient.id===campaign.ownerId){ skipped++; continue; }
    const owner=campaign.ownerId;
    const chat=getOrCreateDirectChat(owner,recipient.id);
    const text=String(campaign.message||'').replace(/\{name\}/gi,c.name||recipient.name||'Customer');
    const m={id:uuidv4(),chatId:chat.id,senderId:owner,text:text.slice(0,5000),mediaUrl:campaign.mediaUrl||null,mediaType:campaign.mediaType||null,replyTo:null,reactions:{},edited:false,createdAt:Date.now(),deliveredTo:[owner],readBy:[owner],deletedFor:[]};
    db.data.messages.push(m); io.to(chat.id).emit('message:new',m); io.to(`user:${recipient.id}`).emit('campaign:message',{campaignId:campaign.id,message:m}); sent++;
  }
  campaign.stats={...(campaign.stats||{}),total:contacts.length,queued:0,sent,delivered:sent,read:0,failed:0,replies:0,skipped};
  campaign.status='completed'; campaign.mode='IN_APP'; campaign.completedAt=Date.now(); db.save();
  audit(campaign.ownerId,'campaign.internal_broadcast_completed',{campaignId:campaign.id,sent,skipped,total:contacts.length});
  return {sent,skipped,total:contacts.length};
}
app.get('/api/business/users',authMiddleware,ownerOrBusinessManager,(req,res)=>{
  res.json({users:db.data.users.map(u=>({id:u.id,name:u.name,username:u.username,phone:u.phone,role:u.role||'user',permissions:u.permissions||{}}))});
});
app.patch('/api/business/users/:id',authMiddleware,requireOwner,(req,res)=>{
  const u=db.data.users.find(x=>x.id===req.params.id); if(!u) return res.status(404).json({error:'User not found'});
  if(u.id===req.user.id && req.body.role && req.body.role!=='owner') return res.status(400).json({error:'Owner cannot demote self'});
  const role=String(req.body.role||u.role||'user').toLowerCase(); if(!['owner','admin','manager','user'].includes(role)) return res.status(400).json({error:'Invalid role'});
  if(u.id!==req.user.id) u.role=role;
  if(req.body.permissions && typeof req.body.permissions==='object') u.permissions=req.body.permissions;
  db.save(); audit(req.user.id,'user.role_updated',{userId:u.id,role:u.role}); res.json({user:publicUser(u)});
});
app.post('/api/marketing/campaigns/:id/send-internal',authMiddleware,ownerOrBusinessManager,(req,res)=>{
  marketingData(); const c=db.data.campaigns.find(x=>x.id===req.params.id&&x.ownerId===req.user.id); if(!c) return res.status(404).json({error:'Campaign not found'});
  if(c.status==='completed') return res.status(409).json({error:'Campaign already completed'});
  const result=dispatchInternalCampaign(c); res.json({campaign:c,result});
});

// ===================== WEBRTC CALL SIGNALING =====================
function validCallChat(userId, chatId, targetUserId){
  const chat=db.data.chats.find(c=>c.id===chatId);
  return !!(chat && chat.memberIds.includes(userId) && chat.memberIds.includes(targetUserId));
}
// SOCKETS
io.use((socket,next)=>{try{const token=socket.handshake.auth?.token;const p=jwt.verify(token||'',JWT_SECRET,{issuer:'subharambhindia',audience:'subharambhindia-app'});if(!db.data.users.some(u=>u.id===p.userId))return next(new Error('Invalid session'));socket.userId=p.userId;next();}catch{next(new Error('Invalid or expired token'));}});
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
server.listen(PORT,()=>console.log(`\n SubhArambhIndia v2 running at http://localhost:${PORT}\n Demo mode: ${DEMO_MODE}\n`));

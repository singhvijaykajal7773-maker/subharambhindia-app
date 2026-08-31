// Lightweight file-based JSON database.
// Demo-scale storage: fine for local/demo use. Swap for Postgres/Mongo in production.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Ensure the data directory exists on fresh deployments.
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_DATA = {
  users: [],       // { id, name, phone, username, passwordHash, about, avatar, createdAt }
  chats: [],        // { id, type: 'direct'|'group', memberIds: [], name, description, avatar, adminIds: [], createdAt }
  messages: [],      // { id, chatId, senderId, text, mediaUrl, mediaType, replyTo, reactions: {}, createdAt, readBy: [], deliveredTo: [] }
  statuses: [],      // { id, userId, type: 'text'|'photo', content, mediaUrl, createdAt, viewers: [] }
  sessions: [],      // { id, userId, createdAt, userAgent }
  aiCallScripts: [], // owner-configured scripts/rules
  aiCallJobs: []      // queued AI call jobs and outcomes
};

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    // ensure all keys exist (in case of older db.json)
    return { ...DEFAULT_DATA, ...parsed };
  } catch (err) {
    console.error('Failed to read db.json, reinitializing:', err.message);
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

let cache = loadDb();
let saveTimer = null;

function persist() {
  // debounce writes slightly so rapid-fire messages don't hammer the disk
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE, JSON.stringify(cache, null, 2));
  }, 50);
}

function persistNow() {
  if (saveTimer) clearTimeout(saveTimer);
  fs.writeFileSync(DB_FILE, JSON.stringify(cache, null, 2));
}

module.exports = {
  get data() {
    return cache;
  },
  save: persist,
  saveNow: persistNow
};

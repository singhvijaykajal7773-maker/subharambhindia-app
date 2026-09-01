require('dotenv').config();
const db = require('../db');
(async () => {
  try {
    await db.ready;
    if (!db.isPostgres) throw new Error('DATABASE_URL is required for PostgreSQL migration.');
    await db.saveNow();
    console.log('Migration complete. PostgreSQL contains the application collections.');
    process.exit(0);
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  }
})();

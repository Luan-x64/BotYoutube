
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      url TEXT,
      user_name TEXT,
      username TEXT,
      chat_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

function saveDownload(data) {
  const stmt = db.prepare(`
    INSERT INTO downloads (title, url, user_name, username, chat_id)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(data.title, data.url, data.user_name, data.username, data.chat_id);
  stmt.finalize();
}

function findDownloadByUrl(url, chat_id) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT title, url FROM downloads WHERE url = ? AND chat_id = ? ORDER BY created_at DESC LIMIT 1`,
      [url, String(chat_id)],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

module.exports = { db, saveDownload, findDownloadByUrl };
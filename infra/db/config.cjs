const { readFileSync } = require('node:fs');

exports.connectionOptions = function connectionOptions() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  const file = process.env.DB_PASSWORD_FILE;
  return file ? { password: readFileSync(file, 'utf8').trim() } : {};
};

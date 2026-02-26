#!/usr/bin/env node
/**
 * iCxiFi Restore Script
 * Restores MongoDB from a backup folder.
 * Run: node scripts/restore.js backups/backup-2026-02-18T12-30-00
 * Or: node scripts/restore.js  (uses latest backup)
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

async function restore() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGO_URI not set in .env');
    process.exit(1);
  }

  const backupsDir = path.join(__dirname, '..', 'backups');
  let backupDir = process.argv[2];

  if (!backupDir) {
    // Use latest backup
    if (!fs.existsSync(backupsDir)) {
      console.error('No backups folder found.');
      process.exit(1);
    }
    const dirs = fs.readdirSync(backupsDir)
      .filter((d) => d.startsWith('backup-') && fs.statSync(path.join(backupsDir, d)).isDirectory())
      .sort()
      .reverse();
    if (dirs.length === 0) {
      console.error('No backup folders found.');
      process.exit(1);
    }
    backupDir = path.join(backupsDir, dirs[0]);
  } else if (!path.isAbsolute(backupDir)) {
    backupDir = path.join(__dirname, '..', backupDir);
  }

  if (!fs.existsSync(backupDir)) {
    console.error('Backup folder not found:', backupDir);
    process.exit(1);
  }

  console.log('iCxiFi Restore');
  console.log('=============');
  console.log('From:', backupDir);

  try {
    await mongoose.connect(mongoUri);
    const db = mongoose.connection.db;

    const jsonFiles = fs.readdirSync(backupDir).filter((f) => f.endsWith('.json') && f !== 'manifest.json');

    for (const file of jsonFiles) {
      const collName = file.replace('.json', '');
      const filePath = path.join(backupDir, file);
      const docs = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (docs.length === 0) continue;

      await db.collection(collName).deleteMany({});
      await db.collection(collName).insertMany(docs);
      console.log('  -', collName, '(' + docs.length + ' documents)');
    }

    console.log('');
    console.log('Restore complete.');
  } catch (err) {
    console.error('Restore failed:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

restore();

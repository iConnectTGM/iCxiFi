#!/usr/bin/env node
/**
 * iCxiFi Backup Script
 * Backs up MongoDB data to JSON files before making changes.
 * Run: node scripts/backup.js
 * Or: npm run backup
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const BACKUP_ROOT = path.join(__dirname, '..', 'backups');

async function backup() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error('ERROR: MONGO_URI not set in .env');
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(BACKUP_ROOT, `backup-${timestamp}`);
  fs.mkdirSync(backupDir, { recursive: true });

  console.log('iCxiFi Backup');
  console.log('============');
  console.log('Backup folder:', backupDir);

  try {
    await mongoose.connect(mongoUri);
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();

    for (const { name } of collections) {
      if (name.startsWith('system.')) continue;
      const docs = await db.collection(name).find({}).toArray();
      const outPath = path.join(backupDir, `${name}.json`);
      fs.writeFileSync(outPath, JSON.stringify(docs, null, 2), 'utf8');
      console.log('  -', name, '(' + docs.length + ' documents)');
    }

    // Copy .env (without overwriting if already exists from previous backup)
    const envSrc = path.join(__dirname, '..', '.env');
    const envDst = path.join(backupDir, '.env.backup');
    if (fs.existsSync(envSrc)) {
      fs.copyFileSync(envSrc, envDst);
      console.log('  - .env (saved as .env.backup)');
    } else {
      console.log('  - .env not found, skip');
    }

    // Write manifest
    const manifest = {
      timestamp: new Date().toISOString(),
      collections: collections.map((c) => c.name).filter((n) => !n.startsWith('system.')),
      note: 'Run "node scripts/restore.js" from backup folder to restore. Or copy backups/backup-XXX/ back to project.'
    };
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    console.log('');
    console.log('Backup complete.');
    console.log('To restore: node scripts/restore.js backups/backup-' + timestamp);
  } catch (err) {
    console.error('Backup failed:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

backup();

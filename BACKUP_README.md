# iCxiFi Backup Guide

Create a backup **before** implementing new features (e.g. user auth, multi-tenant).

---

## Quick Backup (before any big change)

```powershell
cd D:\iCxiFi\api
npm run backup
```

This will:
- Export all MongoDB collections to `api/backups/backup-YYYY-MM-DDTHH-MM-SS/`
- Copy `.env` to the backup folder (as `.env.backup`)
- Create a `manifest.json` with backup metadata

---

## What Gets Backed Up

| Item | Location |
|------|----------|
| MongoDB data (routers, vouchers, sessions, etc.) | `backups/backup-XXX/*.json` |
| Environment config | `backups/backup-XXX/.env.backup` |
| Codebase | **Manual** – see below |

---

## Code Backup (recommended)

The script backs up **database only**. For full safety, also back up your code:

### Option A: Git (recommended)
```powershell
cd D:\iCxiFi
git init
git add .
git commit -m "Backup before multi-tenant implementation"
```

### Option B: Copy folder
```powershell
xcopy D:\iCxiFi D:\iCxiFi-backup-2026-02-18 /E /I /H /EXCLUDE:exclude.txt
```
Create `exclude.txt` with: `node_modules` to skip that folder (large).

---

## Restore

If something goes wrong:

```powershell
cd D:\iCxiFi\api
npm run restore
# Or specify a backup: node scripts/restore.js backups/backup-2026-02-18T12-30-00
```

To restore `.env` from backup:
```powershell
copy api\backups\backup-XXX\.env.backup api\.env
```

---

## Backup Before Implementation Checklist

- [ ] Run `npm run backup` in `api/`
- [ ] Git commit or copy project folder
- [ ] Keep backup somewhere safe (external drive or cloud)
- [ ] Then proceed with implementation

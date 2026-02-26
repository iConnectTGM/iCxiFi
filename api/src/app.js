const path = require('path');
const express = require('express');
const cors = require('cors');

const healthRoutes = require('./routes/health.routes');
const authRoutes = require('./routes/auth.routes');
const routerBindRoutes = require('./routes/routerBind.routes');
const { routerActivateRoutes } = require('./routes/routerActivate.routes');
const routerProtectedRoutes = require('./routes/routerProtected.routes');
const adminRoutes = require('./routes/admin.routes');
const clientRoutes = require('./routes/client.routes');

const app = express();

app.use(cors());
app.use(express.json());

// Phase 7: Admin dashboard (static) + logo from project LOGO folder
app.use('/admin/logo', express.static(path.join(__dirname, '../../LOGO')));
app.use('/admin', express.static(path.join(__dirname, '../public/admin')));
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin/index.html'));
});

// Dashboard (client) - same base, different section
app.use('/dashboard/logo', express.static(path.join(__dirname, '../../LOGO')));
app.use('/dashboard', express.static(path.join(__dirname, '../public/dashboard')));
app.get('/dashboard', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard/index.html'));
});

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/router', routerBindRoutes);
app.use('/api/router', routerActivateRoutes);
app.use('/api/router', routerProtectedRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/client', clientRoutes);

// 404
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// Global error handler (for async route errors not caught)
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'Server error' });
});

module.exports = app;

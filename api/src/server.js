const path = require('path');
const dotenv = require('dotenv');
const app = require('./app');
const { connectDb } = require('./db');

// Load .env from api/ folder (works regardless of cwd)
dotenv.config({ path: path.join(__dirname, '../.env') });

const port = process.env.PORT || 4000;

connectDb()
  .then(() => {
    app.listen(port, '0.0.0.0', () => {
      // eslint-disable-next-line no-console
      console.log(`API listening on port ${port}`);
    });
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start server:', error);
    process.exit(1);
  });

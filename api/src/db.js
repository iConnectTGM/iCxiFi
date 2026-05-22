const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

async function connectDb() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error('MONGO_URI is not set');
  }

  await mongoose.connect(mongoUri);
}

module.exports = { connectDb };

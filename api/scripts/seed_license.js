const path = require("path");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const License = require("../src/models/License");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const doc = await License.findOneAndUpdate(
    { key: "LIC-STARTER-0001" },
    {
      $set: { seatsRouters: 5, isActive: true, expiresAt: null },
      $setOnInsert: { key: "LIC-STARTER-0001" }
    },
    { upsert: true, new: true }
  );

  console.log(JSON.stringify(doc, null, 2));
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});

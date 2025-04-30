// sse-server.js
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import IORedis from "ioredis";

// Create Express app
const app = express();

// Only allow requests from your production domain
const allowedOrigins = [
  "https://wispi.art",
  "https://www.wispi.art",
];

app.use(
  cors({
    origin: (incomingOrigin, callback) => {
      // allow requests with no origin (e.g. mobile apps, curl)
      if (!incomingOrigin) return callback(null, true);
      if (allowedOrigins.includes(incomingOrigin)) {
        return callback(null, true);
      }
      return callback(
        new Error(`Origin ${incomingOrigin} not allowed by CORS`)
      );
    },
  })
);

// -----------------------
// Redis setup (ioredis)
// -----------------------
const redisUrl = process.env.UPSTASH_REDIS_REDIS_URL;
const redisToken = process.env.UPSTASH_REDIS_REDIS_TOKEN;

const redis = new IORedis(redisUrl, {
  password: redisToken,
  tls: {}, // required by Upstash
});

// Enable key‐space notifications for expired/set events
try {
  const reply = await redis.config("SET", "notify-keyspace-events", "Ex");
  console.log("CONFIG SET reply:", reply);
} catch (err) {
  console.warn("Could not CONFIG SET notify-keyspace-events:", err.message);
}

// -----------------------
// MongoDB setup
// -----------------------
const mongoUri = process.env.MONGO_URI;
const mongoClient = new MongoClient(mongoUri);
await mongoClient.connect();
const podMeta = mongoClient
  .db("podActivityDB")
  .collection("podMetadata");

// -----------------------
// SSE client management
// -----------------------
const clients = new Map(); // Map<subscriptionId, Set<response>>

// Heartbeat every 25s to keep connections alive
setInterval(() => {
  for (const subs of clients.values()) {
    for (const res of subs) {
      res.write(`: heartbeat\n\n`);
    }
  }
}, 25_000);

// SSE endpoint
app.get("/events", (req, res) => {
  const subId = req.query.subscriptionId;
  if (!subId) {
    return res.status(400).end("Missing subscriptionId");
  }

  console.log(`✅ SSE client connected for subscriptionId=${subId}`);

  // Set headers for SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");

  // Register this client
  if (!clients.has(subId)) {
    clients.set(subId, new Set());
  }
  clients.get(subId).add(res);

  // Clean up on disconnect
  req.on("close", () => {
    clients.get(subId).delete(res);
    res.end();
  });
});

// -----------------------
// Redis keyspace listener
// -----------------------
await redis.psubscribe("__keyspace@0__:ready:*");

redis.on("pmessage", async (_pattern, channel, msg) => {
  if (msg !== "set") return;

  const podId = channel.split(":")[1];
  console.log("podId:", podId)

  const doc = await podMeta.findOne({ podId });
  if (!doc) return;

  const subs = clients.get(doc.subscriptionId);
  if (!subs) return;

  const payload = JSON.stringify({ podId, event: "ready" });
  for (const res of subs) {
    res.write(`event: ready\n`);
    res.write(`data: ${payload}\n\n`);
  }
});

// -----------------------
// Start server
// -----------------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`SSE server listening on port ${PORT}`);
});

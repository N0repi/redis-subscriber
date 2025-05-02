// sse-server.js
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import IORedis from "ioredis";

const app = express();

// ——————————————————————————————————————————————————
// Middleware
// ——————————————————————————————————————————————————
app.use(cors({
  origin: (incomingOrigin, callback) => {
    if (!incomingOrigin) return callback(null, true);
    if (["https://wispi.art","https://www.wispi.art"].includes(incomingOrigin)) {
      return callback(null, true);
    }
    return callback(new Error(`Origin ${incomingOrigin} not allowed by CORS`));
  }
}));

// We need JSON body‐parsing for our new /notify-ready hook
app.use(express.json());

// ——————————————————————————————————————————————————
// Redis setup (ioredis)
// ——————————————————————————————————————————————————
const redis = new IORedis(process.env.UPSTASH_REDIS_REDIS_URL, {
  password: process.env.UPSTASH_REDIS_REDIS_TOKEN,
  tls: {}
});

// (optional) configure keyspace notifications
try {
  await redis.config("SET", "notify-keyspace-events", "Ex");
} catch (err) {
  console.warn("Could not CONFIG SET notify-keyspace-events:", err.message);
}

// ——————————————————————————————————————————————————
// MongoDB setup
// ——————————————————————————————————————————————————
const mongoClient = new MongoClient(process.env.MONGO_URI);
await mongoClient.connect();
const podMeta = mongoClient.db("podActivityDB").collection("podMetadata");

// ——————————————————————————————————————————————————
// SSE client registry
// ——————————————————————————————————————————————————
const clients = new Map();          // subscriptionId → Set<response>

// heartbeat to keep connections alive
setInterval(() => {
  for (const subs of clients.values()) {
    for (const res of subs) {
      res.write(`: heartbeat\n\n`);
    }
  }
}, 25_000);

// ——————————————————————————————————————————————————
// 1) SSE endpoint
// ——————————————————————————————————————————————————
app.get("/events", (req, res) => {
  const subId = req.query.subscriptionId;
  if (!subId) return res.status(400).end("Missing subscriptionId");

  console.log(`✅ SSE client connected for subscriptionId=${subId}`);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");

  if (!clients.has(subId)) clients.set(subId, new Set());
  clients.get(subId).add(res);

  req.on("close", () => {
    clients.get(subId).delete(res);
    res.end();
  });
});

// ——————————————————————————————————————————————————
// 2) NEW: HTTP hook to broadcast “ready” to SSE clients
// ——————————————————————————————————————————————————
app.post(
  "/notify-ready",
  async (req, res) => {
    const { podId } = req.body;
    if (!podId) return res.status(400).json({ error: "Missing podId" });

    console.log("🔔 /notify-ready for podId=", podId);
    const doc = await podMeta.findOne({ podId });
    if (doc) {
      const subs = clients.get(doc.subscriptionId) || new Set();
      const payload = JSON.stringify({ podId, event: "ready" });
      for (const client of subs) {
        client.write(`event: ready\n`);
        client.write(`data: ${payload}\n\n`);
      }
    }

    return res.status(200).json({ success: true });
  }
);

// ——————————————————————————————————————————————————
// 3) fallback: key‐space notifications listener (optional)
// ——————————————————————————————————————————————————
await redis.psubscribe("__keyspace@0__:ready:*");
redis.on("pmessage", async (_pattern, channel, msg) => {
  if (msg !== "set") return;
  const podId = channel.split(":")[2];
  console.log("💥 keyspace fired for podId=", podId);

  const doc = await podMeta.findOne({ podId });
  if (!doc) return;
  const subs = clients.get(doc.subscriptionId) || new Set();
  const payload = JSON.stringify({ podId, event: "ready" });
  for (const client of subs) {
    client.write(`event: ready\n`);
    client.write(`data: ${payload}\n\n`);
  }
});

// ——————————————————————————————————————————————————
// Start server
// ——————————————————————————————————————————————————
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`SSE server listening on port ${PORT}`);
});

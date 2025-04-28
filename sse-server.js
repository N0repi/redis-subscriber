// sse-server.js
import express from "express";
import cors  from "cors";
import { Redis } from "@upstash/redis";
import { MongoClient } from "mongodb";

const app = express();

// Allow all
// app.use(cors());

// Allow only production domain
app.use(
  cors({
    origin: "https://wispi.art",
  })
);


// Redis & Mongo setup...
const redis = new Redis({ url: process.env.UPSTASH_REDIS_REDIS_URL, token: process.env.UPSTASH_REDIS_REDIS_TOKEN });
await redis.config("SET", "notify-keyspace-events", "Ex");
const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const podMeta = client.db("podActivityDB").collection("podMetadata");

// track SSE clients per subscription
const clients = new Map(); // Map<subscriptionId, Set<res>>

// Send a comment every 25s to keep the connection alive
setInterval(() => {
  for (const subs of clients.values()) {
    for (const res of subs) {
      res.write(`: heartbeat\n\n`);
    }
  }
}, 25000);

app.get("/events", (req, res) => {
  const subId = req.query.subscriptionId;
  if (!subId) return res.status(400).end("Missing subscriptionId");

  res.writeHead(200, {
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache",
    Connection:          "keep-alive",
  });
  res.write("\n");

  if (!clients.has(subId)) clients.set(subId, new Set());
  clients.get(subId).add(res);

  req.on("close", () => {
    // remove this client and end the response
    clients.get(subId).delete(res);
    res.end();
  });
});

await redis.psubscribe("__keyspace@0__:ready:*");
redis.on("pmessage", async (_pattern, channel, msg) => {
  if (msg !== "set") return;
  const podId = channel.split(":")[1];

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

app.listen(4000, () => console.log("SSE server listening on :4000"));

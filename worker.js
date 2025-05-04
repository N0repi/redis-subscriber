// worker.js
import IORedis from "ioredis";
import fetch from "node-fetch";
import fetchGpuUtilization from "./fetchGpuUtilization.js";

const redisUrl = process.env.UPSTASH_REDIS_REDIS_URL;
const redisToken = process.env.UPSTASH_REDIS_REDIS_TOKEN;
const RUNPOD_API_KEY = process.env.POD_KEY;


const EXTEND_TTL_SEC     = 1 * 3600; // re‐arm TTL if busy
const GPU_IDLE_THRESHOLD = 5;        // %

if (!redisUrl || !redisToken || !RUNPOD_API_KEY) {
  console.error("❌ Missing required env vars");
  process.exit(1);
}

// ── clients ───────────────────────────────────────────────────────────────
const redis = new IORedis(redisUrl, { password: redisToken, tls: {} });
const sub   = new IORedis(redisUrl, { password: redisToken, tls: {} });

redis.on("ready", () => console.log("▶️ Redis client ready"));
redis.on("error", err => console.error("❌ Redis error:", err));
sub.on("ready",   () => console.log("▶️ Subscriber ready"));
sub.on("error",   err => console.error("❌ Subscriber error:", err));

// ── subscribe to expired‐key events ────────────────────────────────────────
// (Upstash must already have notify-keyspace-events=Ex in its console)
sub.psubscribe("__keyevent@0__:expired", (err, count) => {
  if (err) console.error("❌ PSUBSCRIBE error:", err);
  else     console.log(`✅ PSUBSCRIBE OK; subscribed to ${count} patterns`);
});

sub.on("pmessage", async (_pattern, channel, key) => {
  // We get: channel="__keyevent@0__:expired", key="shutdown:<podId>"
  if (!key.startsWith("shutdown:")) return;
  const podId = key.split(":")[1];
  console.log(`🔔 TTL expired for pod ${podId}`);

  // 1) Check GPU utilization
  let util = 0;
  try {
    util = await fetchGpuUtilization(podId);
  } catch (err) {
    console.warn(`⚠️ GPU check failed for ${podId}, assuming busy`, err);
    util = GPU_IDLE_THRESHOLD + 1;
  }
  console.log(`   → pod ${podId} util=${util}%`);

  // 2) Still busy? re-arm the timer
  if (util > GPU_IDLE_THRESHOLD) {
    console.log(`   ↩️ Pod busy; re-arming TTL (${EXTEND_TTL_SEC}s)`);
    await redis.setex(`shutdown:${podId}`, EXTEND_TTL_SEC, "1");
    return;
  }

  // 3) Otherwise stop it
  console.log(`   ⚡️ Pod idle; issuing StopPod mutation…`);
  const graphql = {
    query: `
      mutation {
        podStop(input: {podId: "${podId}"}) {
          id
          desiredStatus
        }
      }
    `,
  };
  try {
    const resp = await fetch("https://api.runpod.io/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RUNPOD_API_KEY}`,
      },
      body: JSON.stringify(graphql),
    });
    const body = await resp.json();
    if (body.data?.podStop) {
      console.log(
        `✅ Pod ${body.data.podStop.id} stop issued → ${body.data.podStop.desiredStatus}`
      );
    } else {
      console.error(`❌ podStop error for ${podId}:`, body.errors || body);
    }
  } catch (e) {
    console.error(`❌ Network/parsing error stopping ${podId}:`, e);
  }
});

// ── fallback poll (in case Upstash ignored the config) ─────────────────────
// Every minute, scan for any shutdown:* keys with TTL<=0 and handle them:
setInterval(async () => {
  const keys = await redis.keys("shutdown:*");
  for (const k of keys) {
    const ttl = await redis.ttl(k);
    if (ttl <= 0) {
      console.log(`⏱ Fallback: TTL<=0 for ${k}, emitting synthetic event`);
      sub.emit("pmessage", "__keyevent@0__:expired", "__keyevent@0__:expired", k);
    }
  }
}, 60_000);

// worker.js
import IORedis from "ioredis";
import fetch from "node-fetch";
import fetchGpuUtilization from "./fetchGpuUtilization.js";

const {
  UPSTASH_REDIS_REDIS_URL: redisUrl,
  UPSTASH_REDIS_REDIS_TOKEN: redisToken,
  POD_KEY: RUNPOD_API_KEY,
} = process.env;

if (!redisUrl || !redisToken || !RUNPOD_API_KEY) {
  console.error("❌ Missing required env vars");
  process.exit(1);
}

// ── CONFIG ───────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 5_000;   // run every 5s in dev
const GPU_IDLE_THRESHOLD = 5;     // %
const EXTEND_TTL_SEC     = 15;    // re-arm TTL by 15s if busy

// ── REDIS CLIENT ─────────────────────────────────────────────────────────
const redis = new IORedis(redisUrl, { password: redisToken, tls: {} });

redis.on("ready", () => console.log("▶️ Redis client ready"));
redis.on("error", err => console.error("❌ Redis error:", err));

// ── SCAN LOOP ────────────────────────────────────────────────────────────
async function scanForExpiredPods() {
  console.log("🔍 scanForExpiredPods()");
  try {
    const keys = await redis.keys("shutdown:*");
    console.log(`   🔑 found keys: ${keys.join(", ") || "<none>"}`);
    for (const key of keys) {
      const ttl = await redis.ttl(key);
      console.log(`     ⏱ TTL(${key}) = ${ttl}s`);
      if (ttl <= 0) {
        const podId = key.split(":")[1];
        // remove key so we only stop once
        await redis.del(key);
        console.log(`   🛑 shutdown:${podId} expired → handling`);
        await handlePodShutdown(podId);
      }
    }
  } catch (err) {
    console.error("❌ scanForExpiredPods error:", err);
  }
}

async function handlePodShutdown(podId) {
  // 1) check GPU/memory
  let util = 0;
  try {
    util = await fetchGpuUtilization(podId);
  } catch (err) {
    console.warn(`⚠️ GPU check failed, treating as busy`, err);
    util = GPU_IDLE_THRESHOLD + 1;
  }
  console.log(`   → pod ${podId} util = ${util}%`);

  // 2) re-arm if busy
  if (util > GPU_IDLE_THRESHOLD) {
    console.log(`   ↩️ Pod busy; re-arming shutdown:${podId} TTL ${EXTEND_TTL_SEC}s`);
    await redis.set(`shutdown:${podId}`, "1", "EX", EXTEND_TTL_SEC);
    return;
  }

  // 3) otherwise issue podStop
  console.log(`   ⚡️ Pod idle; issuing podStop(${podId})…`);
  const graphql = {
    query: `
      mutation {
        podStop(input: { podId: "${podId}" }) {
          id
          desiredStatus
        }
      }`,
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
        `✅ podStop ${body.data.podStop.id} → ${body.data.podStop.desiredStatus}`
      );
    } else {
      console.error(`❌ podStop error for ${podId}:`, body.errors || body);
    }
  } catch (e) {
    console.error(`❌ Network/parsing error stopping ${podId}:`, e);
  }
}

// ── START POLL ───────────────────────────────────────────────────────────
console.log(`▶️ Starting poll loop every ${POLL_INTERVAL_MS/1000}s`);
setInterval(scanForExpiredPods, POLL_INTERVAL_MS);
// run once immediately
scanForExpiredPods();

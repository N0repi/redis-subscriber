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

// 1) Redis client (no need for pub/sub at all)
const redis = new IORedis(redisUrl, {
  password: redisToken,
  tls: {},
});

redis.on("ready", () => console.log("▶️ Redis ready"));
redis.on("error", (err) => console.error("❌ Redis error:", err));

// 2) How often to poll
const POLL_INTERVAL_MS = 15_000;
const GPU_IDLE_THRESHOLD = 5;     // %
const EXTEND_TTL_SEC     = 3600;  // re-arm TTL if busy

// 3) Main scan loop
async function scanForExpiredPods() {
  try {
    // Fetch all shutdown keys
    const keys = await redis.keys("shutdown:*");
    for (const key of keys) {
      const ttl = await redis.ttl(key);
      if (ttl <= 0) {
        // TTL expired → handle pod shutdown
        const podId = key.split(":")[1];
        console.log(`⏱ Poll: shutdown key expired for pod ${podId}`);

        // 3a) Check GPU util
        let util = 0;
        try {
          util = await fetchGpuUtilization(podId);
        } catch (err) {
          console.warn(`⚠️ GPU check failed for ${podId}, assuming busy`, err);
          util = GPU_IDLE_THRESHOLD + 1;
        }
        console.log(`   → pod ${podId} GPU/mem util=${util}%`);

        // 3b) If still busy, re-arm TTL
        if (util > GPU_IDLE_THRESHOLD) {
          console.log(`   ↩️ Pod busy; re-arming shutdown:${podId} TTL for ${EXTEND_TTL_SEC}s`);
          await redis.setex(`shutdown:${podId}`, EXTEND_TTL_SEC, "1");
          continue;
        }

        // 3c) Otherwise, issue podStop mutation
        console.log(`   ⚡️ Pod idle; issuing podStop(${podId})…`);
        const graphql = {
          query: `
            mutation {
              podStop(input: {podId: "${podId}"}) {
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
    }
  } catch (err) {
    console.error("❌ scanForExpiredPods error:", err);
  }
}

// 4) Kick off the loop
console.log(`▶️ Starting poll loop every ${POLL_INTERVAL_MS/1000}s`);
setInterval(scanForExpiredPods, POLL_INTERVAL_MS);

// Also run one immediately
scanForExpiredPods();

// worker.js
import IORedis from "ioredis";
import fetch from "node-fetch";
import fetchGpuUtilization from "./fetchGpuUtilization.js";

const {
  UPSTASH_REDIS_REDIS_URL: redisUrl,
  UPSTASH_REDIS_REDIS_TOKEN: redisToken,
  POD_KEY: RUNPOD_API_KEY,
} = process.env;

const EXTEND_TTL_SEC      = 1 * 3600; // re-arm TTL if busy
const GPU_IDLE_THRESHOLD  = 5;        // %

if (!redisUrl || !redisToken || !RUNPOD_API_KEY) {
  console.error("❌ Missing required env vars");
  process.exit(1);
}

const redis = new IORedis(redisUrl, { password: redisToken, tls: {} });
const sub   = new IORedis(redisUrl, { password: redisToken, tls: {} });

redis.on("ready", () => console.log("▶️ Redis client ready"));
redis.on("error", err => console.error("❌ Redis error:", err));
sub.on("ready",   () => console.log("▶️ Subscriber ready"));
sub.on("error",   err => console.error("❌ Subscriber error:", err));

;(async () => {
  // 1) Make sure keyspace notifications for expired events are on:
  try {
    await redis.config("SET", "notify-keyspace-events", "Kx");
    const [, flags] = await redis.config("GET", "notify-keyspace-events");
    console.log("CONFIG GET notify-keyspace-events →", flags);
  } catch (err) {
    console.error("❌ CONFIG SET failed:", err);
  }

  // 2) Subscribe to the keyspace channel for shutdown:<podId> → expired
  sub.psubscribe("__keyspace@0__:shutdown:*", (err, count) => {
    if (err) console.error("❌ PSUBSCRIBE error:", err);
    else     console.log(`✅ PSUBSCRIBE OK; patterns=${count}`);
  });

  // 3) Handle those expired notifications
  sub.on("pmessage", async (_pattern, channel, message) => {
    // channel looks like "__keyspace@0__:shutdown:3ckrohra6uukmj", message is "expired"
    if (message !== "expired") return;
    const podId = channel.split(":")[2];
    console.log(`🔔 TTL expired for pod ${podId}`);

    // check GPU utilization
    let util = 0;
    try {
      util = await fetchGpuUtilization(podId);
    } catch (err) {
      console.warn(`⚠️ GPU check failed for ${podId}, assuming busy`, err);
      util = GPU_IDLE_THRESHOLD + 1;
    }
    console.log(`   → pod ${podId} util=${util}%`);

    // still busy? re-arm the TTL
    if (util > GPU_IDLE_THRESHOLD) {
      console.log(`   ↩️ Pod busy; re-arming TTL (${EXTEND_TTL_SEC}s)`);
      await redis.setex(`shutdown:${podId}`, EXTEND_TTL_SEC, "1");
      return;
    }

    // otherwise, really stop it
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
})();

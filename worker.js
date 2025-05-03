// worker.js

import IORedis from "ioredis";
import fetch from "node-fetch";
import fetchGpuUtilization from "./fetchGpuUtilization.js";

// ── CONFIG ───────────────────────────────────────────────────────────────
const {
  UPSTASH_REDIS_REDIS_URL: redisUrl,
  UPSTASH_REDIS_REDIS_TOKEN: redisToken,
  POD_KEY: RUNPOD_API_KEY,
} = process.env;

const EXTEND_TTL_SEC = 1 * 3600; // 1 hour extension
const GPU_IDLE_THRESHOLD = 5;    // percent

if (!redisUrl || !redisToken || !RUNPOD_API_KEY) {
  console.error("❌ Missing required env vars");
  process.exit(1);
}

// ── REDIS CLIENTS ─────────────────────────────────────────────────────────
const redis = new IORedis(redisUrl, { password: redisToken, tls: {} });
const sub   = new IORedis(redisUrl, { password: redisToken, tls: {} });

// ── DIAGNOSTICS ───────────────────────────────────────────────────────────
redis.on("ready", () => console.log("▶️ Redis client ready"));
redis.on("error", err => console.error("❌ Redis client error:", err));
sub.on("ready", () => console.log("▶️ Subscriber ready"));
sub.on("error", err => console.error("❌ Subscriber error:", err));

// ── BOOTSTRAP KEYEVENT NOTIFICATIONS ──────────────────────────────────────
;(async () => {
  try {
    // We want *keyevent* expired → "__keyevent@0__:expired"
    const setReply = await redis.config("SET", "notify-keyspace-events", "Ex");
    console.log("CONFIG SET notify-keyspace-events →", setReply);

    const getReply = await redis.config("GET", "notify-keyspace-events");
    console.log("CONFIG GET notify-keyspace-events →", getReply[1]);
  } catch (err) {
    console.error("❌ CONFIG SET/GET failed:", err);
    // we’ll still try to subscribe, but it may never fire
  }

  // Subscribe to *expired* keyevents:
  sub.psubscribe("__keyevent@0__:expired", (err, count) => {
    if (err) console.error("❌ PSUBSCRIBE error:", err);
    else console.log(`✅ PSUBSCRIBE OK; subscribed to ${count} patterns`);
  });

  // ── HANDLE EXPIRED EVENTS ────────────────────────────────────────────────
  sub.on("pmessage", async (_pattern, _channel, key) => {
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

    // 2) If still busy, re-arm the timer
    if (util > GPU_IDLE_THRESHOLD) {
      console.log(`   ↩️ Pod ${podId} busy; re-arming TTL (${EXTEND_TTL_SEC}s)`);
      await redis.setex(`shutdown:${podId}`, EXTEND_TTL_SEC, "1");
      return;
    }

    // 3) Otherwise actually stop it
    console.log(`   ⚡️ Pod ${podId} idle; issuing stop mutation…`);
    const graphql = {
      query: `
        mutation StopPod($input: PodStopInput!) {
          podStop(input: $input) { id desiredStatus }
        }`,
      variables: { input: { podId } },
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
      const json = await resp.json();
      if (json.data?.podStop) {
        console.log(
          `✅ Pod ${json.data.podStop.id} stop issued → ${json.data.podStop.desiredStatus}`
        );
      } else {
        console.error(
          `❌ podStop error for ${podId}:`,
          json.errors || json
        );
      }
    } catch (e) {
      console.error(`❌ Network/parsing error stopping ${podId}:`, e);
    }
  });
})();

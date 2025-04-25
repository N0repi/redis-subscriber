import IORedis from "ioredis";
import fetch from "node-fetch";

// Use the Redis URL (not the HTTP REST URL)
const redisUrl   = process.env.UPSTASH_REDIS_REDIS_URL;
const redisToken = process.env.UPSTASH_REDIS_REDIS_TOKEN;
const RUNPOD_API_KEY = process.env.POD_KEY;

if (!redisUrl || !redisToken || !RUNPOD_API_KEY) {
  console.error("Missing required env vars");
  process.exit(1);
}

// Connect over TLS to Upstash's Redis port (10000)
const redis = new IORedis(redisUrl, {
  password: redisToken,
  tls: {},
});
const sub = new IORedis(redisUrl, {
  password: redisToken,
  tls: {},
});

// Enable key-expiry events
await redis.config("SET", "notify-keyspace-events", "Ex");
await sub.psubscribe("__keyevent@0__:expired");

sub.on("pmessage", async (_p, _c, key) => {
  if (!key.startsWith("shutdown:")) return;
  const podId = key.split(":")[1];
  console.log(`🔔 TTL expired for pod ${podId}`);

  const graphqlQuery = {
    query: `
      mutation StopPod($input: PodStopInput!) {
        podStop(input: $input) {
          id
          desiredStatus
        }
      }
    `,
    variables: { input: { podId } },
  };

  try {
    const resp = await fetch("https://api.runpod.io/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RUNPOD_API_KEY}`,
      },
      body: JSON.stringify(graphqlQuery),
    });
    const json = await resp.json();
    if (json.data?.podStop) {
      console.log(
        `✅ Pod ${json.data.podStop.id} stop issued → ${json.data.podStop.desiredStatus}`
      );
    } else {
      console.error(`❌ podStop error for ${podId}:`, json.errors || json);
    }
  } catch (e) {
    console.error(`❌ Network/parsing error on podStop for ${podId}:`, e);
  }
});

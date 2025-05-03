// getRunpodInstances.js
const RUNPOD_API_KEY = process.env.POD_KEY;

export default async function getRunpodInstances() {
  const url = "https://api.runpod.io/graphql";
  const headers = {
    Authorization: `Bearer ${RUNPOD_API_KEY}`,
    "Content-Type": "application/json",
  };

  const graphqlQuery = {
    query: `
        query {
          myself {
            pods {
              id
              name
              runtime {
                uptimeInSeconds
                ports {
                  ip
                  isIpPublic
                  privatePort
                  publicPort
                  type
                }
                gpus {
                  id
                  gpuUtilPercent
                  memoryUtilPercent
                }
                container {
                  cpuPercent
                  memoryPercent
                }
              }
            }
          }
        }
        `,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(graphqlQuery),
    });

    if (response.ok) {
      const data = await response.json();
      console.log("Runpod Instances:", data.data.myself.pods);
      return data.data.myself.pods;
    } else {
      console.error("Error fetching instances:", await response.text());
    }
  } catch (error) {
    console.error("API request failed:", error);
  }
}

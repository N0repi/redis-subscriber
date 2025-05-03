// fetchGpuUtilization.js

import getRunpodInstances from "./getRunpodInstances";

export default async function fetchGpuUtilization(podId) {
  try {
    const instances = await getRunpodInstances();
    const pod = instances.find((instance) => instance.id === podId);

    if (!pod) {
      console.log(`Pod ${podId} not found.`);
      return 0; // Treat as idle
    }

    const { runtime } = pod;
    if (!runtime || !runtime.gpus || runtime.gpus.length === 0) {
      console.log(`No GPU data found for Pod: ${podId}`);
      return 0; // Treat as idle
    }

    const gpuUtilization = runtime.gpus[0].gpuUtilPercent;
    const memoryUtilization = runtime.gpus[0].memoryUtilPercent;

    console.log(`Pod: ${podId}`);
    console.log(`GPU Utilization: ${gpuUtilization}%`);
    console.log(`Memory Utilization: ${memoryUtilization}%`);

    return Math.max(gpuUtilization, memoryUtilization);
  } catch (error) {
    console.error("Error in GPU monitoring:", error);
    return 0;
  }
}

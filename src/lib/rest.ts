import type { JobRoomEntry } from "acp-node-v2";

export async function getActiveJobs(
  serverUrl: string,
  wallet: string
): Promise<{ chainId: number; onChainJobId: string }[]> {
  const res = await fetch(`${serverUrl}/jobs?wallet=${wallet}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch active jobs: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    jobs: { chainId: number; onChainJobId: string }[];
  };
  return data.jobs ?? [];
}

export async function getJobHistory(
  serverUrl: string,
  wallet: string,
  chainId: number,
  jobId: string
): Promise<JobRoomEntry[]> {
  const res = await fetch(
    `${serverUrl}/jobs/${chainId}/${jobId}/history?wallet=${wallet}`
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch job history: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { entries: JobRoomEntry[] };
  return data.entries ?? [];
}

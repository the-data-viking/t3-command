// A pull request's detail: read by the Command server through its own host's GitHub login, which
// can read checks for every repo it can see; the agent machine's T3 is asked only if that fails
// (no `gh` on the Command host, or no access). See server/pr-detail.ts.

import { envClient, fetchJson } from "./environment";
import type { PullRequestDetail, ThreadPullRequest } from "./types";

export async function readPrDetail(envId: string, projectId: string, pr: ThreadPullRequest): Promise<PullRequestDetail> {
  const q = new URLSearchParams({ repo: pr.repository, number: String(pr.number), ...(pr.host ? { host: pr.host } : {}) });
  try {
    return await fetchJson<PullRequestDetail>(`/api/pr-detail?${q}`);
  } catch (viaCommand) {
    const client = envClient(envId);
    if (!client) throw viaCommand;
    return client.pullRequestDetail(projectId, pr.repository, pr.number, pr.host);
  }
}

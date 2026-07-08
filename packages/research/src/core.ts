/**
 * Research / Curiosity core — ranks discoveries by the ATLAS constitution's
 * criteria (open-source, self-hostable, has API, free, Docker, MCP). This turns
 * a pile of "things I found" into a prioritized daily report.
 */
export interface Discovery {
  title: string;
  url?: string;
  summary: string;
  tags?: string[];
  openSource?: boolean;
  selfHostable?: boolean;
  hasApi?: boolean;
  free?: boolean;
  docker?: boolean;
  mcp?: boolean;
}

export interface RankedDiscovery extends Discovery {
  score: number;
  reasons: string[];
}

export function scoreDiscovery(d: Discovery): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (d.free) (score += 3), reasons.push("free");
  if (d.openSource) (score += 2), reasons.push("open-source");
  if (d.selfHostable) (score += 2), reasons.push("self-hostable");
  if (d.hasApi) (score += 2), reasons.push("has API");
  if (d.mcp) (score += 2), reasons.push("MCP");
  if (d.docker) (score += 1), reasons.push("Docker");
  return { score, reasons };
}

export function rankDiscoveries(list: Discovery[]): RankedDiscovery[] {
  return list
    .map((d) => {
      const { score, reasons } = scoreDiscovery(d);
      return { ...d, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
}

export type ResearchCommand =
  | { op: "ingest"; discovery: Discovery }
  | { op: "rank"; discoveries: Discovery[] }
  | { op: "report"; limit?: number };

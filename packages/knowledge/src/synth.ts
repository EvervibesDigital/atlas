/**
 * Knowledge Synthesizer core — merges scattered lessons into a structured
 * playbook. Notes are routed into sections ("What works", "What to avoid",
 * "Notes") by simple signal; the Brain can rewrite these into polished prose
 * later behind the same interface.
 */
export interface PlaybookSection {
  heading: string;
  points: string[];
}

export interface Playbook {
  title: string;
  sections: PlaybookSection[];
}

const WORKS = /\b(work|worked|works|win|won|success|best|convert|grew|grow)\b/i;
const AVOID = /\b(fail|failed|avoid|don't|dont|worse|crash|broke|mistake|rejected)\b/i;

export function synthesize(topic: string, notes: string[]): Playbook {
  const works: string[] = [];
  const avoid: string[] = [];
  const other: string[] = [];
  for (const n of notes) {
    const note = n.trim();
    if (!note) continue;
    if (WORKS.test(note)) works.push(note);
    else if (AVOID.test(note)) avoid.push(note);
    else other.push(note);
  }
  const sections: PlaybookSection[] = [];
  if (works.length) sections.push({ heading: "What works", points: works });
  if (avoid.length) sections.push({ heading: "What to avoid", points: avoid });
  if (other.length) sections.push({ heading: "Notes", points: other });
  return { title: `Playbook: ${topic}`, sections };
}

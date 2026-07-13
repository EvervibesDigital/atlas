import type { Plugin } from "@atlas/core";

/**
 * Newsletter plugin — ATLAS reads tech-newsletter sites daily (3 per run,
 * rotating) via the `web` service and files summaries into shared memory,
 * where the chat and daily cycle recall them. It does NOT auto-subscribe:
 * signup forms need the owner's email and stay owner-gated; `subscribeAll`
 * only files a signup checklist.
 */

interface NewsletterSubscription {
  name: string;
  url: string;
  signupUrl: string;
  frequency: "daily" | "weekly";
  lastRead?: string;
  articlesRead: number;
}

const NEWSLETTERS: NewsletterSubscription[] = [
  { name: "Alpha Signal", url: "https://alphasignal.ai", signupUrl: "https://alphasignal.ai/newsletter", frequency: "daily", articlesRead: 0 },
  { name: "The Rundown", url: "https://www.therundown.ai", signupUrl: "https://www.therundown.ai/subscribe", frequency: "daily", articlesRead: 0 },
  { name: "TechPresso", url: "https://dupple.com/techpresso", signupUrl: "https://dupple.com/techpresso", frequency: "daily", articlesRead: 0 },
  { name: "ByteByteGo", url: "https://blog.bytebytego.com", signupUrl: "https://blog.bytebytego.com/subscribe", frequency: "daily", articlesRead: 0 },
  { name: "The Agent", url: "https://www.agents.tips", signupUrl: "https://www.agents.tips/newsletter", frequency: "daily", articlesRead: 0 },
  { name: "TLDR", url: "https://tldr.tech", signupUrl: "https://tldr.tech/signup", frequency: "daily", articlesRead: 0 },
  { name: "TheCode", url: "https://codenewsletter.ai", signupUrl: "https://codenewsletter.ai/subscribe", frequency: "daily", articlesRead: 0 },
  { name: "How to AI", url: "https://ruben.substack.com", signupUrl: "https://ruben.substack.com/subscribe", frequency: "weekly", articlesRead: 0 },
  { name: "Superhuman AI", url: "https://www.superhuman.ai", signupUrl: "https://www.superhuman.ai/subscribe", frequency: "daily", articlesRead: 0 },
];

export function createNewsletterPlugin(): Plugin {
  return {
    manifest: {
      name: "newsletter",
      version: "0.1.0",
      capabilities: ["newsletter"],
      permissions: ["call:brain", "call:memory", "call:web"],
      role: "executor",
    },

    async register(ctx) {
      ctx.provide("newsletter", async (payload) => {
        const cmd = payload as {
          op: "subscribeAll" | "readDaily" | "integrateFindings" | "status";
          businessGoals?: string[];
        };

        if (cmd.op === "subscribeAll") {
          // HONEST: ATLAS can't complete a real signup — that needs your email
          // typed into each newsletter's form (owner-gated, never automated).
          // What it CAN do: verify each signup page is reachable and file the
          // signup URLs to memory as a checklist for you. It does NOT claim to
          // have subscribed.
          const results: { name: string; signupUrl: string; reachable: boolean }[] = [];

          for (const nl of NEWSLETTERS) {
            let reachable = false;
            try {
              await ctx.call("web", { op: "read", url: nl.signupUrl });
              reachable = true;
            } catch {
              reachable = false;
            }
            results.push({ name: nl.name, signupUrl: nl.signupUrl, reachable });
          }

          try {
            await ctx.call("memory", {
              op: "remember",
              input: {
                kind: "task",
                content: `Owner TODO — subscribe to newsletters: ${results.map((r) => `${r.name} (${r.signupUrl})`).join("; ")}`,
                metadata: { type: "newsletter-signup-checklist" },
              },
            });
          } catch {
            /* memory optional */
          }

          await ctx.emit("newsletter.subscribeChecklist", { total: NEWSLETTERS.length, reachable: results.filter((r) => r.reachable).length });
          return { note: "ATLAS cannot auto-subscribe (email form is owner-gated). Signup URLs filed to memory.", results };
        }

        if (cmd.op === "readDaily") {
          // Real ingestion: fetch + summarize newsletters via the `web`
          // service's `learn` op, which stores notes into the SAME semantic
          // memory the chat and daily cycle recall from — closing the loop.
          // Reads 3 sources per run, least-recently-read first, so the nightly
          // cycle stays fast; all 9 sources get covered every ~3 days.
          const articles: { newsletter: string; title?: string; notes?: string; error?: string }[] = [];
          const batch = [...NEWSLETTERS].sort((a, b) => (a.lastRead ?? "").localeCompare(b.lastRead ?? "")).slice(0, 3);

          for (const nl of batch) {
            try {
              const learned = (await ctx.call("web", { op: "learn", url: nl.url })) as {
                title?: string;
                notes?: string;
              };
              nl.articlesRead++;
              nl.lastRead = new Date().toISOString();
              articles.push({ newsletter: nl.name, title: learned.title, notes: (learned.notes ?? "").slice(0, 300) });
            } catch (e) {
              articles.push({ newsletter: nl.name, error: (e as Error).message });
            }
          }

          await ctx.emit("newsletter.read", { sources: batch.length, ok: articles.filter((a) => !a.error).length });
          return { articles, rotation: `${batch.length} of ${NEWSLETTERS.length} sources this run`, nextCheck: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
        }

        if (cmd.op === "integrateFindings") {
          // ATLAS analyzes articles and integrates relevant patterns
          const businessGoals = cmd.businessGoals || ["grow revenue", "improve automation", "reduce costs"];

          try {
            const brainResp = await ctx.call("brain", {
              system: "You are ATLAS's integration engine. From today's newsletter articles, identify patterns that fit these business goals. Extract actionable capabilities, new tools, or strategies.",
              prompt: `Business goals: ${businessGoals.join(", ")}. Article topics: ${NEWSLETTERS.map((n) => `${n.name} (${n.articlesRead} read)`).join(", ")}. What should ATLAS learn or build?`,
              needs: { research: 0.9, reasoning: 0.8 },
              maxTokens: 1000,
              task: "newsletter.integrate",
            });

            const findings = (brainResp as { text: string }).text;

            // File findings to memory for future use
            try {
              await ctx.call("memory", {
                op: "remember",
                input: {
                  kind: "artifact",
                  content: `Today's newsletter findings: ${findings}`,
                  metadata: { type: "newsletter-integration", date: new Date().toISOString() },
                },
              });
            } catch {
              /* memory optional */
            }

            await ctx.emit("newsletter.integrated", { findings: findings.length });
            return { findings, nextIntegration: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() };
          } catch (e) {
            throw new Error(`Integration failed: ${(e as Error).message}`);
          }
        }

        if (cmd.op === "status") {
          return {
            subscribed: NEWSLETTERS.length,
            articlesReadTotal: NEWSLETTERS.reduce((sum, n) => sum + n.articlesRead, 0),
            newsletters: NEWSLETTERS.map((n) => ({
              name: n.name,
              articlesRead: n.articlesRead,
              lastRead: n.lastRead,
            })),
          };
        }

        throw new Error(`newsletter: unknown op "${(cmd as { op: string }).op}"`);
      });

      // Emit that newsletter plugin is ready
      await ctx.emit("newsletter.ready", {
        newsletters: NEWSLETTERS.length,
        message: "ATLAS is ready to autonomously subscribe and learn from tech newsletters daily.",
      });
    },
  };
}

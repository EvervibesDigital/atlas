import type { Plugin } from "@atlas/core";
import { ExperimentLab, type ExperimentCommand } from "./lab";

/** Experiment Lab plugin (service "experiments"). */
export function createExperimentsPlugin(opts: { lab?: ExperimentLab } = {}): Plugin {
  const lab = opts.lab ?? new ExperimentLab();
  return {
    manifest: { name: "experiments", version: "0.1.0", capabilities: ["experiments"], permissions: [], role: "executor" },
    register(ctx) {
      ctx.provide("experiments", (payload) => {
        const cmd = payload as ExperimentCommand;
        switch (cmd.op) {
          case "start":
            return lab.start(cmd.name, cmd.variants);
          case "record":
            lab.record(cmd.id, cmd.variant, cmd.won);
            return lab.get(cmd.id);
          case "evaluate":
            return lab.evaluate(cmd.id, cmd.minTrials);
          case "list":
            return lab.list();
          default:
            throw new Error(`experiments: unknown op "${(cmd as { op: string }).op}"`);
        }
      });
    },
  };
}

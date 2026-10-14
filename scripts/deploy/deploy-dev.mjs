import * as heroku from "./heroku-stub.mjs";
import {
  createDeployment,
  PIPELINE_ORDER,
  PIPELINES,
  setDeploymentStatus,
  setStatus,
  short,
  summary,
} from "./lib.mjs";

const sha = process.env.SHA;

await setStatus(sha, "deployed/development", "pending", "Building both development apps");
summary(`## Development deploy of \`${short(sha)}\`\n`);

// Both builds start together, as Heroku's auto-deploy does; the proxy finishes first.
const results = await Promise.allSettled(
  PIPELINE_ORDER.map(async (pipeline) => {
    const app = PIPELINES[pipeline].development;
    const id = await createDeployment(app, sha, "development");
    await setDeploymentStatus(id, "in_progress", "Build started");
    try {
      await heroku.build(pipeline, app, sha);
      await heroku.psWait(pipeline);
      await setDeploymentStatus(id, "success", `Released ${short(sha)}`);
      summary(`- \`${app}\` released \`${short(sha)}\` at ${new Date().toISOString()}`);
    } catch (error) {
      await setDeploymentStatus(id, "failure", error.message);
      summary(`- \`${app}\` failed: ${error.message}`);
      throw error;
    }
  }),
);

const releases = await Promise.all(PIPELINE_ORDER.map((p) => heroku.getRelease(PIPELINES[p].development)));
const together = releases.every((release) => release.sha === sha && release.status === "succeeded");
const failures = results.filter((r) => r.status === "rejected").map((r) => r.reason.message);

await setStatus(
  sha,
  "deployed/development",
  together ? "success" : "failure",
  together ? "Both development apps run this SHA" : `Not promotable: ${failures.join("; ") || "apps differ"}`,
);
summary(
  together
    ? "\n`deployed/development` is green: staging may promote this SHA."
    : "\n`deployed/development` is red.",
);
if (!together) process.exit(1);

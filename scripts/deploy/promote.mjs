import * as heroku from "./heroku-stub.mjs";
import {
  createDeployment,
  gh,
  PIPELINES,
  REPO,
  setDeploymentStatus,
  short,
  sourceStageOf,
  summary,
} from "./lib.mjs";

const target = process.env.TARGET;
const source = sourceStageOf(target);
const sha = process.env.SHA;
const pipelines = JSON.parse(process.env.PIPELINES);
const prs = JSON.parse(process.env.PRS);

summary(`## Promote ${source} → ${target}: \`${short(sha)}\`\n`);

for (const pipeline of pipelines) {
  const fromApp = PIPELINES[pipeline][source];
  const toApp = PIPELINES[pipeline][target];
  const current = await heroku.getRelease(toApp);
  // Makes a re-run after a half-finished promotion retry only the app still behind.
  if (current.sha === sha && current.status === "succeeded") {
    summary(`- \`${toApp}\` already runs \`${short(sha)}\`, skipped`);
    continue;
  }

  const id = await createDeployment(toApp, sha, target);
  await setDeploymentStatus(id, "in_progress", `Promoting from ${fromApp}`);
  try {
    const promoted = await heroku.promote(pipeline, fromApp, toApp);
    if (promoted !== sha) throw new Error(`${fromApp} moved to ${short(promoted)} during the run`);
    await heroku.psWait(pipeline);
    await setDeploymentStatus(id, "success", `Released ${short(sha)}`);
    summary(`- \`${toApp}\` released \`${short(sha)}\``);
  } catch (error) {
    await setDeploymentStatus(id, "failure", error.message);
    summary(`- \`${toApp}\` failed: ${error.message}`);
    throw error;
  }
}

const label = `deployed:${target}`;
try {
  await gh("POST", `/repos/${REPO}/labels`, { name: label, color: target === "production" ? "0e8a16" : "c5def5" });
} catch (error) {
  if (!/: 422 /.test(error.message)) throw error;
}
for (const number of prs) {
  await gh("POST", `/repos/${REPO}/issues/${number}/labels`, { labels: [label] });
}
summary(`\nLabelled ${prs.length ? prs.map((n) => `#${n}`).join(" ") : "no PRs"} \`${label}\`.`);
summary(`Slack (stub): "${target} now runs ${short(sha)}; verification started."`);

await gh("POST", `/repos/${REPO}/actions/workflows/verify.yml/dispatches`, {
  ref: "main",
  inputs: {
    stage: target,
    sha,
    pipelines: JSON.stringify(pipelines),
    watch_minutes: process.env.WATCH_MINUTES || "15",
    require_signoff: String(target === "staging" && process.env.REQUIRE_SIGNOFF === "true"),
  },
});
summary(`Started \`verify.yml\` for ${target}.`);

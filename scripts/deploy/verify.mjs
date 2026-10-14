// Verification runs on a deployment after it lands. One script, one subcommand per verify.yml job.
import * as heroku from "./heroku-stub.mjs";
import { gh, PIPELINES, REPO, RUN_URL, setStatus, short, sleep, summary, verifiedContext } from "./lib.mjs";

const [command] = process.argv.slice(2);
const stage = process.env.STAGE;
const sha = process.env.SHA;
const pipelines = JSON.parse(process.env.PIPELINES);
const contexts = pipelines.map((p) => verifiedContext(stage, p));

if (command === "start") {
  for (const context of contexts) await setStatus(sha, context, "pending", "Verification running");
  summary(`## Verify ${stage} \`${short(sha)}\`\n\nPending: ${contexts.map((c) => `\`${c}\``).join(", ")}`);
}

if (command === "e2e") {
  await setStatus(sha, "e2e/staging", "pending", "E2E running against staging");
  await sleep(30);
  const releases = await Promise.all(pipelines.map((p) => heroku.getRelease(PIPELINES[p].staging)));
  const moved = releases.filter((r) => r.sha !== sha);
  const failed = (await heroku.getControl()).e2e_fail;
  const passed = !moved.length && !failed;
  const detail = moved.length
    ? `staging no longer runs ${short(sha)}`
    : failed
      ? "stub e2e failure (control e2e_fail)"
      : "all specs passed";
  await setStatus(sha, "e2e/staging", passed ? "success" : "failure", detail);
  summary(`E2E: ${passed ? "✅" : "❌"} ${detail}`);
  if (!passed) process.exit(1);
}

if (command === "watch") {
  const minutes = Number(process.env.WATCH_MINUTES);
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    const alarms = (await heroku.getControl()).alarms[stage] ?? [];
    if (alarms.length) {
      summary(`Datadog watch: ❌ ${alarms.join(", ")} alerting on ${stage}`);
      process.exit(1);
    }
    await sleep(Math.min(20, Math.max(0, (deadline - Date.now()) / 1000)));
  }
  summary(`Datadog watch: ✅ no ${stage} monitor alerted for ${minutes} min`);
}

if (command === "record") {
  const results = { e2e: process.env.E2E, watch: process.env.WATCH, signoff: process.env.SIGNOFF };
  const passed =
    results.watch === "success" &&
    (stage !== "staging" || results.e2e === "success") &&
    ["success", "skipped"].includes(results.signoff);
  const detail = Object.entries(results)
    .map(([name, result]) => `${name} ${result}`)
    .join(", ");
  for (const context of contexts) await setStatus(sha, context, passed ? "success" : "failure", detail);
  summary(`\n${passed ? "✅" : "❌"} ${contexts.map((c) => `\`${c}\``).join(", ")}: ${detail}`);

  if (!passed && stage === "production") {
    // Stands in for a page: the deployer decides on a rollback; there is no later stage to block.
    const issue = await gh("POST", `/repos/${REPO}/issues`, {
      title: `Production verification failed for ${short(sha)}`,
      body: `Verification of \`${sha}\` on production failed (${detail}).\n\nRun: ${RUN_URL}\n\nDecide on a rollback; this does not block anything.`,
      labels: ["page"],
    });
    summary(`Paged (stub): ${issue.html_url}`);
  }
  if (!passed) process.exit(1);
}

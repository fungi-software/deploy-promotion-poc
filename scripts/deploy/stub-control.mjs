import { DEFAULT_CONTROL, getControl, updateControl } from "./heroku-stub.mjs";
import { summary } from "./lib.mjs";

const action = process.env.ACTION;
const stage = process.env.STAGE;
const value = (process.env.VALUE ?? "").trim();

const changes = {
  "raise-alarm": (c) => ({ ...c, alarms: { ...c.alarms, [stage]: [...new Set([...c.alarms[stage], value || "API 5xx rate"])] } }),
  "clear-alarms": (c) => ({ ...c, alarms: { ...c.alarms, [stage]: [] } }),
  "fail-e2e": (c) => ({ ...c, e2e_fail: true }),
  "pass-e2e": (c) => ({ ...c, e2e_fail: false }),
  "set-web-dynos": (c) => ({ ...c, web_dynos: Number(value) }),
  "fail-build": (c) => ({ ...c, fail_build: [...new Set([...c.fail_build, value])] }),
  "fail-promote": (c) => ({ ...c, fail_promote: [...new Set([...c.fail_promote, value])] }),
  "clear-failures": (c) => ({ ...c, fail_build: [], fail_promote: [] }),
  reset: () => structuredClone(DEFAULT_CONTROL),
};

if (!changes[action]) throw new Error(`Unknown action ${action}`);
await updateControl(changes[action]);
summary(`## Stub control: ${action}\n\n\`\`\`json\n${JSON.stringify(await getControl(), null, 2)}\n\`\`\``);

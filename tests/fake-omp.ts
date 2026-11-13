// Stands in for `omp --mode json -p` in spawn.test.ts. FAKE_OMP_* variables pick what it does.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const args = process.argv.slice(2);
const marker = env.OMP_BETTER_HELPER;
const prefix = env.OMP_BETTER_PREFIX;
if (env.FAKE_OMP_REPORT) {
	const fork = args.includes("--fork") ? args[args.indexOf("--fork") + 1] : undefined;
	writeFileSync(
		env.FAKE_OMP_REPORT,
		JSON.stringify({
			args,
			fork,
			forkContent: fork && existsSync(fork) ? readFileSync(fork, "utf8") : undefined,
			envKeys: Object.keys(env),
			pid: process.pid,
			prefix,
			prefixMode: prefix && existsSync(prefix) ? statSync(prefix).mode & 0o777 : undefined,
			prefixContent: prefix && existsSync(prefix) ? readFileSync(prefix, "utf8") : undefined,
		}),
	);
}
if (marker && env.FAKE_OMP_GUARD !== "missing") writeFileSync(marker, String(process.pid));
// Like the guard after it swapped the chat's request head into a request.
if (prefix && env.FAKE_OMP_PIN) writeFileSync(`${prefix}.pinned`, "");
// Like omp with --session-dir outside its sessions folder: record the session in <agent dir>/custom-session-files.
if (env.FAKE_OMP_AGENT_DIR && args.includes("--session-dir")) {
	writeFileSync(join(env.FAKE_OMP_AGENT_DIR, "custom-session-files", "abc1234"), `${args[args.indexOf("--session-dir") + 1]}/2026_x.jsonl\n`);
}
const lines = env.FAKE_OMP_FIXTURE ? readFileSync(env.FAKE_OMP_FIXTURE, "utf8").split("\n") : [];
for (const line of lines) process.stdout.write(`${line}\n`);
if (env.FAKE_OMP_STDERR) process.stderr.write(env.FAKE_OMP_STDERR);
if (env.FAKE_OMP_SIGNAL) process.kill(process.pid, env.FAKE_OMP_SIGNAL as NodeJS.Signals);
if (env.FAKE_OMP_HANG) setInterval(() => {}, 1000);
else process.exitCode = Number(env.FAKE_OMP_EXIT ?? 0);

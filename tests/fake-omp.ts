// Stands in for `omp --mode json -p` in spawn.test.ts and index.test.ts. FAKE_OMP_* variables pick what it does.
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const env = process.env;
const args = process.argv.slice(2);
const marker = env.OMP_BETTER_HELPER;
const prefix = env.OMP_BETTER_PREFIX;
// One line per start, for tests of a run that is repeated.
if (env.FAKE_OMP_CALLS) appendFileSync(env.FAKE_OMP_CALLS, `${JSON.stringify({ args, prefix })}\n`);
// Like an omp that doesn't know the cache flags ("always": also when they aren't passed). The text is what omp 18.20.0 prints for an unknown flag.
if (env.FAKE_OMP_REJECT_CACHE_FLAGS && (env.FAKE_OMP_REJECT_CACHE_FLAGS === "always" || args.includes("--prompt-cache-key"))) {
	process.stderr.write("Error: unknown flag: --prompt-cache-key\nRun `omp --help` for available flags.\n");
	process.exit(2);
}
if (env.FAKE_OMP_REPORT) {
	const fork = args.includes("--fork") ? args[args.indexOf("--fork") + 1] : undefined;
	writeFileSync(
		env.FAKE_OMP_REPORT,
		JSON.stringify({
			args,
			fork,
			forkContent: fork && existsSync(fork) ? readFileSync(fork, "utf8") : undefined,
			envKeys: Object.keys(env),
			parentPid: env.OMP_BETTER_PARENT_PID,
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

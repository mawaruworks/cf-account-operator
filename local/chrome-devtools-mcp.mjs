import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { delimiter, isAbsolute, join, resolve } from "node:path";

const forwardedArgs = process.argv.slice(2);
let accountId = process.env.NOTE_ACCOUNT_ID;
const accountArgIndex = forwardedArgs.findIndex(
  (arg) => arg === "--account-id" || arg.startsWith("--account-id="),
);
if (accountArgIndex >= 0) {
  const accountArg = forwardedArgs[accountArgIndex];
  const suppliedAccountId = accountArg === "--account-id"
    ? forwardedArgs[accountArgIndex + 1]
    : accountArg.slice("--account-id=".length);
  if (!suppliedAccountId) throw new Error("--account-id requires a value");
  accountId = suppliedAccountId;
  forwardedArgs.splice(accountArgIndex, accountArg === "--account-id" ? 2 : 1);
}
const accountIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
if (!accountId || !accountIdPattern.test(accountId)) {
  throw new Error("account ID must match [a-z0-9][a-z0-9-]{1,62}");
}

const configuredRoot = process.env.NOTE_PROFILE_ROOT;
if (configuredRoot && !isAbsolute(configuredRoot)) {
  throw new Error("NOTE_PROFILE_ROOT must be an absolute path");
}

const defaultConfigRoot = process.env.XDG_CONFIG_HOME
  ?? (process.platform === "win32"
    ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
    : join(homedir(), ".config"));
const profileRoot = resolve(
  configuredRoot ?? join(defaultConfigRoot, "cf-account-operator", "note-accounts"),
);
const profileDir = join(profileRoot, accountId, "chrome-profile");
mkdirSync(profileDir, { recursive: true, mode: 0o700 });
chmodSync(profileDir, 0o700);

const configuredMcpBin = process.env.NOTE_CHROME_DEVTOOLS_MCP_BIN;
const configuredMcpDir = process.env.NOTE_CHROME_DEVTOOLS_MCP_DIR;
if (configuredMcpDir && !isAbsolute(configuredMcpDir)) {
  throw new Error("NOTE_CHROME_DEVTOOLS_MCP_DIR must be an absolute path");
}
if (configuredMcpBin && configuredMcpDir) {
  throw new Error("Set only one of NOTE_CHROME_DEVTOOLS_MCP_BIN or NOTE_CHROME_DEVTOOLS_MCP_DIR");
}

const mcpExecutableName = process.platform === "win32" ? "chrome-devtools-mcp.cmd" : "chrome-devtools-mcp";
const findOnPath = (command) => {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined;
  return (process.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => join(directory, command))
    .find((candidate) => existsSync(candidate));
};

let mcpCommand;
let mcpArgs = [];
if (configuredMcpDir) {
  const designatedCandidates = [
    join(configuredMcpDir, "bin", mcpExecutableName),
    join(configuredMcpDir, "node_modules", ".bin", mcpExecutableName),
    join(configuredMcpDir, mcpExecutableName),
  ];
  mcpCommand = designatedCandidates.find((candidate) => existsSync(candidate));
  if (!mcpCommand) throw new Error(`Chrome DevTools MCP was not found under ${configuredMcpDir}`);
} else if (configuredMcpBin) {
  mcpCommand = findOnPath(configuredMcpBin);
  if (!mcpCommand) throw new Error(`Chrome DevTools MCP executable was not found: ${configuredMcpBin}`);
} else {
  mcpCommand = findOnPath(mcpExecutableName);
  if (!mcpCommand) {
    mcpCommand = process.env.NOTE_NPX_PATH ?? "npx";
    mcpArgs = ["-y", "chrome-devtools-mcp@latest"];
  }
}

const child = spawn(
  mcpCommand,
  [
    ...mcpArgs,
    "--user-data-dir",
    profileDir,
    "--no-usage-statistics",
    ...forwardedArgs,
  ],
  { stdio: "inherit", env: process.env },
);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  console.error(`Could not start Chrome DevTools MCP: ${error.message}`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

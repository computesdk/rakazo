// Stand-in for daemond, which declares os: [linux, darwin] and so cannot be
// installed on Windows, breaking `pnpm install` there. computesdk only calls
// these inside its daemon-seed features, which Rakazo does not use.
function unavailable() {
  throw new Error("daemond daemon-seed features are unavailable in this install");
}
exports.daemonSeedScript = unavailable;
exports.daemonSeedScriptCommand = unavailable;
exports.parseSeedInvocationOutput = unavailable;

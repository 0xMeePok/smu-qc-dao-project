/** Read the public app ID from the artifact Vite actually built. */
export function previewPrivyAppId(bundle) {
  const ids = [...bundle.matchAll(/VITE_PRIVY_APP_ID:\s*"([^"\s]+)"/g)]
    .map((match) => match[1]);
  const distinct = [...new Set(ids)];
  if (distinct.length !== 1 || !/^[a-zA-Z0-9_-]+$/.test(distinct[0])) {
    throw new Error("The preview bundle must contain one configured VITE_PRIVY_APP_ID.");
  }
  return distinct[0];
}

/** Replace only the public ID, preserving RPC settings and other dotenv lines. */
export function functionsEnvWithPrivyAppId(current, appId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(appId)) throw new Error("Invalid public Privy app ID.");
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const assignment = `PRIVY_APP_ID=${appId}`;
  const replacements = [];
  // Walk complete dotenv entries, rather than matching every line: a quoted
  // value may itself contain lines that look like PRIVY_APP_ID assignments.
  for (let start = 0; start < current.length;) {
    const lineEnd = current.indexOf("\n", start);
    const end = lineEnd < 0 ? current.length : lineEnd;
    const match = current.slice(start, end)
      .match(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*/);
    if (!match) {
      start = end + 1;
      continue;
    }
    const valueStart = start + match[0].length;
    const quote = current[valueStart];
    let valueEnd;
    let entryEnd = end;
    if (quote === '"' || quote === "'" || quote === "`") {
      let escaped = false;
      let cursor = valueStart + 1;
      for (; cursor < current.length; cursor++) {
        if (current[cursor] === quote && !escaped) break;
        escaped = current[cursor] === "\\" ? !escaped : false;
      }
      if (cursor === current.length) {
        throw new Error("Could not update the Cloud Functions environment: an unterminated quoted value needs correction.");
      }
      valueEnd = cursor + 1;
      const nextLine = current.indexOf("\n", valueEnd);
      entryEnd = nextLine < 0 ? current.length : nextLine;
    } else {
      const comment = current.indexOf("#", valueStart);
      valueEnd = comment >= 0 && comment < end ? comment : end;
      while (valueEnd > valueStart && /[ \t\r]/.test(current[valueEnd - 1])) valueEnd--;
    }
    if (match[1] === "PRIVY_APP_ID") replacements.push({ start, end: valueEnd });
    start = entryEnd + 1;
  }
  if (replacements.length) {
    let updated = current;
    for (const { start, end } of replacements.reverse()) {
      updated = updated.slice(0, start) + assignment + updated.slice(end);
    }
    return updated;
  }
  return current + (current && !current.endsWith("\n") ? newline : "") + assignment + newline;
}

/** A frontend-only preview never reads or changes the backend environment. */
export function deployPreviewBackend({ withBackend, appId, readEnvironment, writeEnvironment,
  deployRules, deployFunctions }) {
  if (!withBackend) return;
  const current = readEnvironment();
  const desired = functionsEnvWithPrivyAppId(current, appId);
  if (desired !== current) writeEnvironment(desired);
  deployRules();
  deployFunctions();
}

/**
 * node:test reporter: one line per test case, whole line green or red.
 * Suites are skipped; failure detail is still printed, since a red line alone
 * does not say what broke.
 */
const colour = !process.env.NO_COLOR && process.env.FORCE_COLOR !== "0";
const paint = (code, text) => (colour ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (text) => paint(32, text);
const red = (text) => paint(31, text);
const dim = (text) => paint(90, text);

export default async function* lines(source) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];

  for await (const event of source) {
    const data = event.data ?? {};
    if (data.details?.type !== "test") continue;

    if (event.type === "test:pass") {
      if (data.skip || data.todo) {
        skipped += 1;
        yield `${dim(`- ${data.name}`)}\n`;
        continue;
      }
      passed += 1;
      yield `${green(`✓ ${data.name}`)}\n`;
    } else if (event.type === "test:fail") {
      failed += 1;
      failures.push(data);
      yield `${red(`✗ ${data.name}`)}\n`;
    }
  }

  yield "\n";
  for (const failure of failures) {
    const error = failure.details?.error;
    const message = String(error?.message ?? "failed");
    yield `${red(`✗ ${failure.name}`)}\n`;
    for (const line of message.split("\n")) {
      if (line.trim()) yield `${dim(`  ${line}`)}\n`;
    }
    // node:test wraps the thrown error, so the real reason for a wrapped failure
    // (a refused socket, say) sits further down the cause chain. Walk it and print
    // anything the message above did not already say.
    let seen = message;
    let cause = error?.cause;
    for (let depth = 0; cause && depth < 4; depth += 1) {
      const text = String(cause.message ?? "").split("\n")[0];
      if (text && !seen.includes(text)) {
        yield `${dim(`  ${text}`)}\n`;
        seen += `\n${text}`;
      }
      cause = cause.cause;
    }
    yield "\n";
  }

  const parts = [`${passed} passed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  const summary = parts.join(", ");
  yield `${failed > 0 ? red(summary) : green(summary)}\n`;
}

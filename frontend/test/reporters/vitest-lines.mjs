/**
 * Vitest reporter matching scripts/test-reporter.mjs: one line per test case,
 * whole line green or red. Failure detail still prints after the run.
 */
const colour = !process.env.NO_COLOR && process.env.FORCE_COLOR !== "0";
const paint = (code, text) => (colour ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (text) => paint(32, text);
const red = (text) => paint(31, text);
const dim = (text) => paint(90, text);

export default class LineReporter {
  passed = 0;
  failed = 0;
  skipped = 0;
  failures = [];
  brokenModules = 0;

  write(text) {
    process.stdout.write(text);
  }

  onTestCaseResult(testCase) {
    const state = testCase.result()?.state;
    const name = testCase.name;
    if (state === "passed") {
      this.passed += 1;
      this.write(`${green(`✓ ${name}`)}\n`);
    } else if (state === "failed") {
      this.failed += 1;
      this.failures.push({ name, errors: testCase.result()?.errors ?? [] });
      this.write(`${red(`✗ ${name}`)}\n`);
    } else if (state === "skipped") {
      this.skipped += 1;
      this.write(`${dim(`- ${name}`)}\n`);
    }
  }

  onTestRunEnd(modules = [], errors = []) {
    this.write("\n");
    // A file that throws while being imported reports no test cases at all, so
    // without this the run would print a clean "0 passed" and exit non-zero for
    // no visible reason.
    for (const module of modules) {
      const moduleErrors = typeof module.errors === "function" ? module.errors() : [];
      for (const error of moduleErrors ?? []) {
        this.brokenModules += 1;
        const id = String(module.moduleId ?? "unknown").split("/").pop();
        this.write(`${red(`✗ ${id} could not be loaded`)}\n`);
        this.write(`${dim(`  ${String(error.message).split("\n")[0]}`)}\n\n`);
      }
    }
    for (const failure of this.failures) {
      this.write(`${red(`✗ ${failure.name}`)}\n`);
      const message = failure.errors[0]?.message ?? "failed";
      this.write(`${dim(`  ${message.split("\n")[0]}`)}\n\n`);
    }
    // Unhandled errors are not attached to any test case, so they would otherwise
    // vanish from this reporter entirely.
    for (const error of errors) {
      this.write(`${red(`✗ unhandled: ${error.message?.split("\n")[0] ?? error}`)}\n\n`);
    }

    const parts = [`${this.passed} passed`];
    if (this.failed > 0) parts.push(`${this.failed} failed`);
    if (this.skipped > 0) parts.push(`${this.skipped} skipped`);
    if (this.brokenModules > 0) parts.push(`${this.brokenModules} file(s) not loaded`);
    const summary = parts.join(", ");
    const bad = this.failed > 0 || errors.length > 0 || this.brokenModules > 0;
    this.write(`${bad ? red(summary) : green(summary)}\n`);
  }
}

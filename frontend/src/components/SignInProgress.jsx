import { useEffect, useState } from "react";
import { useSession } from "../context/SessionContext.jsx";
import { SIGN_IN_TIPS } from "../config/signInTips.js";

export const TIP_INTERVAL_MS = 6_000;
export const SLOW_AFTER_S = 25;

export const SIGN_IN_STEPS = Object.freeze([
  { key: "wallet", label: "Loading your QC DAO wallet" },
  { key: "session", label: "Securing your session" },
  { key: "profile", label: "Opening your account" },
]);

/**
 * Covers the screen from the moment Privy's email modal closes until the new
 * sign-in finishes (about 20 seconds when the sign-in server is cold). Shows
 * the real step in progress, an elapsed timer and rotating tips on how to use
 * the app. The spinner follows the common CSS ring pattern (e.g. SpinKit,
 * MIT); all motion stops under prefers-reduced-motion.
 */
export function SignInProgress() {
  const { signInStep } = useSession();
  if (!signInStep) return null;
  return <SignInProgressScreen step={signInStep} />;
}

export function SignInProgressScreen({ step, tips = SIGN_IN_TIPS, random = Math.random }) {
  const [elapsed, setElapsed] = useState(0);
  const [tipIndex, setTipIndex] = useState(() => Math.floor(random() * tips.length) % tips.length);
  const [tipsRound, setTipsRound] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1_000);
    return () => clearInterval(timer);
  }, []);

  // A tip changes every few seconds; "Next tip" shows another and restarts the wait.
  useEffect(() => {
    const timer = setInterval(() => setTipIndex((index) => (index + 1) % tips.length), TIP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [tips.length, tipsRound]);

  const nextTip = () => {
    setTipIndex((index) => (index + 1) % tips.length);
    setTipsRound((round) => round + 1);
  };

  const current = Math.max(0, SIGN_IN_STEPS.findIndex((item) => item.key === step));
  const tip = tips[tipIndex];

  return (
    <div className="signin-progress-backdrop">
      <section className="signin-progress" role="dialog" aria-modal="true" aria-labelledby="signin-progress-title"
        aria-describedby="signin-progress-status" aria-busy="true">
        <div className="signin-progress-spinner" aria-hidden="true">
          <span /><span /><span />
        </div>
        <h2 id="signin-progress-title">Signing you in</h2>
        <p id="signin-progress-status" className="signin-progress-status" role="status" aria-live="polite">
          {SIGN_IN_STEPS[current].label}… Please keep this tab open.
        </p>

        <ol className="signin-progress-steps">
          {SIGN_IN_STEPS.map((item, index) => {
            const state = index < current ? "done" : index === current ? "active" : "pending";
            return (
              <li key={item.key} className={`signin-progress-step is-${state}`}>
                <span className="signin-progress-step-mark" aria-hidden="true">{state === "done" ? "✓" : index + 1}</span>
                <span>{item.label}</span>
                <span className="sr-only">{state === "done" ? " (done)" : state === "active" ? " (in progress)" : ""}</span>
              </li>
            );
          })}
        </ol>

        <div className="signin-progress-bar" aria-hidden="true"><span /></div>
        <p className="signin-progress-elapsed">
          {elapsed}s{elapsed >= SLOW_AFTER_S ? " · Still working. The first sign-in after a quiet spell can take up to a minute." : " · This usually takes under 20 seconds."}
        </p>

        <figure className="signin-progress-tip" aria-label="Tip while you wait">
          <figcaption>Did you know?</figcaption>
          <blockquote key={tipIndex}>
            <strong>{tip.title}</strong>
            <span>{tip.text}</span>
          </blockquote>
          <button type="button" className="signin-progress-next" onClick={nextTip}>Next tip</button>
        </figure>
      </section>
    </div>
  );
}

import { useEffect, useRef } from "react";

/** Bring asynchronous wallet failures back into view on long submission forms. */
export function SubmissionError({ message, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!message) return;
    ref.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    ref.current?.focus({ preventScroll: true });
  }, [message]);
  return message ? <p ref={ref} className="submission-error" role="alert" tabIndex={-1}>
    {message}{children}
  </p> : null;
}

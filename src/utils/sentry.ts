import * as Sentry from "@sentry/browser";

export function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    integrations: [],
    tracesSampleRate: 0.05,
    // Ignore noisy non-actionable errors from WebView2
    ignoreErrors: [
      "ResizeObserver loop",
      "Non-Error promise rejection",
    ],
  });
}

export function captureError(err: unknown, context?: Record<string, unknown>) {
  if (context) Sentry.setContext("extra", context);
  Sentry.captureException(err);
}

export { Sentry };

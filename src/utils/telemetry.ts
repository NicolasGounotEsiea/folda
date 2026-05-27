// PostHog-compatible telemetry via direct HTTP API — no npm package required.
// Set VITE_POSTHOG_KEY and optionally VITE_POSTHOG_HOST in .env to activate.

const API_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://us.i.posthog.com";

let _enabled = false;

const _distinctId = (() => {
  const KEY = "nxs_telemetry_id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
})();

export function telemetryInit(enabled: boolean) {
  _enabled = enabled;
  if (enabled) track("app_open");
}

export function telemetrySetEnabled(enabled: boolean) {
  _enabled = enabled;
  localStorage.setItem("nxs_telemetry_enabled", String(enabled));
  if (enabled) track("telemetry_opt_in");
}

export function track(event: string, props?: Record<string, unknown>) {
  if (!_enabled || !API_KEY) return;
  fetch(`${HOST}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: API_KEY,
      event,
      distinct_id: _distinctId,
      properties: { ...props, $lib: "nxs" },
    }),
  }).catch(() => {});
}

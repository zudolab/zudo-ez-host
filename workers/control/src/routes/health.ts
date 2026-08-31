import { Hono } from "hono";

export interface HealthRouterOptions {
  readonly uploadSignerConfigured?: boolean;
}

function isConfigured(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

export function createHealthRouter(options: HealthRouterOptions = {}) {
  return new Hono<{ Bindings: ControlEnv }>().get("/health", (context) => {
    const checks = {
      d1: isConfigured(context.env.DB),
      r2: isConfigured(context.env.ARTIFACTS),
      betterAuthSecret: isConfigured(context.env.BETTER_AUTH_SECRET),
      uploadSigner: options.uploadSignerConfigured === true,
    };
    const ready = Object.values(checks).every(Boolean);
    const status = ready ? 200 : 503;

    return context.json(
      { service: "control", status: ready ? "ready" : "not_ready", checks },
      status,
      { "Cache-Control": "no-store" },
    );
  });
}

export const healthRouter = createHealthRouter();

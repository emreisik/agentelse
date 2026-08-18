type LocalWorkerEnvironment = {
  NEXT_RUNTIME?: string;
  NODE_ENV?: string;
  DISABLE_LOCAL_WORKER?: string;
};

export function shouldStartLocalWorker(env: LocalWorkerEnvironment): boolean {
  return (
    env.NEXT_RUNTIME === "nodejs" &&
    env.NODE_ENV === "development" &&
    env.DISABLE_LOCAL_WORKER !== "true"
  );
}

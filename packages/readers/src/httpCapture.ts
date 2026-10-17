import type { Vector } from "@fea/spec";

export interface HttpCapturePlan {
  name?: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * Black-box capture for HTTP APIs: record request -> status/headers/body.
 * v0.1 records plain-text bodies; binary bodies are out of scope.
 */
export async function captureHttp(plans: HttpCapturePlan[]): Promise<Vector[]> {
  const vectors: Vector[] = [];
  let n = 0;
  for (const plan of plans) {
    n += 1;
    const res = await fetch(plan.url, {
      method: plan.method,
      headers: plan.headers,
      body: plan.body,
      signal: AbortSignal.timeout(plan.timeoutMs ?? 10_000)
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    vectors.push({
      id: `vec_${plan.name ?? n}`,
      weight: 2,
      input: {
        kind: "http",
        method: plan.method,
        url: plan.url,
        headers: plan.headers,
        body: plan.body
      },
      output: { kind: "http", status: res.status, headers, body: await res.text() },
      recordedAt: new Date().toISOString()
    });
  }
  return vectors;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { ServerResponse } from "node:http";
import type { Cluster } from "@hr/contracts";
import { analyzeResume, AnalysisError } from "../apps/worker/src/analysis.js";
import type { AnalysisEvent } from "../apps/worker/src/analysis.js";

// More than 30 profiles guard against accidentally partitioning the /rank payload.
const clusters: Cluster[] = Array.from({ length: 3 }, (_, clusterIndex) => {
  const id = randomUUID();
  return { id, name: `Cluster ${clusterIndex}`, track: `track-${clusterIndex}`,
    comment: "All cluster requirements", is_active: true,
    profiles: Array.from({ length: 11 }, (_, profileIndex) => ({
      id: randomUUID(), cluster_id: id, position_name: `Position ${profileIndex}`,
      education: "Degree", experience: "Experience", keywords: ["SQL", "Python"],
      stop_factors: ["Missing qualification"], comment: "Additional requirements", is_active: true,
    })) };
});
const bytes = new Uint8Array([0, 1, 127, 128, 255]);
const file = new Blob([bytes], { type: "application/pdf" });
const options = { timeoutMs: 3000, maxRetries: 2, retryDelayMs: 1 };
const success = { clusters: clusters.map(c => ({ id: c.id,
  profiles: c.profiles.map(p => ({ id: p.id, score: 80, explanation: "OK" })) })) };
const { Agent, getGlobalDispatcher, setGlobalDispatcher } = createRequire(
  new URL("../apps/worker/package.json", import.meta.url))("undici");

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function withAnalyzer(handler: (form: FormData, response: ServerResponse) => void,
  run: (rankUrl: string) => Promise<void>) {
  let handlerError: unknown;
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/rank");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const multipart = new Request("http://localhost/rank", { method: "POST",
        headers: { "Content-Type": request.headers["content-type"]! },
        body: new Uint8Array(Buffer.concat(chunks)) });
      handler(await multipart.formData(), response);
    })().catch(error => { handlerError = error; response.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    await run(`http://127.0.0.1:${port}/rank`);
    if (handlerError) throw handlerError;
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("worker retries complete multipart requests with every cluster/profile and identical file", async () => {
  const forms: FormData[] = [];
  const events: AnalysisEvent[] = [];
  await withAnalyzer((form, response) => {
    forms.push(form);
    if (forms.length < 3) json(response, forms.length === 1 ? 503 : 500, { detail: "Temporary outage" });
    else json(response, 200, success);
  }, async rankUrl => {
    const result = await analyzeResume(clusters, file, "resume.pdf", { ...options, rankUrl }, event => events.push(event));
    assert.deepEqual(result, success);
  });
  assert.equal(forms.length, 3);
  for (const form of forms) {
    assert.deepEqual([...form.keys()].sort(), ["file", "requirements"]);
    assert.deepEqual(JSON.parse(form.get("requirements") as string), { clusters });
    const sentFile = form.get("file") as File;
    assert.equal(sentFile.name, "resume.pdf");
    assert.equal(sentFile.type, "application/pdf");
    assert.deepEqual(new Uint8Array(await sentFile.arrayBuffer()), bytes);
  }
  assert.deepEqual(events.filter(e => e.type === "retry").map(e => e.http_status), [503, 500]);
  assert.deepEqual(events.filter(e => e.type === "retry").map(e => e.retry_delay_ms), [1, 2]);
  assert.equal(events.at(-1)?.type, "completed");
  assert.ok(events.every(e => e.profiles === 33 && e.clusters === 3));
  assert.doesNotMatch(JSON.stringify(events), /Degree|Experience|Temporary outage|resume\.pdf/);
});

test("worker stops after its configured retries and does not return partial ratings", async () => {
  let calls = 0;
  await withAnalyzer((_form, response) => { calls++; json(response, 503, { detail: "Unavailable" }); }, async rankUrl => {
    await assert.rejects(analyzeResume(clusters, file, "resume.pdf", { ...options, rankUrl }),
      error => error instanceof AnalysisError && error.kind === "http" && error.httpStatus === 503);
  });
  assert.equal(calls, 3);
});

test("worker does not retry permanent document or API errors", async () => {
  for (const status of [400, 401, 413, 422]) {
    let calls = 0;
    await withAnalyzer((_form, response) => { calls++; json(response, status, { detail: "Document rejected" }); }, async rankUrl => {
      await assert.rejects(analyzeResume(clusters, file, "resume.pdf", { ...options, rankUrl }),
        error => error instanceof AnalysisError && error.httpStatus === status && !error.retryable);
    });
    assert.equal(calls, 1);
  }
});

test("worker rejects malformed JSON and incomplete, duplicate or foreign ratings without retries", async () => {
  const invalid = ["not JSON",
    { clusters: success.clusters.slice(0, 1) },
    { clusters: success.clusters.map(c => ({ ...c, profiles: c.profiles.slice(0, 1) })) },
    { clusters: success.clusters.map(c => ({ ...c, profiles: [...c.profiles.slice(1), c.profiles[1]] })) },
    { clusters: success.clusters.map(c => ({ ...c, profiles: c.profiles.map(p => ({ ...p, id: randomUUID() })) })) },
  ];
  for (const body of invalid) {
    let calls = 0;
    await withAnalyzer((_form, response) => {
      calls++;
      if (typeof body === "string") { response.writeHead(200); response.end(body); }
      else json(response, 200, body);
    }, async rankUrl => {
      await assert.rejects(analyzeResume(clusters, file, "resume.pdf", { ...options, rankUrl }),
        error => error instanceof AnalysisError && error.kind === "contract");
    });
    assert.equal(calls, 1);
  }
});

test("worker's total timeout covers retry delays and slow response bodies", async () => {
  for (const slowBody of [false, true]) {
    let calls = 0;
    const start = performance.now();
    await withAnalyzer((_form, response) => {
      calls++;
      if (slowBody) { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"clusters":'); }
      else json(response, 503, { detail: "Unavailable" });
    }, async rankUrl => {
      await assert.rejects(analyzeResume(clusters, file, "resume.pdf",
        { ...options, rankUrl, timeoutMs: 150, retryDelayMs: 1000 }),
      error => error instanceof AnalysisError && error.kind === "timeout");
    });
    assert.equal(calls, 1);
    assert.ok(performance.now() - start < 1500);
  }
});

test("worker waits for its own analysis budget despite shorter default HTTP header/body timeouts", async () => {
  const previous = getGlobalDispatcher();
  // Scale down the five-minute default to reproduce the failure without a long-running test.
  const shortTimeouts = new Agent({ headersTimeout: 100, bodyTimeout: 100 });
  setGlobalDispatcher(shortTimeouts);
  try {
    for (const slowBody of [false, true]) {
      await withAnalyzer((_form, response) => {
        if (slowBody) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.write(" ");
        }
        const timer = setTimeout(() => {
          if (slowBody) response.end(JSON.stringify(success));
          else json(response, 200, success);
        }, 1800);
        response.once("close", () => clearTimeout(timer));
      }, async rankUrl => {
        const form = new FormData();
        form.append("file", file, "resume.pdf");
        form.append("requirements", JSON.stringify({ clusters }));
        await assert.rejects(async () => {
          const response = await fetch(rankUrl, { method: "POST", body: form });
          await response.json();
        }, (error: unknown) => (error as { cause?: { code?: string } }).cause?.code ===
          (slowBody ? "UND_ERR_BODY_TIMEOUT" : "UND_ERR_HEADERS_TIMEOUT"));
        assert.deepEqual(await analyzeResume(clusters, file, "resume.pdf", { ...options, rankUrl }), success);
      });
    }
  } finally {
    setGlobalDispatcher(previous);
    await shortTimeouts.destroy();
  }
});

test("worker can disable automatic retries", async () => {
  let calls = 0;
  await withAnalyzer((_form, response) => { calls++; json(response, 500, {}); }, async rankUrl => {
    await assert.rejects(analyzeResume(clusters, file, "resume.pdf", { ...options, rankUrl, maxRetries: 0 }));
  });
  assert.equal(calls, 1);
});

test("worker retries a connection lost while reading the result with the full original payload", async () => {
  let calls = 0;
  const forms: FormData[] = [];
  const events: AnalysisEvent[] = [];
  await withAnalyzer((form, response) => {
    forms.push(form);
    calls++;
    if (calls === 1) {
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
      response.write('{"clusters":');
      setTimeout(() => response.destroy(), 10);
    } else json(response, 200, success);
  }, async rankUrl => {
    assert.deepEqual(await analyzeResume(clusters, file, "resume.pdf", { ...options, rankUrl }, e => events.push(e)), success);
  });
  assert.equal(calls, 2);
  assert.ok(forms.every(form => form.get("requirements") === JSON.stringify({ clusters })));
  assert.equal(events.find(e => e.type === "retry")?.error_kind, "network");
});

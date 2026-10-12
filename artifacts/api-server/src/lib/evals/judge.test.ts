import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_JUDGE_MODEL, JUDGE_PROMPT_VERSION, LexicalJudge, OpenAiJudge, OpenAiJudgeError } from "./judge";
import { keyTermsPresent, normalizeText, parseCsv, toCsv } from "./text";

const FAKE_KEY = "sk-unit-test-key-must-never-leak";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("text helpers", () => {
  it("normalizes money, punctuation and hyphenated dates", () => {
    expect(normalizeText("Total: $11,050.00.")).toBe("total 11050");
    expect(normalizeText("RTU-2 on 2026-06-14, 3.6 uA")).toBe("rtu 2 on 2026 06 14 3.6 ua");
  });

  it("matches numeric key terms on whole tokens and words by prefix", () => {
    expect(keyTermsPresent(["2"], "logged on 2026-10-11")).toBe(false);
    expect(keyTermsPresent(["2"], "New Blower Motor Belt (2)")).toBe(true);
    expect(keyTermsPresent(["9"], "2019 install")).toBe(false);
    expect(keyTermsPresent(["crease"], "six tabs creased")).toBe(true);
    expect(keyTermsPresent(["west", "11|eleven"], "Eleven hits on the West slope")).toBe(true);
    expect(keyTermsPresent(["west", "11"], "Eleven hits on the West slope")).toBe(false);
  });

  it("round-trips CSV with quotes, commas and newlines", () => {
    const rows = [["a", 'say "hi"', "x,y"], ["multi\nline", "", "z"]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe("LexicalJudge", () => {
  const judge = new LexicalJudge();

  it("uses key terms when present and picks the best candidate", async () => {
    const result = await judge.judgeMatch({ statement: "West slope has 11 hits", keyTerms: ["west", "11"] }, [
      { index: 0, text: "South slope has 11 hits" },
      { index: 1, text: "West slope test square: 11 functional hits" },
    ]);
    expect(result.matchedIndex).toBe(1);
  });

  it("falls back to token coverage", async () => {
    const hit = await judge.judgeMatch({ statement: "Condensate line clogged at the trap" }, [
      { index: 3, text: "The condensate drain line was clogged at the P-trap." },
    ]);
    expect(hit.matchedIndex).toBe(3);
    const miss = await judge.judgeMatch({ statement: "Condensate line clogged at the trap" }, [{ index: 0, text: "Filter replaced." }]);
    expect(miss.matchedIndex).toBeNull();
  });

  it("detects forbidden claims only through declared patterns", async () => {
    expect((await judge.judgeForbidden({ description: "x", patterns: ["\\btotal loss\\b"] }, "This roof is a Total Loss.")).violated).toBe(true);
    expect((await judge.judgeForbidden({ description: "x" }, "anything")).violated).toBe(false);
  });
});

function chatResponse(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAiJudge", () => {
  it("refuses to construct without an API key", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    expect(() => new OpenAiJudge()).toThrow(OpenAiJudgeError);
  });

  it("sends a strict JSON-schema request with store:false and the default evidence model", async () => {
    vi.stubEnv("OPENAI_EVAL_JUDGE_MODEL", "");
    const fetchImpl = vi.fn(async () => chatResponse({ matchedIndex: 1, rationale: "same count" }));
    const judge = new OpenAiJudge({ apiKey: FAKE_KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await judge.judgeMatch({ statement: "West slope has 11 hits" }, [
      { index: 0, text: "south" },
      { index: 1, text: "west 11" },
    ]);
    expect(result.matchedIndex).toBe(1);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_KEY}`);
    const body = JSON.parse(init.body as string);
    expect(body.store).toBe(false);
    expect(body.model).toBe(DEFAULT_JUDGE_MODEL);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[0].role).toBe("system");
    expect(JUDGE_PROMPT_VERSION).toBe("contractor-eval-judge-v1");
  });

  it("uses OPENAI_EVAL_JUDGE_MODEL when set and ignores out-of-range indexes", async () => {
    vi.stubEnv("OPENAI_EVAL_JUDGE_MODEL", "judge-model-x");
    const fetchImpl = vi.fn(async () => chatResponse({ matchedIndex: 7, rationale: "?" }));
    const judge = new OpenAiJudge({ apiKey: FAKE_KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(judge.model).toBe("judge-model-x");
    expect((await judge.judgeMatch({ statement: "a" }, [{ index: 0, text: "b" }])).matchedIndex).toBeNull();
  });

  it("parses boolean verdicts for forbidden claims and required facts", async () => {
    const fetchImpl = vi.fn(async () => chatResponse({ verdict: true, rationale: "asserted" }));
    const judge = new OpenAiJudge({ apiKey: FAKE_KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await judge.judgeForbidden({ description: "claims coverage" }, "It is covered.")).violated).toBe(true);
    expect((await judge.judgeFactPresent({ statement: "three leads" }, "3 leads")).present).toBe(true);
  });

  it("returns fixed errors for non-JSON, refused, incomplete and malformed responses", async () => {
    const PRIVATE = "private evidence body prefix";
    const cases: Array<[Response, string]> = [
      [new Response(`${PRIVATE} <html>`, { status: 200 }), "OpenAI judge response was not valid JSON."],
      [new Response(JSON.stringify({ unexpected: PRIVATE }), { status: 200 }), "OpenAI judge response had an unexpected shape."],
      [
        new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: null, refusal: PRIVATE } }] }), { status: 200 }),
        "OpenAI judge refused to answer.",
      ],
      [
        new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: `{"verdict":tr ${PRIVATE}` } }] }), { status: 200 }),
        "OpenAI judge response was incomplete.",
      ],
      [
        new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: `not json ${PRIVATE}` } }] }), { status: 200 }),
        "OpenAI judge returned invalid verdict JSON.",
      ],
      [
        new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ verdict: "yes", rationale: PRIVATE }) } }] }), {
          status: 200,
        }),
        "OpenAI judge verdict did not match the schema.",
      ],
    ];
    for (const [response, message] of cases) {
      const judge = new OpenAiJudge({ apiKey: FAKE_KEY, fetchImpl: (async () => response) as unknown as typeof fetch });
      const error = await judge.judgeForbidden({ description: "x" }, "text").catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(OpenAiJudgeError);
      expect((error as Error).message).toBe(message);
      expect((error as Error).message).not.toContain(PRIVATE);
    }
  });

  it("rejects a match verdict with a non-integer index", async () => {
    const fetchImpl = vi.fn(async () => chatResponse({ matchedIndex: "1", rationale: "r" }));
    const judge = new OpenAiJudge({ apiKey: FAKE_KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(judge.judgeMatch({ statement: "a" }, [{ index: 1, text: "b" }])).rejects.toThrow("OpenAI judge verdict did not match the schema.");
  });

  it("never leaks the API key or response body in errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(`bad key ${FAKE_KEY} evidence text`, { status: 401 }));
    const judge = new OpenAiJudge({ apiKey: FAKE_KEY, fetchImpl: fetchImpl as unknown as typeof fetch });
    const error = await judge.judgeForbidden({ description: "x" }, "secret evidence").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAiJudgeError);
    expect(String((error as Error).message)).toBe("OpenAI judge request failed with status 401.");
    expect(String((error as Error).message)).not.toContain(FAKE_KEY);

    const throwing = vi.fn(async () => {
      throw new Error(`network down for ${FAKE_KEY}`);
    });
    const offline = new OpenAiJudge({ apiKey: FAKE_KEY, fetchImpl: throwing as unknown as typeof fetch });
    const networkError = await offline.judgeMatch({ statement: "a" }, [{ index: 0, text: "b" }]).catch((caught: unknown) => caught);
    expect(String((networkError as Error).message)).not.toContain(FAKE_KEY);
  });
});

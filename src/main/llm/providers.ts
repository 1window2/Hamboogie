import type {ThinkingLevel} from "@google/genai";
import {z} from "zod";
import {PROVIDER_LABELS} from "@shared/settings";
import type {LlmProviderId} from "@shared/types";
import {
    BATCH_SYSTEM_PROMPT,
    BatchDecisionSchema,
    buildBatchMessage,
    buildUserMessage,
    DecisionSchema,
    SYSTEM_PROMPT,
    type Decision
} from "./decision";
import {errorMessage} from "@shared/errors";

export interface PostInput {
    title: string;
    body: string;
    /** 디시 글 번호입니다. 묶어 보낼 때 LLM이 글을 구분하기 쉽도록 함께 적습니다. */
    no?: number;
    /** 글을 올린 시각(ms)입니다. "30분까지"처럼 시가 빠진 시각을 실제 시각으로 바꾸는 기준입니다. */
    postedAt?: number;
}

export interface LlmProvider {
    decide(post: PostInput): Promise<Decision>;
    /** 여러 글을 요청 하나로 판단합니다. 응답에 빠진 글은 null입니다. */
    decideMany(posts: PostInput[]): Promise<(Decision | null)[]>;
}

export class LlmError extends Error {}

/**
 * 요청 한도를 하루치(또는 결제 한도)까지 다 써서, 잠깐 기다려서는 풀리지 않는 오류입니다.
 * 이때는 한도가 초기화될 때까지 LLM 요청을 멈춥니다. `until`은 다시 시도해도 되는 시각(ms)입니다.
 */
export class LlmQuotaExhaustedError extends LlmError {
    constructor(message: string, readonly until: number) {
        super(message);
    }
}

/** 다음 태평양 시간 자정(ms)입니다. Gemini 무료 등급의 하루 한도가 이때 초기화됩니다. */
export function nextPacificMidnight(now = Date.now()): number {
    const parts = new Intl.DateTimeFormat("en-US", {timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"})
        .formatToParts(new Date(now));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    // 자정을 "24시"로 주는 환경이 있어 시만 24로 나눈 나머지를 씁니다.
    const elapsed = ((get("hour") % 24) * 3600 + get("minute") * 60 + get("second")) * 1000 + now % 1000;
    return now - elapsed + 24 * 60 * 60 * 1000;
}

/**
 * 하루 한도나 결제 한도를 다 쓴 429인지 봅니다. 분당 한도 초과는 응답에 "retry in N s"가 붙어 잠깐 기다리면 풀리므로 빼고,
 * Gemini가 알려 주는 한도 이름(quotaId)에 PerDay가 있거나, 기다릴 시간 없이 "exceeded your current quota"(OpenAI는 insufficient_quota)인 경우입니다.
 */
export function isQuotaExhausted(error: unknown): boolean {
    if ((error as {status?: unknown} | null)?.status !== 429) return false;
    const text = errorMessage(error);
    if (/PerDay/i.test(text)) return true;
    return /insufficient_quota|exceeded your current quota/i.test(text) && !/retry in|retryDelay/i.test(text);
}

/** LLM 응답을 기다리는 최대 시간입니다. 넘으면 실패로 보고 알림으로 넘깁니다. */
export const LLM_TIMEOUT_MS = 30_000;

/** 요청 한도 초과(429) 때 서버가 알려준 대기 시간이 이 이하면 한 번 기다렸다가 다시 시도합니다. */
const RATE_LIMIT_MAX_WAIT_MS = 20_000;

const STATUS_MESSAGES: Record<number, string> = {
    400: "잘못된 요청",
    401: "API 키가 올바르지 않음",
    403: "API 키 권한 없음",
    404: "모델을 찾을 수 없음",
    429: "요청 한도 초과",
    500: "서버 오류",
    503: "서버 과부하",
    504: "응답 시간 초과"
};

/** SDK 오류를 로그와 알림에 쓸 짧은 한국어 메시지로 바꿉니다. */
export function describeLlmError(provider: string, error: unknown): string {
    if (error instanceof LlmError) return error.message;
    const status = typeof (error as {status?: unknown})?.status === "number" ? (error as {status: number}).status : null;
    let detail = errorMessage(error);
    // Gemini는 오류 응답 JSON 전체를 메시지에 담아 보냅니다. 그 안의 message만 꺼냅니다.
    try {
        const parsed = JSON.parse(detail) as {error?: {message?: string}};
        if (parsed.error?.message) detail = parsed.error.message;
    } catch {
        // JSON이 아니면 그대로 씁니다.
    }
    detail = detail.split("\n")[0]!.slice(0, 160);
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return `${provider} 응답 시간 초과 (${LLM_TIMEOUT_MS / 1000}초)`;
    if (status === null) return `${provider} 오류: ${detail}`;
    return `${provider} ${STATUS_MESSAGES[status] ?? "오류"} (${status}): ${detail}`;
}

/**
 * Gemini 오류가 다시 시도할 만하면 기다릴 시간을 돌려줍니다. 429는 응답의 "Please retry in 6.8s"를 쓰고,
 * 서버 쪽 일시적 오류(500, 502, 503 과부하, 504 처리 시간 초과)와 응답 시간 초과는 2초 뒤 한 번 더 보냅니다.
 * 판단에 실패한 글은 키워드가 있어야만 알림으로 넘어가므로, 그사이 올라온 나눔을 놓치지 않기 위해서입니다.
 */
function retryDelayMs(error: unknown): number | null {
    const status = (error as {status?: unknown} | null)?.status;
    if (status === 500 || status === 502 || status === 503 || status === 504) return 2000;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return 2000;
    if (status !== 429 || !(error instanceof Error)) return null;
    const match = /retry in ([\d.]+)s/i.exec(error.message);
    return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

/** 처음 쓸 때 한 번만 만듭니다. 고른 서비스의 SDK만 불러와서, 쓰지 않는 SDK는 메모리에 올리지 않습니다. */
function lazy<T>(create: () => Promise<T>): () => Promise<T> {
    let created: Promise<T> | null = null;
    return () => {
        created ??= create().catch((error: unknown) => {
            created = null;
            throw error;
        });
        return created;
    };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface StructuredRequest<S extends z.ZodType> {
    schema: S;
    /** OpenAI 형식 이름입니다. */
    name: string;
    system: string;
    user: string;
}

/** 시스템 프롬프트와 사용자 메시지를 보내 스키마에 맞는 응답을 받습니다. */
type Structured = <S extends z.ZodType>(request: StructuredRequest<S>) => Promise<z.infer<S>>;

function claudeStructured(apiKey: string, model: string): Structured {
    const sdk = lazy(async () => {
        const [{default: Anthropic}, {zodOutputFormat}] = await Promise.all([import("@anthropic-ai/sdk"), import("@anthropic-ai/sdk/helpers/zod")]);
        return {client: new Anthropic({apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 1}), zodOutputFormat};
    });
    return async ({schema, system, user}) => {
        const {client, zodOutputFormat} = await sdk();
        const response = await client.messages.parse({
            model,
            max_tokens: 8000,
            system,
            messages: [{role: "user", content: user}],
            // 단순 분류라 깊게 생각할 필요가 없습니다.
            output_config: {effort: "low", format: zodOutputFormat(schema)}
        });
        if (response.stop_reason === "refusal") throw new LlmError("Claude가 이 글의 분석을 거절했습니다.");
        if (!response.parsed_output) throw new LlmError(`Claude 응답을 해석하지 못했습니다. (stop_reason: ${response.stop_reason})`);
        return response.parsed_output;
    };
}

function openaiStructured(apiKey: string, model: string): Structured {
    const sdk = lazy(async () => {
        const [{default: OpenAI}, {zodTextFormat}] = await Promise.all([import("openai"), import("openai/helpers/zod")]);
        return {client: new OpenAI({apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 1}), zodTextFormat};
    });
    return async <S extends z.ZodType>({schema, name, system, user}: StructuredRequest<S>) => {
        const {client, zodTextFormat} = await sdk();
        const response = await client.responses.parse({
            model,
            instructions: system,
            input: user,
            text: {format: zodTextFormat(schema, name)}
        });
        if (!response.output_parsed) throw new LlmError("ChatGPT 응답을 해석하지 못했습니다.");
        return response.output_parsed as z.infer<S>;
    };
}

function geminiStructured(apiKey: string, model: string): Structured {
    const sdk = lazy(async () => {
        const {GoogleGenAI, ThinkingLevel} = await import("@google/genai");
        return {client: new GoogleGenAI({apiKey, httpOptions: {timeout: LLM_TIMEOUT_MS}}), minimal: ThinkingLevel.MINIMAL};
    });
    // 단순 분류라 깊게 생각할 필요가 없습니다. 생각을 줄이면 응답이 훨씬 빨라집니다.
    // 모델에 따라 MINIMAL을 지원하지 않으면 그 뒤로는 생각 설정 없이 보냅니다.
    let thinkingSupported = true;

    return async ({schema, system, user}) => {
        const {client, minimal} = await sdk();
        let thinkingConfig: {thinkingLevel: ThinkingLevel} | undefined = thinkingSupported ? {thinkingLevel: minimal} : undefined;
        const generate = () => client.models.generateContent({
            model,
            contents: user,
            config: {
                systemInstruction: system,
                responseMimeType: "application/json",
                responseJsonSchema: z.toJSONSchema(schema),
                ...(thinkingConfig ? {thinkingConfig} : {}),
                abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS)
            }
        });
        let response;
        try {
            response = await generate();
        } catch (error) {
            const wait = retryDelayMs(error);
            if (wait !== null && wait <= RATE_LIMIT_MAX_WAIT_MS) {
                await sleep(wait);
                response = await generate();
            } else if (thinkingConfig && /thinking level/i.test(errorMessage(error))) {
                thinkingSupported = false;
                thinkingConfig = undefined;
                response = await generate();
            } else {
                throw error;
            }
        }
        const text = response.text;
        if (!text) throw new LlmError("Gemini 응답이 비어 있습니다.");
        const parsed = schema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new LlmError("Gemini 응답이 정해진 형식과 다릅니다.");
        return parsed.data;
    };
}

/** 구조화 응답 하나로 판단, 묶음 판단, 골라내기를 만듭니다. */
export function providerFrom(structured: Structured): LlmProvider {
    return {
        decide: (post) => structured({schema: DecisionSchema, name: "decision", system: SYSTEM_PROMPT, user: buildUserMessage(post.title, post.body, post.postedAt)}),
        async decideMany(posts) {
            const result = await structured({schema: BatchDecisionSchema, name: "decisions", system: BATCH_SYSTEM_PROMPT, user: buildBatchMessage(posts)});
            const decisions: (Decision | null)[] = posts.map(() => null);
            for (const {index, ...decision} of result.decisions) {
                // 번호는 1부터입니다. 범위를 벗어나거나 같은 번호가 또 오면 무시합니다.
                if (Number.isInteger(index) && index >= 1 && index <= posts.length && decisions[index - 1] === null) decisions[index - 1] = decision;
            }
            return decisions;
        }
    };
}

export function createProvider(provider: LlmProviderId, apiKey: string, model: string): LlmProvider {
    const structured = provider === "claude" ? claudeStructured(apiKey, model)
        : provider === "openai" ? openaiStructured(apiKey, model)
            : geminiStructured(apiKey, model);
    const label = PROVIDER_LABELS[provider];
    return providerFrom(async (request) => {
        try {
            return await structured(request);
        } catch (error) {
            if (isQuotaExhausted(error)) {
                const until = nextPacificMidnight();
                const reset = new Date(until).toLocaleTimeString("ko-KR", {hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Seoul"});
                throw new LlmQuotaExhaustedError(`${label} 요청 한도를 다 썼습니다(무료 등급이면 하루 한도). 한국 시간 ${reset}에 초기화됩니다.`, until);
            }
            throw new LlmError(describeLlmError(label, error));
        }
    });
}

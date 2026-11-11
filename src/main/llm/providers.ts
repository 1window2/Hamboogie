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
    type AccountsContext,
    type Decision
} from "./decision";
import {errorMessage} from "@shared/errors";
import {kstClockText, nextPacificMidnight} from "@shared/time";

/** LLM에 함께 보낼 사진입니다. `data`는 base64입니다. */
export interface LlmImage {
    mimeType: string;
    data: string;
}

/** 요청 하나에 쓴 토큰 수입니다. `imageTokens`는 알려 주는 서비스(Gemini)만 채웁니다. */
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    imageTokens?: number;
}

export interface PostInput {
    title: string;
    body: string;
    /** 디시 글 번호입니다. 묶어 보낼 때 LLM이 글을 구분하기 쉽도록 함께 적습니다. */
    no?: number;
    /** 글을 올린 시각(ms)입니다. "30분까지"처럼 시가 빠진 시각을 실제 시각으로 바꾸는 기준입니다. */
    postedAt?: number;
    /** 글에 올린 사진입니다. 글 하나를 판단할 때(`decide`)만 보냅니다. */
    images?: LlmImage[];
    /** 대기 계정마다 이 갤러리에서 맡은 완장입니다. 묶어 보낼 때는 첫 글의 것을 씁니다(모두 같은 갤러리 글입니다). */
    accounts?: AccountsContext;
}

export interface LlmProvider {
    decide(post: PostInput): Promise<Decision>;
    /** 여러 글을 요청 하나로 판단합니다. 응답에 빠진 글은 null입니다. */
    decideMany(posts: PostInput[]): Promise<(Decision | null)[]>;
}

/**
 * LLM 판단 실패입니다. `contentRelated`는 글 내용 때문일 수 있는 실패(응답을 해석하지 못함, 거절, 잘못된 요청, 응답 시간 초과)인지입니다.
 * 묶음 판단이 이런 이유로 실패하면 묶인 글 하나 때문일 수 있어 글을 하나씩 다시 판단하고, 키나 모델이 틀렸거나 서비스가 멈춘 것처럼
 * 글과 상관없는 실패면 다시 판단하지 않습니다(요청만 늘어납니다).
 */
export class LlmError extends Error {
    constructor(message: string, readonly contentRelated = true) {
        super(message);
    }
}

/**
 * 요청 한도를 하루치(또는 결제 한도)까지 다 써서, 잠깐 기다려서는 풀리지 않는 오류입니다.
 * 이때는 한도가 초기화될 때까지 LLM 요청을 멈춥니다. `until`은 다시 시도해도 되는 시각(ms)입니다.
 */
export class LlmQuotaExhaustedError extends LlmError {
    constructor(message: string, readonly until: number) {
        super(message, false);
    }
}

/** SDK 오류에 담긴 HTTP 상태 코드입니다. 없으면 null입니다. */
function httpStatus(error: unknown): number | null {
    const status = (error as {status?: unknown} | null)?.status;
    return typeof status === "number" ? status : null;
}

/** 응답을 기다리다 시간이 다 돼 끊긴 오류인지입니다(SDK마다 이름이 다릅니다). */
function isTimeout(error: unknown): boolean {
    return error instanceof Error && (/^(TimeoutError|AbortError|APIConnectionTimeoutError)$/.test(error.name) || error.constructor.name === "APIConnectionTimeoutError"
        || /timed? ?out|시간 초과/i.test(error.message) && httpStatus(error) === null);
}

/** 서버에 닿지 못한 오류(연결 끊김, DNS 실패 등)인지입니다. 상태 코드 없이 연결 오류로 끝난 경우입니다. */
function isConnectionError(error: unknown): boolean {
    if (!(error instanceof Error) || httpStatus(error) !== null) return false;
    return /Connection/.test(error.name) || /Connection/.test(error.constructor.name) || /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network/i.test(error.message);
}

/** 응답 헤더의 retry-after(초)입니다. 없으면 null입니다. */
function retryAfterHeader(error: unknown): number | null {
    const headers = (error as {headers?: unknown} | null)?.headers;
    const value = headers instanceof Headers ? headers.get("retry-after")
        : headers && typeof headers === "object" ? (headers as Record<string, unknown>)["retry-after"] : null;
    const seconds = Number(value);
    return value !== null && value !== undefined && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/**
 * 하루 한도나 결제 한도를 다 쓴 429인지 봅니다. 분당 한도 초과는 응답에 "retry in N s"가 붙어 잠깐 기다리면 풀리므로 빼고,
 * Gemini가 알려 주는 한도 이름(quotaId)에 PerDay가 있거나, 기다릴 시간 없이 "exceeded your current quota"(OpenAI는 insufficient_quota)인 경우입니다.
 */
export function isQuotaExhausted(error: unknown): boolean {
    if (httpStatus(error) !== 429) return false;
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
    const status = httpStatus(error);
    let detail = errorMessage(error);
    // Gemini는 오류 응답 JSON 전체를 메시지에 담아 보냅니다. 그 안의 message만 꺼냅니다.
    try {
        const parsed = JSON.parse(detail) as {error?: {message?: string}};
        if (parsed.error?.message) detail = parsed.error.message;
    } catch {
        // JSON이 아니면 그대로 씁니다.
    }
    detail = detail.split("\n")[0]!.slice(0, 160);
    if (isTimeout(error)) return `${provider} 응답 시간 초과 (${LLM_TIMEOUT_MS / 1000}초)`;
    if (status === null) return `${provider} 오류: ${detail}`;
    return `${provider} ${STATUS_MESSAGES[status] ?? "오류"} (${status}): ${detail}`;
}

/**
 * LLM 오류가 다시 시도할 만하면 기다릴 시간을 돌려줍니다. 429는 응답의 "Please retry in 6.8s"를 쓰고,
 * 서버 쪽 일시적 오류(500, 502, 503 과부하, 504 처리 시간 초과)와 응답 시간 초과는 2초 뒤 한 번 더 보냅니다.
 * 판단에 실패한 글은 키워드가 있어야만 알림으로 넘어가므로, 그사이 올라온 나눔을 놓치지 않기 위해서입니다.
 */
function retryDelayMs(error: unknown): number | null {
    const status = httpStatus(error);
    if (isQuotaExhausted(error)) return null;
    if (status === 408 || status === 409 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return retryAfterHeader(error) ?? 2000;
    if (status === null && (isTimeout(error) || isConnectionError(error))) return 2000;
    if (status !== 429 || !(error instanceof Error)) return null;
    const match = /retry in ([\d.]+)s/i.exec(error.message);
    return match ? Math.ceil(Number(match[1]) * 1000) : retryAfterHeader(error) ?? 2000;
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
    images?: LlmImage[];
}

/** 시스템 프롬프트와 사용자 메시지를 보내 스키마에 맞는 응답을 받습니다. */
type Structured = <S extends z.ZodType>(request: StructuredRequest<S>) => Promise<z.infer<S>>;

type UsageReporter = ((usage: TokenUsage) => void) | undefined;

/** 다시 보내기 전에 부릅니다. 다시 보내는 요청도 분당 요청 한도와 하루 요청 수에 셉니다. */
type RetryHook = (() => Promise<void>) | undefined;

function claudeStructured(apiKey: string, model: string, onUsage: UsageReporter): Structured {
    const sdk = lazy(async () => {
        const [{default: Anthropic}, {zodOutputFormat}] = await Promise.all([import("@anthropic-ai/sdk"), import("@anthropic-ai/sdk/helpers/zod")]);
        return {client: new Anthropic({apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 0}), zodOutputFormat};
    });
    return async ({schema, system, user, images = []}) => {
        const {client, zodOutputFormat} = await sdk();
        const content = [
            {type: "text" as const, text: user},
            ...images.map((image) => ({type: "image" as const, source: {type: "base64" as const, media_type: image.mimeType as "image/jpeg", data: image.data}}))
        ];
        const response = await client.messages.parse({
            model,
            max_tokens: 8000,
            system,
            messages: [{role: "user", content}],
            // 단순 분류라 깊게 생각할 필요가 없습니다.
            output_config: {effort: "low", format: zodOutputFormat(schema)}
        });
        onUsage?.({inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens});
        if (response.stop_reason === "refusal") throw new LlmError("Claude가 이 글의 분석을 거절했습니다.");
        if (!response.parsed_output) throw new LlmError(`Claude 응답을 해석하지 못했습니다. (stop_reason: ${response.stop_reason})`);
        return response.parsed_output;
    };
}

function openaiStructured(apiKey: string, model: string, onUsage: UsageReporter): Structured {
    const sdk = lazy(async () => {
        const [{default: OpenAI}, {zodTextFormat}] = await Promise.all([import("openai"), import("openai/helpers/zod")]);
        return {client: new OpenAI({apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 0}), zodTextFormat};
    });
    return async <S extends z.ZodType>({schema, name, system, user, images = []}: StructuredRequest<S>) => {
        const {client, zodTextFormat} = await sdk();
        const response = await client.responses.parse({
            model,
            instructions: system,
            input: images.length === 0 ? user : [{
                role: "user",
                content: [
                    {type: "input_text", text: user},
                    ...images.map((image) => ({type: "input_image" as const, image_url: `data:${image.mimeType};base64,${image.data}`, detail: "low" as const}))
                ]
            }],
            text: {format: zodTextFormat(schema, name)}
        });
        if (response.usage) onUsage?.({inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens});
        if (!response.output_parsed) throw new LlmError("ChatGPT 응답을 해석하지 못했습니다.");
        return response.output_parsed as z.infer<S>;
    };
}

function geminiStructured(apiKey: string, model: string, onUsage: UsageReporter, beforeRetry: RetryHook): Structured {
    const sdk = lazy(async () => {
        const {GoogleGenAI, ThinkingLevel} = await import("@google/genai");
        return {client: new GoogleGenAI({apiKey, httpOptions: {timeout: LLM_TIMEOUT_MS}}), minimal: ThinkingLevel.MINIMAL};
    });
    // 단순 분류라 깊게 생각할 필요가 없습니다. 생각을 줄이면 응답이 훨씬 빨라집니다.
    // 모델에 따라 MINIMAL을 지원하지 않으면 그 뒤로는 생각 설정 없이 보냅니다.
    let thinkingSupported = true;

    return async ({schema, system, user, images = []}) => {
        const {client, minimal} = await sdk();
        let thinkingConfig: {thinkingLevel: ThinkingLevel} | undefined = thinkingSupported ? {thinkingLevel: minimal} : undefined;
        const contents = images.length === 0 ? user : [{
            role: "user",
            parts: [{text: user}, ...images.map((image) => ({inlineData: {mimeType: image.mimeType, data: image.data}}))]
        }];
        const generate = () => client.models.generateContent({
            model,
            contents,
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
                await beforeRetry?.();
                response = await generate();
            } else if (thinkingConfig && /thinking level/i.test(errorMessage(error))) {
                thinkingSupported = false;
                thinkingConfig = undefined;
                await beforeRetry?.();
                response = await generate();
            } else {
                throw error;
            }
        }
        const usage = response.usageMetadata;
        if (usage) {
            onUsage?.({
                inputTokens: usage.promptTokenCount ?? 0,
                outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
                imageTokens: usage.promptTokensDetails?.find((detail) => detail.modality === "IMAGE")?.tokenCount ?? 0
            });
        }
        const text = response.text;
        if (!text) throw new LlmError("Gemini 응답이 비어 있습니다.");
        const parsed = schema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new LlmError("Gemini 응답이 정해진 형식과 다릅니다.");
        return parsed.data;
    };
}

/** 일시적인 오류면 기다렸다가 한 번 더 보냅니다(Gemini는 자체적으로 같은 규칙을 씁니다). */
function retryOnce(structured: Structured, beforeRetry: RetryHook): Structured {
    return async (request) => {
        try {
            return await structured(request);
        } catch (error) {
            const wait = retryDelayMs(error);
            if (wait === null || wait > RATE_LIMIT_MAX_WAIT_MS || isQuotaExhausted(error)) throw error;
            await sleep(wait);
            await beforeRetry?.();
            return structured(request);
        }
    };
}

/** 구조화 응답 하나로 판단과 묶음 판단을 만듭니다. */
export function providerFrom(structured: Structured): LlmProvider {
    return {
        decide: (post) => structured({
            schema: DecisionSchema, name: "decision", system: SYSTEM_PROMPT,
            user: buildUserMessage(post.title, post.body, post.postedAt, post.images?.length ?? 0, post.accounts), images: post.images
        }),
        async decideMany(posts) {
            const result = await structured({schema: BatchDecisionSchema, name: "decisions", system: BATCH_SYSTEM_PROMPT, user: buildBatchMessage(posts, undefined, posts[0]?.accounts)});
            const decisions: (Decision | null)[] = posts.map(() => null);
            for (const {index, ...decision} of result.decisions) {
                // 번호는 1부터입니다. 범위를 벗어나거나 같은 번호가 또 오면 무시합니다.
                if (Number.isInteger(index) && index >= 1 && index <= posts.length && decisions[index - 1] === null) decisions[index - 1] = decision;
            }
            return decisions;
        }
    };
}

export interface ProviderHooks {
    /** 요청마다 쓴 토큰 수를 받습니다. */
    onUsage?: (usage: TokenUsage) => void;
    /** 일시적인 오류로 같은 요청을 다시 보내기 전에 부릅니다. 다시 보내는 요청도 요청 수에 세게 합니다. */
    beforeRetry?: () => Promise<void>;
}

/**
 * LLM 서비스 클라이언트를 만듭니다. 일시적인 오류(서버 오류, 응답 시간 초과, 짧은 429)는 한 번 더 보냅니다.
 * SDK의 자동 재시도는 끄고 여기서 다시 보내, 다시 보낸 요청도 `beforeRetry`로 분당·하루 요청 수에 셉니다.
 */
export function createProvider(provider: LlmProviderId, apiKey: string, model: string, hooks: ProviderHooks = {}): LlmProvider {
    const {onUsage, beforeRetry} = hooks;
    const structured: Structured = provider === "gemini" ? geminiStructured(apiKey, model, onUsage, beforeRetry) : retryOnce(
        provider === "claude" ? claudeStructured(apiKey, model, onUsage) : openaiStructured(apiKey, model, onUsage), beforeRetry);
    const label = PROVIDER_LABELS[provider];
    return providerFrom(async (request) => {
        try {
            return await structured(request);
        } catch (error) {
            if (isQuotaExhausted(error)) {
                const until = nextPacificMidnight();
                throw new LlmQuotaExhaustedError(`${label} 요청 한도를 다 썼습니다(무료 등급이면 하루 한도). 한국 시간 ${kstClockText(until)}에 초기화됩니다.`, until);
            }
            // 글 내용 때문일 수 있는 실패: 응답 해석·거절(이미 LlmError), 잘못된 요청(400, 413), 응답 시간 초과.
            if (error instanceof LlmError) throw error;
            const status = httpStatus(error);
            throw new LlmError(describeLlmError(label, error), status === 400 || status === 413 || (status === null && isTimeout(error)));
        }
    });
}

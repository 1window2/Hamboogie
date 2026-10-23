import Anthropic from "@anthropic-ai/sdk";
import {zodOutputFormat} from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import {zodTextFormat} from "openai/helpers/zod";
import {ApiError as GeminiApiError, GoogleGenAI, ThinkingLevel} from "@google/genai";
import {z} from "zod";
import type {LlmProviderId} from "@shared/types";
import {
    BATCH_SYSTEM_PROMPT,
    BatchDecisionSchema,
    buildBatchMessage,
    buildUserMessage,
    DecisionSchema,
    SCREEN_BODY_CHAR_LIMIT,
    SCREEN_SYSTEM_PROMPT,
    ScreenSchema,
    SYSTEM_PROMPT,
    type Decision
} from "./decision";

export interface PostInput {
    title: string;
    body: string;
}

export interface LlmProvider {
    decide(post: PostInput): Promise<Decision>;
    /** 여러 글을 요청 하나로 판단합니다. 응답에 빠진 글은 null입니다. */
    decideMany(posts: PostInput[]): Promise<(Decision | null)[]>;
    /** 나눔 글로 보이는 글의 위치(0부터)를 돌려줍니다. */
    screen(posts: PostInput[]): Promise<number[]>;
}

export class LlmError extends Error {}

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
    let detail = error instanceof Error ? error.message : String(error);
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

/** 다시 시도할 만한 오류면 기다릴 시간을 돌려줍니다. 429는 응답의 "Please retry in 6.8s"를, 503(일시적 과부하)은 2초를 씁니다. */
function retryDelayMs(error: unknown): number | null {
    if (!(error instanceof GeminiApiError)) return null;
    if (error.status === 503) return 2000;
    if (error.status !== 429) return null;
    const match = /retry in ([\d.]+)s/i.exec(error.message);
    return match ? Math.ceil(Number(match[1]) * 1000) : null;
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
    const client = new Anthropic({apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 1});
    return async ({schema, system, user}) => {
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
    const client = new OpenAI({apiKey, timeout: LLM_TIMEOUT_MS, maxRetries: 1});
    return async <S extends z.ZodType>({schema, name, system, user}: StructuredRequest<S>) => {
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
    const client = new GoogleGenAI({apiKey, httpOptions: {timeout: LLM_TIMEOUT_MS}});
    // 단순 분류라 깊게 생각할 필요가 없습니다. 생각을 줄이면 응답이 훨씬 빨라집니다.
    // 모델에 따라 MINIMAL을 지원하지 않으면 그 뒤로는 생각 설정 없이 보냅니다.
    let thinkingConfig: {thinkingLevel: ThinkingLevel} | undefined = {thinkingLevel: ThinkingLevel.MINIMAL};

    return async ({schema, system, user}) => {
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
            } else if (thinkingConfig && /thinking level/i.test(error instanceof Error ? error.message : String(error))) {
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
        decide: (post) => structured({schema: DecisionSchema, name: "decision", system: SYSTEM_PROMPT, user: buildUserMessage(post.title, post.body)}),
        async decideMany(posts) {
            const result = await structured({schema: BatchDecisionSchema, name: "decisions", system: BATCH_SYSTEM_PROMPT, user: buildBatchMessage(posts)});
            const decisions: (Decision | null)[] = posts.map(() => null);
            for (const {index, ...decision} of result.decisions) {
                // 번호는 1부터입니다. 범위를 벗어나거나 같은 번호가 또 오면 무시합니다.
                if (Number.isInteger(index) && index >= 1 && index <= posts.length && decisions[index - 1] === null) decisions[index - 1] = decision;
            }
            return decisions;
        },
        async screen(posts) {
            const result = await structured({schema: ScreenSchema, name: "screen", system: SCREEN_SYSTEM_PROMPT, user: buildBatchMessage(posts, SCREEN_BODY_CHAR_LIMIT)});
            const picked = new Set(result.giveaway_indices.filter((index) => Number.isInteger(index) && index >= 1 && index <= posts.length));
            return [...picked].sort((a, b) => a - b).map((index) => index - 1);
        }
    };
}

export function createProvider(provider: LlmProviderId, apiKey: string, model: string): LlmProvider {
    const structured = provider === "claude" ? claudeStructured(apiKey, model)
        : provider === "openai" ? openaiStructured(apiKey, model)
            : geminiStructured(apiKey, model);
    const label = provider === "claude" ? "Claude" : provider === "openai" ? "ChatGPT" : "Gemini";
    return providerFrom(async (request) => {
        try {
            return await structured(request);
        } catch (error) {
            throw new LlmError(describeLlmError(label, error));
        }
    });
}

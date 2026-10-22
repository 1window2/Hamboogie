import Anthropic from "@anthropic-ai/sdk";
import {zodOutputFormat} from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import {zodTextFormat} from "openai/helpers/zod";
import {GoogleGenAI} from "@google/genai";
import {z} from "zod";
import type {LlmProviderId} from "@shared/types";
import {buildUserMessage, DecisionSchema, SYSTEM_PROMPT, type Decision} from "./decision";

export interface PostInput {
    title: string;
    body: string;
}

export interface LlmProvider {
    decide(post: PostInput): Promise<Decision>;
}

export class LlmError extends Error {}

function claudeProvider(apiKey: string, model: string): LlmProvider {
    const client = new Anthropic({apiKey});
    return {
        async decide(post) {
            const response = await client.messages.parse({
                model,
                max_tokens: 4000,
                system: SYSTEM_PROMPT,
                messages: [{role: "user", content: buildUserMessage(post.title, post.body)}],
                // 단순 분류라 깊게 생각할 필요가 없습니다.
                output_config: {effort: "low", format: zodOutputFormat(DecisionSchema)}
            });
            if (response.stop_reason === "refusal") throw new LlmError("Claude가 이 글의 분석을 거절했습니다.");
            if (!response.parsed_output) throw new LlmError(`Claude 응답을 해석하지 못했습니다. (stop_reason: ${response.stop_reason})`);
            return response.parsed_output;
        }
    };
}

function openaiProvider(apiKey: string, model: string): LlmProvider {
    const client = new OpenAI({apiKey});
    return {
        async decide(post) {
            const response = await client.responses.parse({
                model,
                instructions: SYSTEM_PROMPT,
                input: buildUserMessage(post.title, post.body),
                text: {format: zodTextFormat(DecisionSchema, "decision")}
            });
            if (!response.output_parsed) throw new LlmError("ChatGPT 응답을 해석하지 못했습니다.");
            return response.output_parsed;
        }
    };
}

function geminiProvider(apiKey: string, model: string): LlmProvider {
    const client = new GoogleGenAI({apiKey});
    const jsonSchema = z.toJSONSchema(DecisionSchema);
    return {
        async decide(post) {
            const response = await client.models.generateContent({
                model,
                contents: buildUserMessage(post.title, post.body),
                config: {
                    systemInstruction: SYSTEM_PROMPT,
                    responseMimeType: "application/json",
                    responseJsonSchema: jsonSchema
                }
            });
            const text = response.text;
            if (!text) throw new LlmError("Gemini 응답이 비어 있습니다.");
            const parsed = DecisionSchema.safeParse(JSON.parse(text));
            if (!parsed.success) throw new LlmError("Gemini 응답이 정해진 형식과 다릅니다.");
            return parsed.data;
        }
    };
}

export function createProvider(provider: LlmProviderId, apiKey: string, model: string): LlmProvider {
    switch (provider) {
        case "claude":
            return claudeProvider(apiKey, model);
        case "openai":
            return openaiProvider(apiKey, model);
        case "gemini":
            return geminiProvider(apiKey, model);
    }
}

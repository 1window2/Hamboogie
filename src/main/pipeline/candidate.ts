import type {Decision} from "../llm/decision";
import type {PostInput} from "../llm/providers";
import type {Plan} from "./planner";

/** 올라온 지 이보다 오래된 글에는 자동으로 줄 서지 않습니다. 오래 쉬었다가 다시 확인할 때 지난 나눔에 줄 서지 않기 위해서입니다. */
export const STALE_POST_MS = 60 * 60 * 1000;

export interface NewPost {
    no: number;
    title: string;
    /** 목록에 나온 작성 시각 문자열(한국 시간)입니다. */
    dateTime?: string;
}

export interface Analysis {
    /** LLM 판단입니다. 분석이 실패하면 null입니다. */
    decision: Decision | null;
    plan: Plan;
}

export type CommentPlan = Extract<Plan, {kind: "comment"}>;

/** LLM으로 판단할 글입니다. 본문을 읽지 않았으면 body가 비어 있습니다. */
export interface Candidate {
    post: NewPost;
    title: string;
    body: string;
    /** 본문을 실제로 읽었는지입니다. 읽지 않은 글은 본문의 조건(봇 색출 등)을 확인할 수 없어 자동으로 줄 서지 않습니다. */
    bodyRead: boolean;
    /** 제목이나 본문에 키워드가 있는 글입니다. 판단에 실패하면 이런 글만 알립니다. */
    keyword: boolean;
    detectedAt: number;
    /** 글을 올린 시각 추정값입니다. 확실하지 않으면 늦은 쪽(감지한 시각)으로 잡습니다. */
    postedAt: number;
    /** 작성 시각 추정값이 실제보다 늦을 수 있는 최대 시간입니다. 마감을 이만큼 앞당겨 봅니다. */
    postedSlackMs: number;
    /** 본문에 나온 작성 시각 문자열입니다. */
    dateTime?: string;
    /** 글에 올린 사진 주소입니다(앞에서부터 몇 장). 나눔으로 보인 글을 다시 판단할 때 사진까지 함께 봅니다. */
    images: string[];
}

/** LLM에 보낸 내용과 판단 원문 기록입니다. */
export interface JudgmentRecord {
    time: number;
    galleryId: string;
    /** "batch"는 여러 글 묶음 판단(또는 글 하나 판단), "confirm"은 2차 확인입니다. */
    kind: "batch" | "confirm";
    /** 쓴 LLM 서비스와 모델입니다. */
    model: string;
    /** 시스템 지시문의 이름입니다. 지시문 원문은 코드(src/main/llm/decision.ts)에 있습니다. */
    systemPrompt: "SYSTEM_PROMPT" | "BATCH_SYSTEM_PROMPT";
    /** LLM에 보낸 사용자 메시지 원문입니다. */
    message: string;
    /** 글마다 감지한 시각, 추정한 작성 시각(ms), 디시가 준 작성 시각 문자열(없으면 null)도 함께 남깁니다. */
    posts: {no: number; title: string; bodyRead: boolean; keyword: boolean; detectedAt: number; postedAt: number; dateTime: string | null; images?: string[]}[];
    /** 글마다 LLM이 돌려준 판단입니다(posts와 같은 순서, 빠진 글은 null). */
    decisions: (Decision | null)[];
}

/** 감시로 찾은 글의 줄 서기입니다. 개발 모드 테스트(`live`가 없음)와 구분합니다. */
export interface Live {
    /** 예약할 때의 세대입니다. 사용자가 감시를 멈추면 세대가 바뀌어, 그 전에 시작한 일은 댓글을 달지 않습니다. */
    epoch: number;
}

/** 로그인된 계정이 없어 디시에 요청하지 않았다는 오류입니다. 읽던 글은 다음 확인 때 다시 봅니다. */
export class NotLoggedInError extends Error {
    constructor() {
        super("로그인된 계정이 없어 디시에 요청하지 않았습니다.");
    }
}

/** LLM에 보낼 글 내용입니다. */
export function toPostInput({post, title, body, postedAt}: Candidate): PostInput {
    return {no: post.no, title, body, postedAt};
}

/** 글을 올린 시각 범위에서 판단 기준 시각(늦은 쪽)과, 그것이 실제보다 늦을 수 있는 최대 시간을 꺼냅니다. */
export function postedTimes(range: {earliest: number; latest: number}): Pick<Candidate, "postedAt" | "postedSlackMs"> {
    return {postedAt: range.latest, postedSlackMs: range.latest - range.earliest};
}

/** LLM 판단을 로그에 남길 짧은 문장으로 줄입니다. */
export function describeDecision(decision: Decision): string {
    const parts = [
        decision.is_food ? "음식" : "음식 아님",
        decision.line_method === "text" ? `텍스트 댓글${decision.line_text ? ` "${decision.line_text}"` : ""}` : decision.line_method === "dccon" ? `디시콘 "${decision.dccon_keyword ?? ""}"` : "방법 불분명",
        decision.member_requirement !== "any" ? `자격 ${decision.member_requirement}` : null,
        decision.starts_at ? `시작 ${decision.starts_at}` : null,
        decision.ends_at ? `마감 ${decision.ends_at}` : null,
        decision.needs_extra_action ? "댓글 외 행동 필요" : null
    ];
    return parts.filter(Boolean).join(", ");
}

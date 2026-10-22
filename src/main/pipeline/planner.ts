import type {GalleryConfig, MemberType} from "@shared/types";
import {DEFAULT_COMMENT_TEXT} from "@shared/settings";
import type {Decision} from "../llm/decision";

export interface OwnedDccon {
    packageIdx: number;
    detailIdx: number;
    title: string;
    packageTitle: string;
}

/** 계획을 세울 때 필요한 계정 정보입니다. 로그인되지 않은 계정은 넘기지 않습니다. */
export interface CandidateAccount {
    id: string;
    /** 알 수 없으면 null입니다. 이때는 고닉/반고닉 전용 줄에 서지 않습니다. */
    memberType: MemberType | null;
    dccons: OwnedDccon[];
}

export type CommentContent = {type: "text"; text: string} | {type: "dccon"; dccon: OwnedDccon};

export type Plan =
    | {kind: "skip"; reason: string}
    | {kind: "notify"; reason: string}
    | {kind: "comment"; notBefore: number; attempts: {accountId: string; content: CommentContent}[]};

const TEXT_MAX_LENGTH = 30;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `HH:MM`(한국 시간)을 기준 시각 이후의 가장 가까운 시각으로 바꿉니다. 기준보다 이르면 다음 날로 봅니다. */
export function resolveClock(clock: string, reference: number): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 24 || minutes > 59) return null;
    const kst = new Date(reference + KST_OFFSET_MS);
    const dayStartKst = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
    let candidate = dayStartKst + (hours * 60 + minutes) * 60 * 1000 - KST_OFFSET_MS;
    if (candidate < reference) candidate += 24 * 60 * 60 * 1000;
    return candidate;
}

function eligible(account: CandidateAccount, requirement: Decision["member_requirement"]): boolean {
    switch (requirement) {
        case "any":
        case "member":
            return true;
        case "gonick":
            return account.memberType === "gonick";
        case "semi":
            return account.memberType === "semi";
        case "anonymous":
            return false;
    }
}

/** 텍스트 댓글로 쓰기에 안전한 문구인지 확인합니다. */
export function isSafeCommentText(text: string): boolean {
    if (text.length === 0 || text.length > TEXT_MAX_LENGTH) return false;
    if (/[\r\n]/.test(text)) return false;
    if (/https?:|www\.|\.(com|net|kr|io|me)\b/i.test(text)) return false;
    if (/\d{3,}[-\s]?\d{3,}/.test(text)) return false;
    if (/@/.test(text)) return false;
    return true;
}

function compact(text: string): string {
    return text.replace(/\s+/g, "").toLowerCase();
}

export function findDccon(dccons: OwnedDccon[], keyword: string): OwnedDccon | null {
    const needle = compact(keyword);
    if (!needle) return null;
    return dccons.find((dccon) => compact(dccon.title).includes(needle))
        ?? dccons.find((dccon) => compact(dccon.packageTitle).includes(needle))
        ?? null;
}

/**
 * LLM 판단을 실제 행동 계획으로 바꿉니다.
 *
 * @param accounts 갤러리의 대기 계정을 우선순위 순서로, 로그인된 것만 넘깁니다.
 * @param detectedAt 글을 감지한 시각(ms)입니다.
 */
export function makePlan(decision: Decision, gallery: GalleryConfig, accounts: CandidateAccount[], detectedAt: number): Plan {
    if (!decision.is_giveaway) return {kind: "skip", reason: "나눔 글이 아님"};
    if (gallery.category === "food" && !decision.is_food) return {kind: "skip", reason: "음식 나눔이 아님"};

    if (decision.ends_at) {
        const endsAt = resolveClock(decision.ends_at, detectedAt);
        // 감지 시각 기준으로 다음 날로 넘어갔다면 이미 지난 마감으로 봅니다(12시간 이상 남은 경우).
        if (endsAt !== null && endsAt - detectedAt > 12 * 60 * 60 * 1000) {
            return {kind: "skip", reason: `마감 시각(${decision.ends_at})이 지남`};
        }
    }

    const qualified = accounts.filter((account) => eligible(account, decision.member_requirement));
    if (qualified.length === 0) return {kind: "skip", reason: "참여 자격에 맞는 대기 계정이 없음"};

    if (decision.needs_extra_action) return {kind: "notify", reason: `댓글 외의 행동이 필요함: ${decision.reason}`};
    if (decision.line_method === "unclear") return {kind: "notify", reason: `줄 서는 방법을 판단할 수 없음: ${decision.reason}`};

    let notBefore = detectedAt;
    if (decision.starts_at) {
        const startsAt = resolveClock(decision.starts_at, detectedAt);
        if (startsAt === null) return {kind: "notify", reason: `시작 시각을 해석할 수 없음: ${decision.starts_at}`};
        // 12시간 넘게 남았다면 이미 시작된 줄로 봅니다.
        if (startsAt - detectedAt <= 12 * 60 * 60 * 1000) notBefore = startsAt;
    }
    notBefore += gallery.delaySec * 1000;

    if (decision.line_method === "text") {
        const text = decision.line_text?.trim() || DEFAULT_COMMENT_TEXT;
        if (!isSafeCommentText(text)) return {kind: "notify", reason: `요구 문구를 자동으로 달기 어려움: "${text}"`};
        return {kind: "comment", notBefore, attempts: qualified.map((account) => ({accountId: account.id, content: {type: "text", text}}))};
    }

    const keyword = decision.dccon_keyword?.trim() ?? "";
    const attempts = qualified.flatMap((account) => {
        const dccon = findDccon(account.dccons, keyword);
        return dccon ? [{accountId: account.id, content: {type: "dccon" as const, dccon}}] : [];
    });
    if (attempts.length === 0) return {kind: "notify", reason: `요구 디시콘("${keyword}")을 가진 대기 계정이 없음`};
    return {kind: "comment", notBefore, attempts};
}

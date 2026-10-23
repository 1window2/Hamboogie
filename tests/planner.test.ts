import {describe, expect, it} from "vitest";
import {newGallery} from "@shared/settings";
import type {Decision} from "../src/main/llm/decision";
import {isSafeCommentText, makePlan, resolveClock, START_MARGIN_MS, type CandidateAccount} from "../src/main/pipeline/planner";

// 2026-10-23 14:00 (한국 시간)
const NOW = Date.UTC(2026, 9, 23, 5, 0);

const gallery = {...newGallery("g1"), galleryId: "gf2", accountIds: ["a", "b"]};

const gonick: CandidateAccount = {id: "a", memberType: "gonick", dccons: []};
const semi: CandidateAccount = {
    id: "b",
    memberType: "semi",
    dccons: [{packageIdx: 1, detailIdx: 11, title: "햄버거 먹는 콘", packageTitle: "음식콘"}]
};

function decision(patch: Partial<Decision> = {}): Decision {
    return {
        is_giveaway: true,
        is_food: true,
        line_method: "text",
        line_text: null,
        dccon_keyword: null,
        member_requirement: "any",
        starts_at: null,
        ends_at: null,
        needs_extra_action: false,
        reason: "테스트",
        ...patch
    };
}

describe("makePlan", () => {
    it("특정 문구가 없으면 기본 문구 '줄'로 우선순위 순서대로 시도한다", () => {
        const plan = makePlan(decision(), gallery, [gonick, semi], NOW);
        expect(plan).toEqual({
            kind: "comment",
            notBefore: NOW,
            attempts: [
                {accountId: "a", content: {type: "text", text: "줄"}},
                {accountId: "b", content: {type: "text", text: "줄"}}
            ]
        });
    });

    it("나눔 글이 아니거나 음식만 설정에서 음식이 아니면 넘어간다", () => {
        expect(makePlan(decision({is_giveaway: false}), gallery, [gonick], NOW).kind).toBe("skip");
        expect(makePlan(decision({is_food: false}), gallery, [gonick], NOW).kind).toBe("skip");
        expect(makePlan(decision({is_food: false}), {...gallery, category: "all"}, [gonick], NOW).kind).toBe("comment");
    });

    it("고닉 전용 줄에는 고닉 계정만 서고, 맞는 계정이 없으면 알림 없이 넘어간다", () => {
        const plan = makePlan(decision({member_requirement: "gonick"}), gallery, [semi, gonick], NOW);
        expect(plan.kind === "comment" && plan.attempts.map((attempt) => attempt.accountId)).toEqual(["a"]);
        expect(makePlan(decision({member_requirement: "gonick"}), gallery, [semi], NOW)).toMatchObject({kind: "skip"});
        expect(makePlan(decision({member_requirement: "anonymous"}), gallery, [gonick, semi], NOW)).toMatchObject({kind: "skip"});
    });

    it("계정 종류를 모르면 고닉/반고닉 전용 줄에 서지 않는다", () => {
        const unknown: CandidateAccount = {id: "c", memberType: null, dccons: []};
        expect(makePlan(decision({member_requirement: "gonick"}), gallery, [unknown], NOW).kind).toBe("skip");
        expect(makePlan(decision({member_requirement: "any"}), gallery, [unknown], NOW).kind).toBe("comment");
    });

    it("마감이 지났으면 넘어가고, 시작 시각 전이면 시작 시각 + 지연 시간까지 기다린다", () => {
        expect(makePlan(decision({ends_at: "13:30"}), gallery, [gonick], NOW).kind).toBe("skip");
        expect(makePlan(decision({ends_at: "14:30"}), gallery, [gonick], NOW).kind).toBe("comment");
        const plan = makePlan(decision({starts_at: "14:10"}), {...gallery, delaySec: 5}, [gonick], NOW);
        expect(plan.kind === "comment" && plan.notBefore).toBe(NOW + 10 * 60 * 1000 + START_MARGIN_MS + 5000);
    });

    it("지연 시간을 더하면 마감을 넘기는 줄은 서지 않고, 서는 줄에는 마감 시각을 붙인다", () => {
        // 14:00 감지, 14:01 마감
        expect(makePlan(decision({ends_at: "14:01"}), {...gallery, delaySec: 120}, [gonick], NOW)).toMatchObject({kind: "skip", reason: expect.stringContaining("줄 서기 지연")});
        const plan = makePlan(decision({ends_at: "14:01"}), {...gallery, delaySec: 30}, [gonick], NOW);
        expect(plan).toMatchObject({kind: "comment", deadline: NOW + 60 * 1000});
        expect(makePlan(decision({starts_at: "14:05", ends_at: "14:03"}), gallery, [gonick], NOW).kind).toBe("skip");
    });

    it("로그인된 대기 계정이 하나도 없으면 넘기지 않고 알림을 보낸다", () => {
        expect(makePlan(decision(), gallery, [], NOW)).toMatchObject({kind: "notify", reason: expect.stringContaining("로그인된 대기 계정이 없어")});
        // 나눔 글이 아니면 계정과 상관없이 그냥 넘어갑니다.
        expect(makePlan(decision({is_giveaway: false}), gallery, [], NOW).kind).toBe("skip");
    });

    it("디시콘 줄은 그 디시콘을 가진 계정만 서고, 아무도 없으면 알림을 보낸다", () => {
        const plan = makePlan(decision({line_method: "dccon", dccon_keyword: "햄버거"}), gallery, [gonick, semi], NOW);
        expect(plan.kind === "comment" && plan.attempts).toEqual([
            {accountId: "b", content: {type: "dccon", dccon: semi.dccons[0]}}
        ]);
        expect(makePlan(decision({line_method: "dccon", dccon_keyword: "피자"}), gallery, [gonick, semi], NOW).kind).toBe("notify");
    });

    it("판단 불가, 추가 행동 요구, 위험한 문구는 알림으로 넘긴다", () => {
        expect(makePlan(decision({line_method: "unclear"}), gallery, [gonick], NOW).kind).toBe("notify");
        expect(makePlan(decision({needs_extra_action: true}), gallery, [gonick], NOW).kind).toBe("notify");
        expect(makePlan(decision({line_text: "010-1234-5678"}), gallery, [gonick], NOW).kind).toBe("notify");
    });
});

describe("resolveClock", () => {
    it("기준 시각 이후의 가장 가까운 시각을 돌려준다", () => {
        expect(resolveClock("15:00", NOW)).toBe(NOW + 60 * 60 * 1000);
        expect(resolveClock("13:00", NOW)).toBe(NOW + 23 * 60 * 60 * 1000);
        expect(resolveClock("25:00", NOW)).toBeNull();
        expect(resolveClock("오후 3시", NOW)).toBeNull();
    });
});

describe("isSafeCommentText", () => {
    it("짧은 일반 문구만 허용한다", () => {
        expect(isSafeCommentText("줄")).toBe(true);
        expect(isSafeCommentText("햄버거 주세요")).toBe(true);
        expect(isSafeCommentText("https://example.com")).toBe(false);
        expect(isSafeCommentText("a@b")).toBe(false);
        expect(isSafeCommentText("가".repeat(31))).toBe(false);
    });
});

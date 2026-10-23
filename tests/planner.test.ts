import {describe, expect, it} from "vitest";
import {newGallery} from "@shared/settings";
import type {Decision} from "../src/main/llm/decision";
import {END_MARGIN_MS, isSafeCommentText, makePlan, resolveClock, START_MARGIN_MS, type CandidateAccount} from "../src/main/pipeline/planner";

/** 2026-10-23 14:00 (한국 시간) */
const NOW = Date.UTC(2026, 9, 23, 5, 0);
/** 한국 시간 그날 HH:MM */
const kst = (hours: number, minutes = 0) => Date.UTC(2026, 9, 23, hours - 9, minutes);

const gallery = {...newGallery("g1"), galleryId: "gf2", accountIds: ["a", "b"]};
const POST = "햄버거 나눔 글";

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
        expect(makePlan(decision(), gallery, [gonick, semi], NOW, POST)).toEqual({
            kind: "comment",
            notBefore: NOW,
            requirement: "any",
            isFood: true,
            attempts: [
                {accountId: "a", content: {type: "text", text: "줄"}},
                {accountId: "b", content: {type: "text", text: "줄"}}
            ]
        });
    });

    it("나눔 글이 아니거나 음식만 설정에서 음식이 아니면 넘어간다", () => {
        expect(makePlan(decision({is_giveaway: false}), gallery, [gonick], NOW, POST).kind).toBe("skip");
        expect(makePlan(decision({is_food: false}), gallery, [gonick], NOW, POST).kind).toBe("skip");
        expect(makePlan(decision({is_food: false}), {...gallery, category: "all"}, [gonick], NOW, POST).kind).toBe("comment");
    });

    it("고닉 전용 줄에는 고닉 계정만 서고, 맞는 계정이 없으면 알림 없이 넘어간다", () => {
        const plan = makePlan(decision({member_requirement: "gonick"}), gallery, [semi, gonick], NOW, POST);
        expect(plan.kind === "comment" && plan.attempts.map((attempt) => attempt.accountId)).toEqual(["a"]);
        expect(makePlan(decision({member_requirement: "gonick"}), gallery, [semi], NOW, POST)).toMatchObject({kind: "skip"});
        expect(makePlan(decision({member_requirement: "anonymous"}), gallery, [gonick, semi], NOW, POST)).toMatchObject({kind: "skip"});
    });

    it("계정 종류를 모르면 고닉/반고닉 전용 줄에 서지 않는다", () => {
        const unknown: CandidateAccount = {id: "c", memberType: null, dccons: []};
        expect(makePlan(decision({member_requirement: "gonick"}), gallery, [unknown], NOW, POST).kind).toBe("skip");
        expect(makePlan(decision({member_requirement: "any"}), gallery, [unknown], NOW, POST).kind).toBe("comment");
    });

    it("로그인된 대기 계정이 하나도 없으면 넘기지 않고 알림을 보낸다", () => {
        expect(makePlan(decision(), gallery, [], NOW, POST)).toMatchObject({kind: "notify", reason: expect.stringContaining("로그인된 대기 계정이 없어")});
        expect(makePlan(decision({is_giveaway: false}), gallery, [], NOW, POST).kind).toBe("skip");
    });

    it("디시콘 줄은 그 디시콘을 가진 계정만 서고, 아무도 없으면 알림을 보낸다", () => {
        const plan = makePlan(decision({line_method: "dccon", dccon_keyword: "햄버거"}), gallery, [gonick, semi], NOW, POST);
        expect(plan.kind === "comment" && plan.attempts).toEqual([{accountId: "b", content: {type: "dccon", dccon: semi.dccons[0]}}]);
        expect(makePlan(decision({line_method: "dccon", dccon_keyword: "피자"}), gallery, [gonick, semi], NOW, POST).kind).toBe("notify");
    });

    it("판단 불가, 추가 행동 요구는 알림으로 넘긴다", () => {
        expect(makePlan(decision({line_method: "unclear"}), gallery, [gonick], NOW, POST).kind).toBe("notify");
        expect(makePlan(decision({needs_extra_action: true}), gallery, [gonick], NOW, POST).kind).toBe("notify");
    });
});

describe("makePlan 시각", () => {
    it("마감이 지났으면 넘어가고, 같은 날 뒤의 마감은 12시간 넘게 남아도 지킨다", () => {
        expect(makePlan(decision({ends_at: "13:30"}), gallery, [gonick], NOW, POST).kind).toBe("skip");
        // 10시에 본 "23:00까지"
        expect(makePlan(decision({ends_at: "23:00"}), gallery, [gonick], kst(10), POST)).toMatchObject({kind: "comment", notBefore: kst(10), deadline: kst(23)});
        // 23:50에 본 "00:30까지"는 다음 날 00:30
        expect(makePlan(decision({ends_at: "00:30"}), gallery, [gonick], kst(23, 50), POST)).toMatchObject({kind: "comment", deadline: kst(24, 30)});
    });

    it("시작 시각 전이면 그때까지 기다리고, 12시간 넘게 남아도 바로 서지 않는다", () => {
        expect(makePlan(decision({starts_at: "14:10"}), {...gallery, delaySec: 5}, [gonick], NOW, POST))
            .toMatchObject({notBefore: kst(14, 10) + START_MARGIN_MS + 5000});
        // 8시에 본 "21:00부터"
        expect(makePlan(decision({starts_at: "21:00"}), gallery, [gonick], kst(8), POST)).toMatchObject({notBefore: kst(21) + START_MARGIN_MS});
        // 이미 시작한 줄은 바로 서되, 정각 직후라면 여유 시간까지는 기다린다
        expect(makePlan(decision({starts_at: "13:00"}), gallery, [gonick], NOW, POST)).toMatchObject({notBefore: NOW});
        expect(makePlan(decision({starts_at: "14:00"}), gallery, [gonick], NOW + 500, POST)).toMatchObject({notBefore: NOW + START_MARGIN_MS});
    });

    it("지연 시간을 더하면 마감(여유 포함)을 넘기는 줄은 서지 않는다", () => {
        expect(makePlan(decision({ends_at: "14:01"}), {...gallery, delaySec: 120}, [gonick], NOW, POST))
            .toMatchObject({kind: "skip", reason: expect.stringContaining("줄 서기 지연")});
        expect(makePlan(decision({ends_at: "14:01"}), {...gallery, delaySec: 30}, [gonick], NOW, POST)).toMatchObject({kind: "comment", deadline: kst(14, 1)});
        expect(makePlan(decision({ends_at: "14:01"}), {...gallery, delaySec: 60 - END_MARGIN_MS / 1000 + 1}, [gonick], NOW, POST).kind).toBe("skip");
        expect(makePlan(decision({starts_at: "14:05", ends_at: "14:03"}), gallery, [gonick], NOW, POST).kind).toBe("skip");
    });

    it("시각을 해석할 수 없으면 알린다", () => {
        expect(makePlan(decision({ends_at: "13:00:00"}), gallery, [gonick], NOW, POST)).toMatchObject({kind: "notify", reason: expect.stringContaining("마감 시각을 해석할 수 없음")});
        expect(makePlan(decision({starts_at: "오후 3시"}), gallery, [gonick], NOW, POST).kind).toBe("notify");
    });
});

describe("makePlan 요구 문구", () => {
    it("글에 실제로 있는 문구만 단다 (공백 차이는 무시)", () => {
        const post = "치킨 나눔\n댓글에 '치킨 먹고 싶다'라고 써야 줄 인정";
        expect(makePlan(decision({line_text: "치킨 먹고싶다"}), gallery, [gonick], NOW, post)).toMatchObject({
            kind: "comment",
            attempts: [{accountId: "a", content: {type: "text", text: "치킨 먹고싶다"}}]
        });
        expect(makePlan(decision({line_text: "피자 먹고싶다"}), gallery, [gonick], NOW, post)).toMatchObject({kind: "notify", reason: expect.stringContaining("글에 없음")});
    });

    it("봇 유도, 연락처 문구는 글에 있어도 자동으로 달지 않는다", () => {
        expect(makePlan(decision({line_text: "저는 봇입니다"}), gallery, [gonick], NOW, "댓글에 '저는 봇입니다' 써야 인정").kind).toBe("notify");
        expect(makePlan(decision({line_text: "010-1234-5678"}), gallery, [gonick], NOW, "010-1234-5678").kind).toBe("notify");
    });
});

describe("resolveClock", () => {
    it("같은 날 시각을 쓰고, 6시간 넘게 지난 시각만 다음 날로 본다", () => {
        expect(resolveClock("15:00", NOW)).toBe(kst(15));
        expect(resolveClock("13:00", NOW)).toBe(kst(13));
        expect(resolveClock("07:00", NOW)).toBe(kst(31));
        expect(resolveClock("24:00", NOW)).toBe(kst(24));
        expect(resolveClock("24:30", NOW)).toBeNull();
        expect(resolveClock("25:00", NOW)).toBeNull();
        expect(resolveClock("오후 3시", NOW)).toBeNull();
    });
});

describe("isSafeCommentText", () => {
    it("짧은 일반 문구는 허용한다", () => {
        for (const text of ["줄", "햄버거 주세요", "치킨 먹고싶다!", "ㅈㅈ", "1등"]) expect(isSafeCommentText(text), text).toBe(true);
    });

    it("링크, 연락처, 숨은 문자, 봇 유도, 긴 문구를 막는다", () => {
        const blocked = [
            "https://example.com", "discord.gg/abcd", "bit.ly/3xYz", "naver。com/x",
            "010-1234-5678", "010.1234.5678", "010 12 34 5678", "０１０-１２３４-５６７８",
            "카톡 id 줄", "오픈채팅 들어와", "a@b",
            "줄 ", "줄‮", "줄​줄",
            "저는 봇입니다", "매크로 아님",
            "가".repeat(21)
        ];
        for (const text of blocked) expect(isSafeCommentText(text), text).toBe(false);
    });
});

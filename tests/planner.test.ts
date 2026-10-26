import {describe, expect, it} from "vitest";
import {newGallery} from "@shared/settings";
import type {Decision} from "../src/main/llm/decision";
import {END_MARGIN_MS, findBaitWord, isSafeCommentText, makePlan, resolveClock, START_MARGIN_MS, type CandidateAccount} from "../src/main/pipeline/planner";

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
        text_only: false,
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
        expect(makePlan(decision({ends_at: "13:00:61"}), gallery, [gonick], NOW, POST)).toMatchObject({kind: "notify", reason: expect.stringContaining("마감 시각을 해석할 수 없음")});
        expect(makePlan(decision({starts_at: "오후 3시"}), gallery, [gonick], NOW, POST).kind).toBe("notify");
    });
});

describe("makePlan 상대 시각", () => {
    it("LLM이 초까지 바꾼 'N분 뒤부터'는 그 초 뒤에 선다", () => {
        // 14:00:00에 감지한, 13:59:40에 올라온 "10분 뒤부터" 글
        const seconds = 40 * 1000;
        expect(makePlan(decision({starts_at: "14:09:40"}), gallery, [gonick], kst(14), POST))
            .toMatchObject({kind: "comment", notBefore: kst(14, 9) + seconds + START_MARGIN_MS});
    });

    it("작성 시각을 초까지 모르면 그만큼 마감을 앞당겨 본다", () => {
        // 14:29:30에 본 "14:30까지"는 그냥이면 서지만, 작성 시각이 59초까지 늦게 잡혔을 수 있으면 마감이 지난 것으로 봅니다.
        const seen = kst(14, 29) + 30 * 1000;
        expect(makePlan(decision({ends_at: "14:30"}), gallery, [gonick], seen, POST).kind).toBe("comment");
        expect(makePlan(decision({ends_at: "14:30"}), gallery, [gonick], seen, POST, 59 * 1000).kind).toBe("skip");
    });

    it("'30분까지'를 바꾼 마감을 지키고, 지났으면 서지 않는다", () => {
        expect(makePlan(decision({ends_at: "14:30"}), gallery, [gonick], kst(14, 19), POST)).toMatchObject({kind: "comment", deadline: kst(14, 30)});
        expect(makePlan(decision({ends_at: "14:30"}), gallery, [gonick], kst(14, 31), POST).kind).toBe("skip");
    });
});

describe("makePlan 시작 시각 빠짐", () => {
    it("글에 '~시부터', '~분 뒤부터'가 있는데 시작 시각이 비어 있으면 서지 않고 알린다", () => {
        for (const text of ["버거 나눔 오후 9시부터 줄 받음", "21:00부터 줄", "9시 반부터 줄", "10분 뒤부터 줄"]) {
            expect(makePlan(decision(), gallery, [gonick], NOW, text)).toMatchObject({kind: "notify", reason: expect.stringContaining("시작 시각")});
        }
        expect(makePlan(decision({starts_at: "21:00"}), gallery, [gonick], NOW, "오후 9시부터 줄").kind).toBe("comment");
        expect(makePlan(decision(), gallery, [gonick], NOW, "버거 3개 나눔 30분까지 줄").kind).toBe("comment");
    });
});

describe("makePlan 기본 디시콘", () => {
    const burger = {packageIdx: 1, detailIdx: 11, title: "1", packageTitle: "음식콘"};
    const pizza = {packageIdx: 1, detailIdx: 12, title: "2", packageTitle: "음식콘"};
    const withDefaults: CandidateAccount = {id: "a", memberType: "gonick", dccons: [burger, pizza], defaultDccons: [burger, pizza]};
    const contents = (plan: ReturnType<typeof makePlan>) => (plan.kind === "comment" ? plan.attempts.map((attempt) => attempt.content) : plan.kind);

    it("문구 지정이 없는 줄에는 기본 디시콘 가운데 무작위로 하나를 단다", () => {
        expect(contents(makePlan(decision(), gallery, [withDefaults], NOW, POST, 0, () => 0))).toEqual([{type: "dccon", dccon: burger}]);
        expect(contents(makePlan(decision(), gallery, [withDefaults], NOW, POST, 0, () => 0.99))).toEqual([{type: "dccon", dccon: pizza}]);
    });

    it("글이 디시콘 댓글을 인정하지 않으면 '줄'을 단다", () => {
        expect(contents(makePlan(decision({text_only: true}), gallery, [withDefaults], NOW, POST))).toEqual([{type: "text", text: "줄"}]);
    });

    it("기본 디시콘이 없는 계정은 지금처럼 '줄'을 단다", () => {
        expect(contents(makePlan(decision(), gallery, [gonick], NOW, POST))).toEqual([{type: "text", text: "줄"}]);
    });

    it("요구 문구가 있으면 기본 디시콘이 아니라 그 문구를 단다", () => {
        const post = "치킨 나눔 댓글에 치킨 먹고싶다 라고 쓰면 줄";
        expect(contents(makePlan(decision({line_text: "치킨 먹고싶다"}), gallery, [withDefaults], NOW, post))).toEqual([{type: "text", text: "치킨 먹고싶다"}]);
    });

    it("종류를 정하지 않은 디시콘 줄은 기본 디시콘으로, 기본 디시콘이 없으면 알린다", () => {
        expect(contents(makePlan(decision({line_method: "dccon"}), gallery, [withDefaults], NOW, POST, 0, () => 0))).toEqual([{type: "dccon", dccon: burger}]);
        expect(makePlan(decision({line_method: "dccon"}), gallery, [gonick], NOW, POST)).toMatchObject({kind: "notify", reason: expect.stringContaining("기본 디시콘")});
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

describe("findBaitWord", () => {
    it("봇 색출로 보이는 말을 찾고, 기호를 끼워 넣어도 찾는다", () => {
        expect(findBaitWord("치킨 나눔\n댓글 다는 매크로 차단함")).toBe("매크로");
        expect(findBaitWord("매.크.로 쓰면 컷")).toBe("매크로");
        expect(findBaitWord("b-o-t 거름")).toBe("bot");
    });

    it("흔한 낱말 안에 든 것은 넘기되, 그 낱말과 붙어 있어도 다른 자리에서는 찾는다", () => {
        expect(findBaitWord("로봇청소기 나눔합니다")).toBeNull();
        expect(findBaitWord("robot vacuum 나눔")).toBeNull();
        expect(findBaitWord("매크로봇 차단")).toBe("매크로");
        expect(findBaitWord("macrobot 컷")).toBe("macro");
        expect(findBaitWord("로봇 말고 봇은 차단")).toBe("봇");
    });
});

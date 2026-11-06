import {describe, expect, it} from "vitest";
import {defaultSettings, newGallery} from "@shared/settings";
import type {AccountConfig, Settings} from "@shared/types";
import {applyAccountChange, draftAfterAccountChange} from "../src/renderer/src/components/account-change";

const account = (id: string, loginId = ""): AccountConfig => ({id, loginId, memberTypeOverride: "auto", defaultDccons: []});

function savedSettings(): Settings {
    return {...defaultSettings(), accounts: [account("a", "first")], galleries: [{...newGallery("g"), accountIds: ["a"]}]};
}

describe("계정 추가·삭제 저장", () => {
    it("저장한 설정에만 계정 변경을 더하고, 초안의 저장하지 않은 변경은 초안에만 남긴다", () => {
        const saved = savedSettings();
        const draft: Settings = {...saved, discordWebhookUrl: "고치던 값", accounts: [account("a", "고치던 아이디")]};
        const change = {kind: "add", account: account("b")} as const;

        const toSave = applyAccountChange(saved, change);
        expect(toSave.discordWebhookUrl).toBe("");
        expect(toSave.accounts.map((item) => item.loginId)).toEqual(["first", ""]);

        const next = draftAfterAccountChange(draft, toSave, change);
        expect(next.discordWebhookUrl).toBe("고치던 값");
        expect(next.accounts.map((item) => [item.id, item.loginId])).toEqual([["a", "고치던 아이디"], ["b", ""]]);
    });

    it("다른 변경이 없으면 저장한 뒤 초안이 저장된 설정과 같다", () => {
        const saved = savedSettings();
        const change = {kind: "remove", id: "a"} as const;
        const toSave = applyAccountChange(saved, change);
        expect(toSave.accounts).toEqual([]);
        expect(toSave.galleries[0]!.accountIds).toEqual([]);
        expect(draftAfterAccountChange(saved, toSave, change)).toEqual(toSave);
    });

    it("새 계정은 저장된(다듬어진) 값을 초안에 넣는다", () => {
        const change = {kind: "add", account: account("b", " id ")} as const;
        const toSave = {...applyAccountChange(savedSettings(), change), accounts: [account("a", "first"), account("b", "id")]};
        expect(draftAfterAccountChange(savedSettings(), toSave, change).accounts.at(-1)!.loginId).toBe("id");
    });
});

import {describe, expect, it} from "vitest";
import {DCInsideError, type DCInside} from "@green-1052/dcinside.js";
import {galleryProblems, newGallery} from "@shared/settings";
import {checkGallery} from "../src/main/dc/gallery-check";

function reader(list: () => Promise<unknown>) {
    return {articles: {list}} as unknown as DCInside;
}

describe("checkGallery", () => {
    it("갤러리 이름과 마이너 여부를 돌려준다", async () => {
        const result = await checkGallery(reader(async () => ({gall_info: [{gall_title: "소녀전선2 망명", is_minor: true}], gall_list: []})), " gf2 ");
        expect(result).toEqual({title: "소녀전선2 망명", isMinor: true});
    });

    it("없는 갤러리, 잘못된 ID, app_id 거절을 구분해서 알려준다", async () => {
        await expect(checkGallery(reader(async () => ({gall_info: [], gall_list: []})), "nope")).rejects.toThrow("갤러리를 찾을 수 없습니다");
        await expect(checkGallery(reader(async () => ({})), "gf 2")).rejects.toThrow("영문, 숫자");
        await expect(checkGallery(reader(async () => {
            throw new DCInsideError("app_id 발급 실패: service id mismatched");
        }), "gf2")).rejects.toThrow("일시적으로 거절");
    });
});

describe("확인하지 않은 갤러리", () => {
    it("확인한 ID와 다르면 감시하지 않는다", () => {
        const gallery = {...newGallery("g"), galleryId: "gf2", accountIds: ["a"]};
        expect(galleryProblems(gallery)).toContain("갤러리 탭에서 갤러리 ID를 확인해야 합니다.");
        expect(galleryProblems({...gallery, checkedId: "gf2"})).toEqual([]);
        expect(galleryProblems({...gallery, checkedId: "gf1"})).toContain("갤러리 탭에서 갤러리 ID를 확인해야 합니다.");
    });
});

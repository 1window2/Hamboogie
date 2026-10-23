import type {DCInside} from "@green-1052/dcinside.js";
import type {GalleryCheckResult} from "@shared/types";
import {isAppIdFailure} from "./accounts";

/** 갤러리 목록을 한 번 불러와 실제로 있는 갤러리인지 확인하고, 이름과 마이너 여부를 돌려줍니다. */
export async function checkGallery(reader: DCInside, galleryId: string): Promise<GalleryCheckResult> {
    const id = galleryId.trim();
    if (!/^[A-Za-z0-9_$]+$/.test(id)) throw new Error("갤러리 ID는 영문, 숫자, _만 쓸 수 있습니다.");
    let response;
    try {
        response = await reader.articles.list({gallery: id});
    } catch (error) {
        if (isAppIdFailure(error)) throw new Error("디시 앱 인증이 일시적으로 거절되어 확인하지 못했습니다. 잠시 후 다시 시도하세요.");
        throw new Error(`갤러리를 찾을 수 없습니다. (${error instanceof Error ? error.message : String(error)})`);
    }
    const info = response.gall_info?.[0];
    if (!info?.gall_title) throw new Error("갤러리를 찾을 수 없습니다.");
    return {title: info.gall_title, isMinor: info.is_minor === true};
}

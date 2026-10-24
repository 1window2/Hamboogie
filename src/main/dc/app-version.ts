import {APP} from "@green-1052/dcinside.js";

/**
 * dcinside.js가 흉내 내는 공식 안드로이드 앱의 버전 코드입니다. 기기 정보를 저장할 때 함께 적어 두고,
 * 라이브러리 업데이트로 앱 버전이 바뀌면 옛 버전으로 받아 둔 app_id를 버리고 새로 받습니다.
 * (디시가 강제 업데이트를 걸면 옛 버전으로 받은 app_id도 거절됩니다.)
 */
export const DC_APP_VERSION_CODE: string = APP.versionCode;

/** 앱 버전이 낮아 거절되면 다시 시도해도 풀리지 않으므로 오래 쉽니다. */
export const OUTDATED_PAUSE_MS = 60 * 60 * 1000;

export const OUTDATED_APP_MESSAGE = "디시가 앱 강제 업데이트를 걸어, 지금 Hamboogie가 쓰는 앱 버전으로는 접속할 수 없습니다. Hamboogie를 최신 버전으로 업데이트하세요.";

/** 디시가 앱 버전이 낮다고 app_id 발급을 거절한 오류인지 확인합니다. 다시 시도하거나 기기 정보를 새로 받아도 풀리지 않습니다. */
export function isOutdatedAppError(error: unknown): boolean {
    return error instanceof Error && /최신 버전으로 업데이트/.test(error.message);
}

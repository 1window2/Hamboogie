import {APP} from "@green-1052/dcinside.js";

/**
 * 디시 서버가 요구하는 공식 안드로이드 앱 버전입니다. 디시가 강제 업데이트를 걸면 낮은 버전으로는 app_id를 발급하지 않으므로,
 * dcinside.js가 따라오기 전까지 여기서 맞춥니다. 2026-10-23에 5.3.20 강제 업데이트가 걸렸습니다
 * (`app_check` 응답의 `ver`, `force`). 버전 코드는 같은 버전의 APK에 적힌 값입니다.
 */
export const DC_APP_VERSION = {name: "5.3.20", code: "100190"} as const;

/** 디시 클라이언트를 만들기 전에 부릅니다. */
export function applyDcAppVersion(): void {
    Object.assign(APP as {versionName: string; versionCode: string}, {versionName: DC_APP_VERSION.name, versionCode: DC_APP_VERSION.code});
}

/** 앱 버전이 낮아 거절되면 다시 시도해도 풀리지 않으므로 오래 쉽니다. */
export const OUTDATED_PAUSE_MS = 60 * 60 * 1000;

export const OUTDATED_APP_MESSAGE = "디시가 앱 강제 업데이트를 걸어, 지금 Hamboogie가 쓰는 앱 버전으로는 접속할 수 없습니다. Hamboogie를 최신 버전으로 업데이트하세요.";

/** 디시가 앱 버전이 낮다고 app_id 발급을 거절한 오류인지 확인합니다. 다시 시도하거나 기기 정보를 새로 받아도 풀리지 않습니다. */
export function isOutdatedAppError(error: unknown): boolean {
    return error instanceof Error && /최신 버전으로 업데이트/.test(error.message);
}

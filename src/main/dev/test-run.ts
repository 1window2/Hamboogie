// 개발 모드(npm run dev) 전용 테스트 실행입니다. 배포 빌드에는 포함되지 않습니다.
//
// 입력한 제목/본문을 테스트 갤러리 1번 글의 내용인 것처럼 LLM 판단 → 줄 서기 계획 → 실제 댓글까지 돌립니다.
// 디시에는 글을 쓰지 않으며, 댓글은 아래에 고정한 테스트 갤러리의 1번 글에만 답니다.
import {ipcMain} from "electron";
import type {DevTestInput, DevTestResult, Settings} from "@shared/types";
import type {AccountManager} from "../dc/accounts";
import type {Logger} from "../logger";
import type {Engine} from "../pipeline/engine";
import type {Plan} from "../pipeline/planner";

/** 사람이 없는 테스트용 갤러리와 글입니다. 다른 갤러리에는 테스트 댓글을 달지 않습니다. */
export const TEST_GALLERY_ID = "asgeir";
export const TEST_POST_NO = 1;

const LABEL = "[테스트]";

interface Deps {
    engine: Engine;
    accounts: AccountManager;
    logger: Logger;
    settings(): Settings;
}

function summarize(plan: Plan, accounts: AccountManager): DevTestResult["plan"] {
    if (plan.kind !== "comment") return plan;
    return {
        kind: "comment",
        waitSec: Math.max(0, Math.round((plan.notBefore - Date.now()) / 1000)),
        attempts: plan.attempts.map((attempt) => ({
            account: accounts.nickname(attempt.accountId),
            content: attempt.content.type === "text" ? `"${attempt.content.text}"` : `디시콘 "${attempt.content.dccon.title}" (${attempt.content.dccon.packageTitle})`
        }))
    };
}

async function run(deps: Deps, input: DevTestInput): Promise<DevTestResult> {
    const gallery = deps.settings().galleries.find((item) => item.galleryId === TEST_GALLERY_ID);
    if (!gallery) throw new Error(`갤러리 탭에 테스트 갤러리 "${TEST_GALLERY_ID}"를 추가하고 대기 계정을 지정하세요. (감시는 꺼둬도 됩니다)`);
    const title = input.title.trim();
    if (!title) throw new Error("제목을 입력하세요.");

    const context = {galleryId: TEST_GALLERY_ID, postNo: TEST_POST_NO};
    deps.logger.info(`${LABEL} 가짜 글 분석: "${title}"`, context);
    // 실제 감시와 같이 제외 키워드부터 봅니다.
    const excluded = deps.engine.excludedBy(gallery, title) ?? deps.engine.excludedBy(gallery, input.body);
    if (excluded) {
        deps.logger.info(`${LABEL} 넘어감: 제외 키워드 "${excluded}"`, context);
        return {elapsedMs: 0, decision: null, plan: {kind: "skip", reason: `제외 키워드 "${excluded}"`}};
    }
    const startedAt = Date.now();
    const {decision, plan} = await deps.engine.analyze(gallery, title, input.body, startedAt);
    const elapsedMs = Date.now() - startedAt;
    const summary = summarize(plan, deps.accounts);

    if (input.act) {
        await deps.engine.dispatch(gallery, {no: TEST_POST_NO, title}, plan, {useLedger: false, label: LABEL});
    } else {
        deps.logger.info(`${LABEL} 판단만 했습니다 (${plan.kind}). 댓글과 알림은 보내지 않았습니다.`, context);
    }
    return {elapsedMs, decision: decision as Record<string, unknown> | null, plan: summary};
}

export function registerDevTestIpc(deps: Deps): void {
    ipcMain.handle("devTestRun", (_event, input: DevTestInput) => run(deps, input));
}

// 개발 모드(npm run dev) 전용 테스트 실행입니다. 배포 빌드에는 포함되지 않습니다.
//
// 입력한 제목/본문을 테스트 갤러리 1번 글의 내용인 것처럼 LLM 판단 → 줄 서기 계획 → 실제 댓글까지 돌립니다.
// 디시에는 글을 쓰지 않으며, 댓글은 아래에 고정한 테스트 갤러리의 1번 글에만 답니다.
import type {DCInside} from "@green-1052/dcinside.js";
import {errorMessage} from "@shared/errors";
import type {DevApiCheckStep, DevProbe, DevTestInput, DevTestResult, Settings} from "@shared/types";
import type {AccountManager} from "../dc/accounts";
import {checkGallery} from "../dc/gallery-check";
import type {CommentContent} from "../pipeline/planner";
import {htmlToText} from "../dc/text";
import type {Logger} from "../logger";
import type {Engine} from "../pipeline/engine";
import type {Plan} from "../pipeline/planner";
import type {TrustedHandle} from "../index";

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
        await deps.engine.dispatch(gallery, {no: TEST_POST_NO, title}, plan, {label: LABEL});
    } else {
        deps.logger.info(`${LABEL} 판단만 했습니다 (${plan.kind}). 댓글과 알림은 보내지 않았습니다.`, context);
    }
    return {elapsedMs, decision: decision as Record<string, unknown> | null, plan: summary};
}

/**
 * 테스트 갤러리의 대기 계정 중 로그인된 계정입니다. 다른 갤러리용 계정으로 테스트 갤러리에 요청하지 않습니다.
 * 갤러리 탭에 테스트 갤러리가 없거나, 그 대기 계정이 로그인돼 있지 않으면 오류를 던집니다.
 */
function testReading(deps: Deps): {accountId: string; client: DCInside} {
    const settings = deps.settings();
    const gallery = settings.galleries.find((item) => item.galleryId === TEST_GALLERY_ID);
    if (!gallery) throw new Error(`갤러리 탭에 ${TEST_GALLERY_ID} 갤러리를 먼저 추가하세요.`);
    const reading = deps.accounts.readingClient(settings.accounts, gallery.accountIds);
    if (!reading) throw new Error(`${TEST_GALLERY_ID} 갤러리의 대기 계정 중 로그인된 계정이 없습니다.`);
    return reading;
}

/** 점검용 텍스트 댓글입니다. 지울 댓글을 찾을 때 이 문구로 알아봅니다. */
const CHECK_COMMENT = "햄부기 점검";

/**
 * 실제 디시 API를 앱이 쓰는 경로 그대로 차례로 점검합니다. 요청은 테스트 갤러리 1번 글에만 보내고,
 * 단 댓글은 바로 찾아서 지웁니다. 한 단계가 실패해도 나머지 단계는 계속합니다.
 */
async function apiCheck(deps: Deps): Promise<DevApiCheckStep[]> {
    const steps: DevApiCheckStep[] = [];
    const step = async (name: string, action: () => Promise<string>) => {
        const startedAt = Date.now();
        try {
            steps.push({name, ok: true, detail: await action(), elapsedMs: Date.now() - startedAt});
        } catch (error) {
            steps.push({name, ok: false, detail: errorMessage(error), elapsedMs: Date.now() - startedAt});
        }
    };
    const settings = deps.settings();
    let reading: {accountId: string; client: DCInside};
    try {
        reading = testReading(deps);
    } catch (error) {
        return [{name: "로그인된 계정", ok: false, detail: errorMessage(error), elapsedMs: 0}];
    }
    const account = settings.accounts.find((item) => item.id === reading.accountId)!;
    const status = deps.accounts.status(reading.accountId);
    steps.push({
        name: "로그인과 보유 디시콘",
        ok: status.state === "logged_in" && !status.dcconError,
        detail: status.state === "logged_in" ? `${status.nickname}, 디시콘 ${status.dcconCount}개${status.dcconError ? ` (오류: ${status.dcconError})` : ""}` : status.state,
        elapsedMs: 0
    });

    await step("갤러리 확인", async () => {
        const result = await checkGallery(reading.client, TEST_GALLERY_ID);
        return `${result.title}${result.isMinor ? " (마이너)" : ""}`;
    });
    await step("글 목록", async () => {
        const list = await reading.client.articles.list({gallery: TEST_GALLERY_ID});
        const posts = (list.gall_list ?? []).filter((item) => typeof item.no === "number");
        return `${posts.length}개, 최신 #${Math.max(0, ...posts.map((item) => item.no!))}`;
    });
    await step(`글 읽기 #${TEST_POST_NO}`, async () => {
        const article = await reading.client.articles.read(TEST_GALLERY_ID, TEST_POST_NO);
        const html = article.view_main?.memo ?? "";
        // 이미지만 있는 글은 글자가 0자여도 HTML은 있습니다. 둘 다 보여 줘서 읽기 실패와 구분합니다.
        return `"${article.view_info?.subject ?? ""}", 본문 글자 ${htmlToText(html).length}자 (HTML ${html.length}자)`;
    });

    type ListedComment = {comment_no?: number; user_id?: string; comment_memo?: string; dccon?: string};
    const dccon = deps.accounts.candidates(settings.accounts, [reading.accountId])[0]?.dccons[0];
    /** 내 계정의 댓글인지 봅니다. 댓글 목록의 user_id는 로그인 아이디와 같지만, 혹시 몰라 세션의 아이디도 받습니다. */
    const isMine = (comment: ListedComment, client: DCInside) =>
        comment.user_id === account.loginId || (client.session?.type === "login" && comment.user_id === client.session.userId);
    /**
     * 점검에 쓰는 디시콘 댓글인지 봅니다. 댓글 목록의 디시콘 번호(`dccon_detail_idx`)는 보유 목록의 번호와 달라서,
     * 디시콘 이미지가 있고 댓글 내용이 그 디시콘 이름인지로 알아봅니다.
     */
    const isCheckDccon = (comment: ListedComment) => dccon !== undefined && Boolean(comment.dccon) && comment.comment_memo === dccon.title;
    /** 이 점검이 다는 댓글(점검 문구나 점검에 쓰는 디시콘)인지 봅니다. */
    const isCheckComment = (comment: ListedComment) => comment.comment_memo === CHECK_COMMENT || isCheckDccon(comment);
    const currentClient = () => {
        // 댓글을 달면서 다시 로그인했을 수 있으므로 지금 세션의 클라이언트를 씁니다.
        try {
            return testReading(deps).client;
        } catch {
            throw new Error("로그인이 풀려 댓글 목록을 볼 수 없습니다. 글에서 직접 확인해 주세요.");
        }
    };

    // 지난 점검이 지우지 못한 점검 댓글이 남아 있으면 먼저 지웁니다.
    await step("남은 점검 댓글 정리", async () => {
        const client = currentClient();
        const leftovers = ((await client.comments.list(TEST_GALLERY_ID, TEST_POST_NO)).comment_list ?? [])
            .filter((comment) => comment.comment_no !== undefined && isMine(comment, client) && isCheckComment(comment));
        for (const comment of leftovers) await client.comments.delete(TEST_GALLERY_ID, TEST_POST_NO, comment.comment_no!);
        return leftovers.length > 0 ? `${leftovers.length}개 지움 (#${leftovers.map((comment) => comment.comment_no).join(", #")})` : "없음";
    });

    /** 댓글을 달고, 내가 단 댓글 중 조건에 맞는 가장 최근 것을 찾아 지웁니다. */
    const writeAndDelete = async (content: CommentContent, mine: (comment: ListedComment) => boolean) => {
        await deps.accounts.writeComment(reading.accountId, TEST_GALLERY_ID, TEST_POST_NO, content);
        const client = currentClient();
        const comments = await client.comments.list(TEST_GALLERY_ID, TEST_POST_NO);
        const found = (comments.comment_list ?? []).find((comment) => isMine(comment, client) && mine(comment));
        if (!found?.comment_no) throw new Error("댓글은 달았지만 목록에서 찾지 못해 지우지 못했습니다. 다음 점검 때 정리합니다.");
        await client.comments.delete(TEST_GALLERY_ID, TEST_POST_NO, found.comment_no);
        const after = await client.comments.list(TEST_GALLERY_ID, TEST_POST_NO);
        if ((after.comment_list ?? []).some((comment) => comment.comment_no === found.comment_no)) throw new Error(`댓글 #${found.comment_no}을 지우지 못했습니다.`);
        return `댓글 #${found.comment_no} 달고 지움`;
    };
    await step("텍스트 댓글 달기·지우기", () => writeAndDelete({type: "text", text: CHECK_COMMENT}, (comment) => comment.comment_memo === CHECK_COMMENT));
    if (dccon) {
        await step(`디시콘 댓글 달기·지우기 ("${dccon.title}")`, () => writeAndDelete({type: "dccon", dccon}, isCheckDccon));
    } else {
        steps.push({name: "디시콘 댓글 달기·지우기", ok: false, detail: "보유 디시콘이 없어 건너뜀", elapsedMs: 0});
    }
    for (const item of steps) deps.logger[item.ok ? "info" : "warn"](`${LABEL} API 점검 ${item.ok ? "통과" : "실패"}: ${item.name} - ${item.detail}`);
    return steps;
}

export function registerDevTestIpc(deps: Deps, handle: TrustedHandle): void {
    // 감시를 시작하되, 처음 줄 서기에 성공하는 즉시 멈추게 합니다(실제 갤러리 테스트용).
    handle("devWatchUntilFirstSuccess", () => {
        deps.engine.stopAfterFirstSuccess = true;
        deps.engine.start();
        deps.logger.info(`${LABEL} 첫 줄 서기 성공 시 감시를 멈추도록 하고 감시를 시작합니다.`);
        return {running: deps.engine.running};
    });
    // 테스트로 단 댓글을 지웁니다. 그 갤러리의 대기 계정(로그인된 첫 계정)이 단 댓글만 지우고, 다른 사람 댓글은 건드리지 않습니다.
    handle("devDeleteMyComments", async (_event, galleryId: string, postNo: number) => {
        const settings = deps.settings();
        const gallery = settings.galleries.find((item) => item.galleryId === galleryId);
        if (!gallery || !Number.isInteger(postNo)) throw new Error("갤러리 탭에 있는 갤러리와 글 번호만 쓸 수 있습니다.");
        const reading = deps.accounts.readingClient(settings.accounts, gallery.accountIds);
        if (!reading) throw new Error(`${galleryId} 갤러리의 대기 계정 중 로그인된 계정이 없습니다.`);
        const loginId = settings.accounts.find((account) => account.id === reading.accountId)!.loginId;
        // 댓글이 많으면 여러 페이지로 나뉘어 오므로 모든 페이지에서 찾습니다.
        const myComments = async () => {
            const found = [];
            for await (const page of reading.client.comments.pages(galleryId, postNo)) {
                found.push(...(page.comment_list ?? []).filter((comment) => comment.comment_no !== undefined && comment.user_id === loginId));
            }
            return found;
        };
        const mine = await myComments();
        for (const comment of mine) await reading.client.comments.delete(galleryId, postNo, comment.comment_no!);
        const left = mine.length > 0 ? await myComments() : [];
        deps.logger.info(`${LABEL} ${galleryId} #${postNo}에서 ${loginId} 계정 댓글 ${mine.length}개 지움${left.length ? ` (남은 댓글 ${left.length}개)` : ""}`);
        return {account: loginId, deleted: mine.map((comment) => ({no: comment.comment_no, memo: comment.comment_memo})), left: left.length};
    });
    // 여러 더미 글을 LLM 요청 한 번으로 판단해 봅니다. 디시에는 요청하지 않습니다.
    handle("devBatchTest", async (_event, posts: {title: string; body: string; no?: number; postedAt?: number}[]) => {
        const startedAt = Date.now();
        const decisions = await deps.engine.decideBatch(posts);
        return {elapsedMs: Date.now() - startedAt, decisions};
    });
    handle("devApiCheck", () => apiCheck(deps));
    // 컴퓨터가 `minutes`분 동안 잠들었다 깨어난 것처럼 엔진에 알립니다. offline이면 깨어난 뒤 네트워크가 없는 것으로 칩니다.
    handle("devSimulateSleep", async (_event, minutes: number, offline: boolean) => {
        const engine = deps.engine as unknown as {deps: {checkNetwork?: () => Promise<boolean>}};
        const real = engine.deps.checkNetwork;
        if (offline) engine.deps.checkNetwork = async () => false;
        deps.engine.suspend(Date.now() - minutes * 60 * 1000);
        const startedAt = Date.now();
        try {
            await deps.engine.resume();
        } finally {
            engine.deps.checkNetwork = real;
        }
        return {running: deps.engine.running, waitedSec: Math.round((Date.now() - startedAt) / 1000)};
    });
    // 지정한 계정에 무료 디시콘 패키지를 추가합니다(기본 디시콘 테스트용). 가격(만두)이 0일 때만 추가하고, 아니면 가격만 알려 줍니다.
    handle("devAddFreeDccon", async (_event, loginId: string, packageIdx: number) => {
        const settings = deps.settings();
        const account = settings.accounts.find((item) => item.loginId === loginId);
        if (!account) throw new Error("계정 탭에 있는 계정만 쓸 수 있습니다.");
        const reading = deps.accounts.readingClient(settings.accounts, [account.id]);
        if (!reading) throw new Error(`${loginId} 계정이 로그인되어 있지 않습니다.`);
        const detail = await reading.client.dccons.detail(packageIdx);
        const info = detail.info?.[0];
        const price = Number(info?.mandu ?? NaN);
        if (!(price === 0)) return {added: false, title: info?.title, price: info?.mandu, state: info?.get_state};
        const result = await reading.client.dccons.buy(packageIdx);
        deps.logger.info(`${LABEL} ${loginId} 계정에 무료 디시콘 "${info?.title}" 추가: ${JSON.stringify(result)}`);
        return {added: true, title: info?.title, price: info?.mandu, state: info?.get_state, result};
    });
    // 테스트 갤러리 대기 계정이 가진 디시콘입니다. 로그인할 때 불러 둔 목록이라 디시에 요청하지 않습니다.
    // recent가 true면 최근 쓴 디시콘도 함께 봅니다(디시 요청 1번).
    handle("devOwnedDccons", async (_event, recent?: boolean) => {
        const settings = deps.settings();
        const gallery = settings.galleries.find((item) => item.galleryId === TEST_GALLERY_ID);
        const account = gallery ? deps.accounts.candidates(settings.accounts, gallery.accountIds)[0] : undefined;
        if (!account) throw new Error(`${TEST_GALLERY_ID} 갤러리의 대기 계정 중 로그인된 계정이 없습니다.`);
        const packages = new Map<string, {packageIdx: number; items: string[]}>();
        for (const dccon of account.dccons) {
            const entry = packages.get(dccon.packageTitle) ?? {packageIdx: dccon.packageIdx, items: []};
            entry.items.push(`${dccon.detailIdx}:${dccon.title}`);
            packages.set(dccon.packageTitle, entry);
        }
        const recentList = recent ? (await testReading(deps).client.dccons.recent()).map((item) => ({packageIdx: item.package_idx, detailIdx: item.detail_idx, title: item.title})) : undefined;
        return {
            memberType: account.memberType, total: account.dccons.length, packageCount: packages.size,
            packages: [...packages].slice(0, 25).map(([title, {packageIdx, items}]) => ({title, packageIdx, count: items.length, items: items.slice(0, 6)})),
            recent: recentList
        };
    });
    handle("devTestRun", (_event, input: DevTestInput) => run(deps, input));
    // 디시 응답을 직접 확인하는 용도입니다. 테스트 갤러리(asgeir)에만 요청하며, 부를 때마다 요청 한 번입니다.
    handle("devProbe", async (_event, probe: DevProbe) => {
        const articles = testReading(deps).client.articles;
        if (probe.kind === "comments") {
            const comments = await testReading(deps).client.comments.list(TEST_GALLERY_ID, probe.no);
            return (comments.comment_list ?? []).map(({comment_no, user_id, name, comment_memo, dccon, dccon_detail_idx, dccon_type}) =>
                ({comment_no, user_id, name, comment_memo: comment_memo?.slice(0, 80), dccon: dccon?.slice(0, 80), dccon_detail_idx, dccon_type}));
        }
        if (probe.kind === "read") {
            const article = await articles.read(TEST_GALLERY_ID, probe.no);
            return {title: article.view_info?.subject ?? "", body: htmlToText(article.view_main?.memo ?? ""), date: article.view_info?.date_time};
        }
        const response = await articles.list({gallery: TEST_GALLERY_ID, ...(probe.search ? {search: probe.search} : {})});
        return (response.gall_list ?? []).map((item) => ({no: item.no, subject: item.subject, date: item.date_time}));
    });
}


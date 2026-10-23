// 개발 모드 전용 오프라인 모드입니다. `npm run dev:offline`으로 켜며, 배포 빌드에는 포함되지 않습니다.
//
// 디시인사이드 대신 가짜 클라이언트를 쓰고, 혹시 모를 실수에 대비해 디시 주소로 나가는 요청을 전부 막습니다.
// 집 IP가 디시에서 차단되는 일을 겪은 뒤, 디시 없이도 화면과 감시 흐름을 개발할 수 있도록 만들었습니다.
// LLM(Gemini 등)과 Discord 웹훅 요청은 그대로 나갑니다.
import type {DCInside, DeviceCredentials, LoginOptions} from "@green-1052/dcinside.js";

const DCINSIDE_HOST = /(^|\.)dcinside\.(com|co\.kr)$/i;

function hostOf(input: string | URL | Request): string {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
}

/** 디시 주소로 가는 fetch를 모두 실패시킵니다. 디시 클라이언트를 하나라도 만들기 전에 불러야 합니다. */
export function blockDcinsideRequests(onBlocked: (host: string) => void): void {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
        const host = hostOf(input);
        if (DCINSIDE_HOST.test(host)) {
            onBlocked(host);
            return Promise.reject(new Error(`오프라인 모드: ${host} 요청을 막았습니다.`));
        }
        return realFetch(input, init);
    };
}

interface FakePost {
    no: number;
    subject: string;
    memo: string;
}

/** 감시 중 새 글로 하나씩 나타날 가짜 글입니다. 나눔 글과 일반 글이 섞여 있습니다. */
const SCRIPT: {subject: string; memo: string}[] = [
    {subject: "오늘 업데이트 별거 없네", memo: "다들 뭐함"},
    {subject: "햄버거 3개 뿌림 선착순", memo: "댓글로 줄 서셈"},
    {subject: "치킨 기프티콘 나눔", memo: "댓글에 '치킨 먹고싶다'라고 써야 줄 인정"},
    {subject: "게임 쿠폰 나눔", memo: "댓글로 줄"},
    {subject: "커피 기프티콘 뿌림", memo: "가짜콘으로 줄 서라. 텍스트 댓글은 무효"},
    {subject: "피자 나눔 (고닉만)", memo: "반고닉, 유동은 무효"},
    {subject: "케이크 기프티콘 나눔 인증 필수", memo: "구매 인증한 사람만"},
    {subject: "테스트", memo: "햄버거 선착 3명 뿌립니다. 댓글로 줄"}
];

/** 디시 서버 없이 동작하는 가짜 클라이언트를 만듭니다. 갤러리마다 목록을 볼 때마다 새 글이 하나씩 생깁니다. */
export function createFakeClientFactory(log: (message: string) => void): (credentials?: DeviceCredentials) => DCInside {
    const galleries = new Map<string, FakePost[]>();
    const posts = (gallery: string) => {
        let list = galleries.get(gallery);
        if (!list) {
            list = [{no: 1000, subject: "기존 글", memo: "감시 시작 전부터 있던 글"}];
            galleries.set(gallery, list);
        }
        return list;
    };

    return () => ({
        auth: {exportCredentials: () => ({offline: true})},
        async login(id: string, password: string, _options: LoginOptions = {}) {
            log(`오프라인 로그인: ${id}`);
            return {type: "login", id, password, userId: id, result: {result: true, user_id: id, name: `오프라인 ${id}`, is_gonick: 1}};
        },
        articles: {
            async list({gallery}: {gallery: string}) {
                const list = posts(gallery);
                const last = list.at(-1)!;
                const next = SCRIPT[(last.no - 1000) % SCRIPT.length]!;
                list.push({no: last.no + 1, ...next});
                return {
                    gall_info: [{gall_title: `오프라인 ${gallery} 갤러리`, is_minor: true}],
                    gall_list: list.slice(-16).reverse().map((post) => ({no: post.no, subject: post.subject}))
                };
            },
            async read(gallery: string, no: number) {
                const post = posts(gallery).find((item) => item.no === no);
                if (!post) throw new Error("작성자가 삭제했거나 존재하지 않는 게시물입니다.");
                return {view_info: {subject: post.subject}, view_main: {memo: post.memo}};
            }
        },
        dccons: {
            async list() {
                return {tab: [{title: "가짜콘"}], list: [[{package_idx: 1, detail_idx: 1, title: "가짜콘 1"}]]};
            },
            async insert() {
                return {img_tag: "<img class='written_dccon'>"};
            }
        },
        comments: {
            async write(gallery: string, no: number, content: unknown) {
                log(`오프라인 댓글: ${gallery} #${no} ← ${typeof content === "string" ? content : "디시콘"}`);
                return {result: "true"};
            }
        }
    }) as unknown as DCInside;
}

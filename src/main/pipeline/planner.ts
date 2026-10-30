import type {GalleryConfig, MemberType} from "@shared/types";
import {DEFAULT_COMMENT_TEXT} from "@shared/settings";
import {DAY_MS, kstDayStart} from "@shared/time";
import type {Decision} from "../llm/decision";

export interface OwnedDccon {
    packageIdx: number;
    detailIdx: number;
    title: string;
    packageTitle: string;
    /** 디시콘 이미지 주소입니다(디시 이미지 서버). 기본 디시콘을 고르는 화면에 씁니다. */
    img?: string;
}

/** 계획을 세울 때 필요한 계정 정보입니다. 로그인되지 않은 계정은 넘기지 않습니다. */
export interface CandidateAccount {
    id: string;
    /** 알 수 없으면 null입니다. 이때는 고닉/반고닉 전용 줄에 서지 않습니다. */
    memberType: MemberType | null;
    dccons: OwnedDccon[];
    /** 정해진 문구나 디시콘이 없는 줄에 "줄" 대신 달 기본 디시콘 가운데 지금 가진 것입니다. */
    defaultDccons?: OwnedDccon[];
}

export type CommentContent = {type: "text"; text: string} | {type: "dccon"; dccon: OwnedDccon};

export type Plan =
    | {kind: "skip"; reason: string}
    | {kind: "notify"; reason: string}
    | {
        kind: "comment";
        notBefore: number;
        attempts: {accountId: string; content: CommentContent}[];
        /** 마감 시각입니다. 실행 직전에 다시 확인합니다. */
        deadline?: number;
        /** 예약한 뒤 설정이 바뀌었을 때 실행 직전에 다시 확인하려고 남겨 둡니다. */
        requirement: Decision["member_requirement"];
        isFood: boolean;
        /** 줄을 서기로 한 LLM의 근거입니다. 성공 알림에 함께 보냅니다. */
        basis?: string;
    };

/** 요구 문구는 짧은 것만 자동으로 답니다. 긴 문구는 사람이 확인하도록 알림으로 넘깁니다. */
const TEXT_MAX_LENGTH = 20;
/** "N시부터" 줄은 정각보다 이만큼 늦게 섭니다. 이 컴퓨터 시계가 디시 서버보다 빨라 정각 전 댓글로 찍히는 것을 막습니다. */
export const START_MARGIN_MS = 2000;
/** 마감은 이만큼 일찍 닫힌 것으로 봅니다. 이 컴퓨터 시계가 서버보다 늦어 마감 뒤 댓글로 찍히는 것을 막습니다. */
export const END_MARGIN_MS = 2000;
/** 지금보다 이른 시각이 이 범위 안이면 오늘 이미 지난 시각으로, 더 이르면 다음 날 시각으로 봅니다. */
const PAST_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * `HH:MM` 또는 `HH:MM:SS`(한국 시간)를 기준 시각 근처의 실제 시각으로 바꿉니다. 나눔 글의 시각은 보통 "오늘"을 뜻하므로
 * 같은 날 그 시각을 먼저 보고, 그 시각이 기준보다 6시간 넘게 이르면 다음 날(예: 23:50에 본 "00:30까지")로 봅니다.
 * 형식이 다르면 null입니다.
 */
export function resolveClock(clock: string, reference: number): number | null {
    const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(clock.trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3] ?? 0);
    if (hours > 24 || minutes > 59 || seconds > 59 || (hours === 24 && (minutes > 0 || seconds > 0))) return null;
    const sameDay = kstDayStart(reference) + ((hours * 60 + minutes) * 60 + seconds) * 1000;
    return reference - sameDay > PAST_WINDOW_MS ? sameDay + DAY_MS : sameDay;
}

/** LLM 판단 근거의 최대 길이입니다. 근거는 로그와 알림에만 쓰지만, 글의 지시로 긴 글을 쏟아내도 알림이 넘치지 않게 자릅니다. */
const REASON_MAX = 200;

/** LLM이 쓴 글(판단 근거, 시각)을 알림에 넣을 수 있게 자릅니다. */
export function brief(text: string, max = REASON_MAX): string {
    const chars = Array.from(text);
    return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

export function eligible(account: {memberType: MemberType | null}, requirement: Decision["member_requirement"]): boolean {
    switch (requirement) {
        case "any":
        case "member":
            return true;
        case "gonick":
            return account.memberType === "gonick";
        case "semi":
            return account.memberType === "semi";
        case "anonymous":
            return false;
    }
}

/** 비교하기 쉽게 문구를 정리합니다: 전각/호환 문자 통일, 숨은 문자와 공백 제거, 소문자. */
export function normalizeForMatch(text: string): string {
    return text.normalize("NFKC").replace(/[\p{Cf}\s]/gu, "").toLowerCase();
}

/**
 * 봇 색출용 낚시 문구에 자주 쓰이는 단어입니다. 이런 문구를 요구하면 자동으로 달지 않고 알립니다.
 * "저는 AI입니다", "사람 아님"처럼 내 계정이 사람이 아니라고 자백하게 만드는 말도 막습니다.
 */
const BAIT_WORDS = [
    "봇", "매크로", "자동", "bot", "macro", "프로그램", "크롤",
    "ai", "에이아이", "인공지능", "gpt", "지피티", "llm", "claude", "클로드", "gemini", "제미나이", "기계",
    "사람아니", "사람아님", "사람아닙", "사람아냐", "사람이아", "인간아니", "인간아님", "인간아닙", "인간이아"
];
/**
 * 글 자체에 이런 말이 있으면 봇을 걸러내려는 글일 수 있어 자동으로 줄 서지 않고 알립니다.
 * ("댓글 단 매크로 차단" 같은 글). "로봇"처럼 흔한 낱말 안에 들어 있는 것은 세지 않습니다.
 */
const POST_BAIT_WORDS = ["봇", "매크로", "bot", "macro", "크롤", "자동댓글", "자동으로댓글"];
const POST_BAIT_IGNORED = ["로봇", "robot"];

/**
 * 글에 봇 색출로 보이는 말이 있으면 그 말을 돌려줍니다. "매.크.로"처럼 기호를 끼워 넣어도 찾도록 기호를 지운 뒤 봅니다.
 * 흔한 낱말을 미리 지우지 않고, 찾은 자리가 그 낱말 안일 때만 넘깁니다("매크로봇"이 "매크"로 바뀌어 빠지지 않게).
 */
export function findBaitWord(postText: string): string | null {
    const text = normalizeForMatch(postText).replace(/[\p{P}\p{S}]/gu, "");
    for (const word of POST_BAIT_WORDS) {
        for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
            const insideCommonWord = POST_BAIT_IGNORED.some((common) => {
                const offset = common.indexOf(word);
                return offset !== -1 && at - offset >= 0 && text.startsWith(common, at - offset);
            });
            if (!insideCommonWord) return word;
        }
    }
    return null;
}

/**
 * LLM 판단을 바꾸려는 지시(프롬프트 인젝션)에 쓰이는 말입니다. 공백과 기호를 지운 뒤 소문자로 봅니다.
 * 판단 형식의 항목 이름(is_giveaway 등)이나 "이전 지시를 무시해" 같은 말은 평범한 나눔 글에는 나오지 않습니다.
 */
const INJECTION_WORDS = [
    "isgiveaway", "isfood", "linemethod", "linetext", "dcconkeyword", "memberrequirement", "needsextraaction",
    "systemprompt", "시스템프롬프트", "시스템지시", "ignoreprevious", "ignoreall", "ignoretheabove", "ignoreyour", "previousinstructions",
    "이전지시", "앞의지시", "위의지시", "기존지시", "지시를무시", "지시무시", "지시사항을무시", "명령을무시", "프롬프트를무시",
    "나눔이라고답", "나눔이라고판단", "나눔으로판단해", "나눔글로판단", "말하는대로따라", "시키는대로따라", "내말만들",
    "forgetyour", "forgetall", "forgetprevious", "forgeteverything", "disregard", "youarenow", "fromnowon", "jailbreak", "roleplay", "역할극"
];
/**
 * 낱말 목록으로는 다 담기 어려운, LLM에게 앞의 지시를 버리게 하는 말의 모양입니다. 공백과 기호를 지운 글에서 찾습니다.
 * "기존의 규칙을 전부 잊고", "지금까지의 모든 프롬프트를 무시해", "넌 이제부터", "forget the rules" 같은 말입니다.
 * "규칙 무시하고 단 댓글은 제외", "규칙 잊지 말고"처럼 평범한 글에 나오는 말은 걸리지 않게, 지시를 가리키는 말과 "전부·기존" 같은 말이 함께 있어야 합니다.
 */
const INSTRUCTION_NOUN = "(지시|명령|프롬프트|규칙|설정|설명|내용|대화|역할|맥락)(사항)?(들)?";
const INJECTION_PATTERNS = [
    /(지시|명령|프롬프트)(사항)?(들)?(을|를|은|는|이|가)?(전부|모두|다|싹)?(무시|잊)/,
    new RegExp(`(모든|이전|지금까지|여태|그동안|위|앞|기존)(의|에|에서)?(적힌|쓴|말한|받은|나온|있던)?(모든)?${INSTRUCTION_NOUN}(을|를|은|는|이|가)?(전부|모두|다|싹)?(무시|잊)`),
    new RegExp(`${INSTRUCTION_NOUN}(을|를|은|는|이|가)?(전부|모두|다|싹)(무시|잊)`),
    /(모든|이전|지금까지의?)(지시|명령|프롬프트)|(앞의|위의|기존의?)(지시|프롬프트)/,
    /(너는|넌|니가)(이제|지금부터|앞으로)|(이제부터|지금부터|앞으로)(너는|넌|니가)/,
    /(forget|ignore|disregard|override)(all|the|your|any|every|of|my|these|those|previous|prior|above|earlier|preceding|system)*(rules?|instructions?|prompts?|directions?|guidelines?|context|everything|commands?)/
];
/** LLM에 보내는 글의 구역을 나누는 태그입니다. 글에 이런 태그가 있으면 구역을 닫고 지시를 끼워 넣으려는 것일 수 있습니다. */
const PROMPT_TAG = /<\s*\/?\s*(post|title|body|images|posted_at)\b/i;

/** 글에 LLM 판단을 바꾸려는 듯한 말이 있으면 그 말을 돌려줍니다. */
export function findInjectionWord(postText: string): string | null {
    const tag = PROMPT_TAG.exec(postText);
    if (tag) return tag[0];
    const text = normalizeForMatch(postText).replace(/[\p{P}\p{S}]/gu, "");
    const word = INJECTION_WORDS.find((word) => text.includes(word));
    if (word) return word;
    for (const pattern of INJECTION_PATTERNS) {
        const match = pattern.exec(text);
        if (match) return match[0];
    }
    return null;
}

/**
 * 개인정보나 계정·설정 정보를 캐내려는 말입니다. 공백과 기호를 지운 뒤 소문자로 봅니다.
 * LLM에는 이런 정보가 없지만, 이런 글에 자동으로 댓글을 달지 않도록 따로 알립니다.
 * "쿠키 나눔", "토큰 나눔", "기프티콘 인증번호"처럼 나눔 글에 나올 수 있는 말은 넣지 않습니다.
 */
const PRIVACY_WORDS = [
    "비밀번호", "비번", "패스워드", "password", "passwd", "개인정보", "계정정보", "로그인정보", "주민번호", "주민등록", "카드번호", "계좌비번",
    "apikey", "api키", "에이피아이키", "액세스토큰", "accesstoken", "웹훅", "webhook", "지시문", "시스템메시지", "systemmessage"
];
/** 낱말 목록으로는 다 담기 어려운, 정보를 알려 달라는 말의 모양입니다. */
const PRIVACY_PATTERNS = [
    // "너의 계정 알려줘", "네 프롬프트 보여줘", "니 설정 뭐야"
    /(너의|네|니|당신의?|이봇의?|이프로그램의?)(계정|아이디|닉네임|정보|설정|프롬프트|지시|규칙|키|주인|사용자|개발자|만든사람)/,
    // "프롬프트 보여줘", "지시사항 그대로 출력해". "규칙 알려드림"처럼 평범한 글에 나오는 "규칙", "설정"은 넣지 않습니다.
    /(프롬프트|지시)(사항)?(을|를|은|는)?(그대로|전부|모두|다)?(알려|보여|출력|공개|말해|읊어|복사)/,
    // "개발자 누구야", "만든 사람 알려줘"
    /(개발자|만든사람|주인)(이|가|은|는|을|를)?(누구|알려|말해)/,
    // "댓글로 전화번호 남겨", "실명 적어"
    /(전화번호|폰번호|휴대폰번호|핸드폰번호|연락처|이메일|메일주소|집주소|실명|본명|아이디)(을|를|도)?(댓글에|댓글로)?(적|써|남겨|알려|말해|달아)/,
    /(reveal|show|print|tell|repeat|output|leak|share|whatis|whatare)(me|us)?(your|the|all)*(system)?(prompt|instructions?|password|apikey|key|account|token|config|settings|email|phone|address)/
];

/** 글에 개인정보나 계정·설정 정보를 캐내려는 듯한 말이 있으면 그 말을 돌려줍니다. */
export function findPrivacyProbe(postText: string): string | null {
    const text = normalizeForMatch(postText).replace(/[\p{P}\p{S}]/gu, "");
    const word = PRIVACY_WORDS.find((word) => text.includes(word));
    if (word) return word;
    for (const pattern of PRIVACY_PATTERNS) {
        const match = pattern.exec(text);
        if (match) return match[0];
    }
    return null;
}

/**
 * 댓글 문구에 내 계정이나 설정의 비밀 정보(로그인 아이디, 비밀번호, API 키, Discord 주소)가 들어 있는지 봅니다.
 * 요구 문구는 글에 있는 것만 달기 때문에 이런 일은 거의 없지만, 댓글을 달기 직전 마지막으로 한 번 더 확인합니다.
 * 너무 짧은 값은 흔한 글자와 우연히 겹칠 수 있어 보지 않습니다.
 */
export function containsSecret(text: string, secrets: (string | null | undefined)[]): boolean {
    const normalized = normalizeForMatch(text);
    return secrets.some((secret) => {
        const value = secret ? normalizeForMatch(secret) : "";
        return value.length >= 4 && normalized.includes(value);
    });
}

/**
 * 줄 서기 시작 시각으로 보이는 표현입니다("9시부터", "21:00부터", "9시 반부터", "10분 뒤부터"). 글에 이런 말이 있는데 LLM이
 * 시작 시각을 비워 두면 시작 전에 댓글을 달아 무효가 될 수 있어, 자동으로 서지 않고 알립니다.
 */
const START_HINT = /(\d{1,2}\s*시(\s*\d{1,2}\s*분|\s*반)?|\d{1,2}:\d{2})\s*(부터|되면|에\s*시작)|\d+\s*분\s*(뒤|후)\s*(부터|에)/;

/** 연락처나 외부 링크로 이어지는 단어입니다. */
const CONTACT_WORDS = ["카톡", "카카오", "오픈채팅", "텔레", "telegram", "디코", "discord", "라인", "연락", "전화", "번호", "계좌", "주소", "링크"];

/** 계정이나 개인정보를 내보이게 하는 말입니다. 요구 문구에 있으면 자동으로 달지 않습니다. */
const PRIVATE_INFO_WORDS = [
    "비밀번호", "비번", "패스워드", "password", "아이디", "로그인", "계정", "개인정보", "주민", "카드번호", "이메일", "메일주소", "실명", "본명",
    "apikey", "api키", "토큰", "token", "웹훅", "webhook", "프롬프트", "prompt", "지시문"
];
/** 요구 문구에 있으면 자동으로 달지 않는 말입니다. "ㅅㅂ" 같은 자음은 정리하면 다른 글자가 되므로 문구와 같은 방식으로 정리해 둡니다. */
const BLOCKED_COMMENT_WORDS = [...BAIT_WORDS, ...CONTACT_WORDS, ...PRIVATE_INFO_WORDS].map(normalizeForMatch);

/**
 * 텍스트 댓글로 자동으로 달아도 되는 문구인지 확인합니다. 글 내용은 누구나 쓸 수 있으므로,
 * 내 계정으로 엉뚱한 말(봇 자백, 연락처, 링크 등)을 쓰게 만드는 시도를 막습니다.
 */
export function isSafeCommentText(text: string): boolean {
    const normalized = text.normalize("NFKC");
    if (normalized.length === 0 || normalized.length > TEXT_MAX_LENGTH) return false;
    // 제어 문자, 줄바꿈, 숨은 서식 문자(제로폭 문자, 방향 전환 문자 등)
    if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(normalized)) return false;
    // 한글, 영문, 숫자, 공백, 기본 문장부호만 허용합니다.
    if (!/^[\p{Script=Hangul}A-Za-z0-9 .,!?~^♡♥()'"_-]+$/u.test(normalized)) return false;
    const compactText = normalizeForMatch(normalized);
    // 링크처럼 보이는 것(점 뒤 영문 2자 이상), 숫자 5자리 이상(전화번호 등)
    if (/\.[a-z]{2,}/.test(compactText) || /\d{5,}/.test(compactText.replace(/[^0-9]/g, ""))) return false;
    if (BLOCKED_COMMENT_WORDS.some((word) => compactText.includes(word))) return false;
    return true;
}

function compact(text: string): string {
    return text.replace(/\s+/g, "").toLowerCase();
}

export function findDccon(dccons: OwnedDccon[], keyword: string): OwnedDccon | null {
    const needle = compact(keyword);
    if (!needle) return null;
    return dccons.find((dccon) => compact(dccon.title).includes(needle))
        ?? dccons.find((dccon) => compact(dccon.packageTitle).includes(needle))
        ?? null;
}

/**
 * LLM 판단을 실제 행동 계획으로 바꿉니다.
 *
 * @param accounts 갤러리의 대기 계정을 우선순위 순서로, 로그인된 것만 넘깁니다. 비어 있으면 줄을 설 수 없으므로 알림 계획이 됩니다.
 * @param detectedAt 글을 감지한 시각(ms)입니다.
 * @param postText 글의 제목과 본문입니다. LLM이 말한 요구 문구가 실제로 글에 있는지 확인합니다.
 * @param deadlineSlackMs 마감을 이만큼 앞당겨 봅니다. 작성 시각을 초까지 모를 때 상대 마감이 늦게 계산되는 것을 막습니다.
 */
export function makePlan(decision: Decision, gallery: GalleryConfig, accounts: CandidateAccount[], detectedAt: number, postText: string, deadlineSlackMs = 0, random: () => number = Math.random): Plan {
    if (!decision.is_giveaway) return {kind: "skip", reason: "나눔 글이 아님"};
    if (gallery.category === "food" && !decision.is_food) return {kind: "skip", reason: "음식 나눔이 아님"};

    let endsAt: number | null = null;
    if (decision.ends_at) {
        endsAt = resolveClock(decision.ends_at, detectedAt);
        if (endsAt === null) return {kind: "notify", reason: `마감 시각을 해석할 수 없음: ${brief(decision.ends_at, 20)}`};
        // 작성 시각을 초까지 모르면 "5분 후 마감" 같은 상대 마감이 실제보다 늦게 계산될 수 있어 그만큼 앞당겨 봅니다.
        endsAt -= deadlineSlackMs;
        if (endsAt - END_MARGIN_MS <= detectedAt) return {kind: "skip", reason: `마감 시각(${decision.ends_at})이 지남`};
    }

    if (accounts.length === 0) return {kind: "notify", reason: "로그인된 대기 계정이 없어 줄을 설 수 없습니다. 계정 탭에서 로그인 상태를 확인하세요."};
    const qualified = accounts.filter((account) => eligible(account, decision.member_requirement));
    if (qualified.length === 0) return {kind: "skip", reason: "참여 자격에 맞는 대기 계정이 없음"};

    if (decision.needs_extra_action) return {kind: "notify", reason: `댓글 외의 행동이 필요함: ${brief(decision.reason)}`};
    const bait = findBaitWord(postText);
    if (bait) return {kind: "notify", reason: `글에 봇을 걸러내려는 듯한 말("${bait}")이 있어 직접 확인이 필요함`};
    // LLM이 지시에 넘어가 나눔이 아닌 글을 나눔으로 판단했을 수 있으므로 자동으로 서지 않습니다.
    const injection = findInjectionWord(postText);
    if (injection) return {kind: "notify", reason: `글에 LLM 판단을 바꾸려는 듯한 말("${injection}")이 있어 직접 확인이 필요함`};
    const privacy = findPrivacyProbe(postText);
    if (privacy) return {kind: "notify", reason: `글에 개인정보나 계정·설정 정보를 캐내려는 듯한 말("${privacy}")이 있어 직접 확인이 필요함`};
    if (decision.line_method === "unclear") return {kind: "notify", reason: `줄 서는 방법을 판단할 수 없음: ${brief(decision.reason)}`};
    if (!decision.starts_at && START_HINT.test(postText)) return {kind: "notify", reason: "글에 줄 서기 시작 시각이 있는 것 같은데 판단에서 빠져 직접 확인이 필요함"};

    let notBefore = detectedAt;
    if (decision.starts_at) {
        const startsAt = resolveClock(decision.starts_at, detectedAt);
        if (startsAt === null) return {kind: "notify", reason: `시작 시각을 해석할 수 없음: ${brief(decision.starts_at, 20)}`};
        // 이미 시작했어도 정각 직후라면 여유 시간까지는 기다립니다.
        notBefore = Math.max(detectedAt, startsAt + START_MARGIN_MS);
    }
    notBefore += gallery.delaySec * 1000;
    // 줄 서기 지연이나 시작 시각 대기 때문에 마감 뒤에 댓글을 달게 되면 처음부터 서지 않습니다.
    if (endsAt !== null && notBefore > endsAt - END_MARGIN_MS) {
        return {kind: "skip", reason: `줄 서기 지연 때문에 마감 시각(${decision.ends_at}) 전에 댓글을 달 수 없음`};
    }
    const common = {notBefore, requirement: decision.member_requirement, isFood: decision.is_food, ...(endsAt !== null ? {deadline: endsAt} : {})};

    // 기본 디시콘을 정해 둔 계정은 "줄" 대신 그중 하나를 무작위로 답니다. 글이 디시콘 댓글을 인정하지 않으면 "줄"입니다.
    const pickDefault = (account: CandidateAccount): CommentContent | null => {
        const choices = decision.text_only ? [] : account.defaultDccons ?? [];
        return choices.length > 0 ? {type: "dccon", dccon: choices[Math.min(Math.floor(random() * choices.length), choices.length - 1)]!} : null;
    };

    if (decision.line_method === "text") {
        const required = decision.line_text?.trim();
        if (!required) {
            return {kind: "comment", attempts: qualified.map((account) => ({accountId: account.id, content: pickDefault(account) ?? {type: "text", text: DEFAULT_COMMENT_TEXT}})), ...common};
        }
        if (!isSafeCommentText(required)) return {kind: "notify", reason: `요구 문구를 자동으로 달기 어려움: "${brief(required, 40)}"`};
        // LLM이 지어낸 문구를 달지 않도록, 요구 문구는 글에 실제로 있어야 합니다.
        if (!normalizeForMatch(postText).includes(normalizeForMatch(required))) {
            return {kind: "notify", reason: `요구 문구가 글에 없음: "${brief(required, 40)}"`};
        }
        return {kind: "comment", attempts: qualified.map((account) => ({accountId: account.id, content: {type: "text", text: required}})), ...common};
    }

    const keyword = decision.dccon_keyword?.trim() ?? "";
    // 종류를 정하지 않은 디시콘 줄("디시콘으로 줄")에는 기본 디시콘을 답니다. 기본 디시콘이 없는 계정은 설 수 없습니다.
    if (!keyword) {
        const attempts = qualified.flatMap((account) => {
            const content = pickDefault(account);
            return content ? [{accountId: account.id, content}] : [];
        });
        if (attempts.length === 0) return {kind: "notify", reason: "디시콘으로 줄을 서야 하는데 기본 디시콘을 정한 대기 계정이 없음"};
        return {kind: "comment", attempts, ...common};
    }
    const attempts = qualified.flatMap((account) => {
        const dccon = findDccon(account.dccons, keyword);
        return dccon ? [{accountId: account.id, content: {type: "dccon" as const, dccon}}] : [];
    });
    if (attempts.length === 0) return {kind: "notify", reason: `요구 디시콘("${brief(keyword, 40)}")을 가진 대기 계정이 없음`};
    return {kind: "comment", attempts, ...common};
}

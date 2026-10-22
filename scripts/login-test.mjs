// dcinside.js 로그인 테스트: 로그인, 고닉 여부, 보유 디시콘 확인 후 원하면 댓글 1개를 직접 달아봅니다.
// 아이디와 비밀번호는 저장하지 않습니다.
import readline from "node:readline";
import {DCInside, OtpRequiredError, CaptchaRequiredError} from "@green-1052/dcinside.js";

function ask(question, {hidden = false} = {}) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({input: process.stdin, output: process.stdout, terminal: true});
        if (hidden) {
            rl._writeToOutput = (s) => {
                if (s.startsWith(question)) rl.output.write(question);
            };
        }
        rl.question(question, (answer) => {
            rl.close();
            if (hidden) process.stdout.write("\n");
            resolve(answer.trim());
        });
    });
}

const dc = new DCInside();

const id = await ask("디시 아이디: ");
const password = await ask("비밀번호(입력이 보이지 않습니다): ", {hidden: true});

let session;
try {
    session = await dc.login(id, password);
} catch (error) {
    if (error instanceof OtpRequiredError) {
        const otp = await ask("OTP 번호: ");
        session = await dc.login(id, password, {otp});
    } else if (error instanceof CaptchaRequiredError) {
        console.error("로그인에 캡차가 필요합니다. 테스트를 중단합니다:", error.message);
        process.exit(1);
    } else {
        console.error("로그인 실패:", error.message);
        process.exit(1);
    }
}

const r = session.result;
console.log("\n[로그인 성공]");
console.log("  닉네임:", r.name);
console.log("  is_gonick:", r.is_gonick, "| stype:", r.stype);

try {
    const dccons = await dc.dccons.list();
    const tabs = dccons.tab ?? [];
    const total = (dccons.list ?? []).reduce((n, group) => n + group.length, 0);
    console.log(`\n[보유 디시콘] 패키지 ${tabs.length}개, 디시콘 ${total}개`);
    for (const tab of tabs.slice(0, 5)) console.log("  -", tab.title ?? JSON.stringify(tab).slice(0, 80));
} catch (error) {
    console.error("\n[보유 디시콘] 조회 실패:", error.message);
}

// 댓글 테스트는 사람이 없는 테스트용 갤러리(asgeir)의 1번 글에서만 합니다.
const TEST_GALLERY = "asgeir";
const TEST_POST_NO = 1;
const answer = await ask(`\n${TEST_GALLERY} 갤러리 ${TEST_POST_NO}번 글에 댓글 작성까지 테스트할까요? (y/N): `);
if (answer.toLowerCase() === "y") {
    const gallery = TEST_GALLERY;
    const no = TEST_POST_NO;
    const text = (await ask("댓글 내용(기본값: 줄): ")) || "줄";
    const confirm = await ask(`${gallery} 갤러리 ${no}번 글에 "${text}" 댓글을 실제로 답니다. 진행할까요? (y/N): `);
    if (confirm.toLowerCase() === "y") {
        try {
            const result = await dc.comments.write(gallery, no, text);
            console.log("[댓글 작성 결과]", JSON.stringify(result));
        } catch (error) {
            console.error("[댓글 작성 실패]", error.constructor.name, error.message);
        }
    } else {
        console.log("댓글 작성을 취소했습니다.");
    }
}

// 디시 앱 버전 확인: 디시가 요구하는 앱 버전을 보고, 그 버전으로 새 기기 정보를 받아 asgeir 목록을 한 번 읽어 봅니다.
// 디시 요청: 버전 확인 2회, app_id 발급 1회, 목록 1회. 구글 기기 등록도 1회 일어납니다. 로그인하지 않습니다.
// 사용법: node scripts/dc-version-check.mjs [버전 이름] [버전 코드]   (생략하면 dcinside.js에 들어 있는 버전)
import {APP, DCInside} from "@green-1052/dcinside.js";

const [name = APP.versionName, code = APP.versionCode] = process.argv.slice(2);

const response = await fetch("https://json2.dcinside.com/json0/app_check_A_rina_one_new.php", {headers: {"User-Agent": "dcinside.app"}});
const [check] = await response.json();
console.log(`디시가 요구하는 버전: ${check?.ver} (강제 업데이트: ${check?.force})`);

Object.assign(APP, {versionName: name, versionCode: code});
try {
    const list = await new DCInside().articles.list({gallery: "asgeir"});
    console.log(`결과: 성공 (${name} / ${code}) - 목록 ${list.gall_list?.length ?? 0}개`);
} catch (error) {
    console.log(`결과: 실패 (${name} / ${code}) - ${String(error?.message ?? error).slice(0, 200)}`);
}

# Hamboogie

## 설치

[Releases](../../releases/latest)에서 운영체제에 맞는 파일을 받습니다.

| 운영체제 | 파일 |
| --- | --- |
| Windows | `Hamboogie-<버전>-setup.exe` |
| macOS (Apple Silicon) | `Hamboogie-<버전>-arm64.dmg` |

> [!CAUTION]
> 서명하지 않은 앱이라 아래처럼 실행을 직접 허용해야 합니다. 이 저장소의 Releases에서 받은 파일에만 허용하세요.

### Windows

설치 파일을 실행합니다. **Windows의 PC 보호** 창이 뜨면 **추가 정보 > 실행**을 누르세요. 새 버전은 앱이 받아 두었다가 다시 시작하거나 종료할 때 설치합니다.

### macOS

1. `.dmg`를 열고 `Hamboogie.app`을 **응용 프로그램** 폴더로 옮긴 뒤 엽니다.
2. **“Hamboogie”이(가) 열리지 않음** 경고가 뜨면 **완료**를 누르고, **시스템 설정 > 개인정보 보호 및 보안**의 **보안** 항목에서 **그래도 열기**를 누릅니다(경고 뒤 약 1시간 동안만 보임). [Apple 안내](https://support.apple.com/ko-kr/guide/mac-help/mchleab3a043/mac)
3. **“Hamboogie Safe Storage”** 키체인 사용을 물으면 Mac 로그인 암호를 넣고 **항상 허용**을 누릅니다. 비밀번호와 API 키를 이 키체인에 암호화해 둡니다.

macOS판은 자동으로 업데이트되지 않습니다. 앱 위쪽에 새 버전 안내가 뜨면 새 `.dmg`로 앱을 덮어쓰세요.

## 사용 팁

- 창을 닫아도 감시는 계속됩니다. 메뉴 막대(Windows는 트레이) 아이콘 메뉴에서 감시를 시작·멈추고 화면 테마(시스템 설정·밝게·어둡게)를 고릅니다.
- 컴퓨터가 잠들면 감시도 멈춥니다. 깨어나면 알아서 이어가지만 5분 넘게 잠들었다면 그사이 글은 건너뛰니, 노트북은 덮개를 연 채로 두세요.

## 개발

Node.js 22.12 이상이 필요합니다.

```sh
npm install
npm run dev          # 실행
npm run dev:offline  # 가짜 글과 계정으로 실행
npm test             # 테스트
npm run dist:mac     # macOS dmg 빌드 (release/)
npm run dist:win     # Windows 설치 파일 빌드 (release/)
```

## 라이선스

[GPL-3.0](LICENSE). 비공식 프로그램이며, 사용에 따른 책임은 사용자에게 있습니다.

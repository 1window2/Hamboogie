# Hamboogie

## 설치

[Releases](../../releases/latest) 페이지에서 받습니다.

| 운영체제 | 파일 |
| --- | --- |
| Windows | `Hamboogie-<버전>-setup.exe` |
| macOS (Apple Silicon) | `Hamboogie-<버전>-arm64.dmg` |

> [!CAUTION]
> 이 저장소의 Releases 페이지에서 받은 파일에만 아래 방법으로 실행을 허용하세요. 다른 곳에서 받은 파일은 열지 마세요.

### Windows

1. `Hamboogie-<버전>-setup.exe`를 실행해 설치합니다.
2. 코드 서명을 하지 않은 프로그램이라 **Windows의 PC 보호** 창이 뜰 수 있습니다. **추가 정보**를 누른 뒤 **실행**을 누르세요.

새 버전은 앱이 알아서 받아 두었다가, 다시 시작하거나 앱을 종료할 때 설치합니다.

### macOS

1. `.dmg`를 열고 `Hamboogie.app`을 **응용 프로그램** 폴더로 끌어다 놓습니다.
2. 앱을 엽니다.

> [!IMPORTANT]
> Apple 개발자 인증을 받지 않은 앱이라, 처음 실행하면 **“Hamboogie”이(가) 열리지 않음** 경고가 뜨며 실행이 막힙니다.
>
> 1. 경고창에서 **완료**를 누릅니다.
> 2. **시스템 설정 > 개인정보 보호 및 보안**을 열고, 아래로 스크롤해 **보안** 항목으로 갑니다.
> 3. Hamboogie가 차단됐다는 안내 옆의 **그래도 열기**를 누르고, Mac 로그인 암호를 입력합니다.
>
> **그래도 열기** 버튼은 실행이 막힌 뒤 약 1시간 동안만 보입니다. 한 번 허용하면 그다음부터는 바로 열립니다. 자세한 내용은 [Apple 공식 안내](https://support.apple.com/ko-kr/guide/mac-help/mchleab3a043/mac)를 참고하세요.

> [!NOTE]
> 비밀번호와 API 키를 macOS 키체인으로 암호화해 보관합니다. 처음 실행할 때나 새 버전으로 바꾼 뒤 **“Hamboogie Safe Storage”** 키체인 사용을 묻는 창이 뜨면, Mac 로그인 암호를 입력하고 **항상 허용**을 누르세요. 거부하면 저장된 비밀번호와 API 키를 읽지 못합니다.

macOS판은 자동으로 업데이트되지 않습니다. 새 버전이 나오면 앱 위쪽에 안내가 뜨니, 새 `.dmg`를 받아 **응용 프로그램** 폴더의 앱을 덮어쓰세요.

> [!TIP]
> 감시하는 동안에는 컴퓨터가 저절로 잠들지 않게 해 두지만, 노트북 덮개를 닫으면 잠들어 그동안은 감시가 멈춥니다. 깨어나면 인터넷 연결을 확인한 뒤 알아서 이어가고, 5분 넘게 잠들었다면 그사이 올라온 글은 건너뜁니다. 놓치지 않으려면 덮개를 연 채로 두세요.

## 개발

Node.js 22.12 이상이 필요합니다.

```sh
npm install
npm run dev          # 실행
npm run dev:offline  # 외부에 접속하지 않고 가짜 데이터로 실행
npm run dist:win     # Windows 설치 파일 빌드 (release/)
npm run dist:mac     # macOS dmg 빌드 (release/)
```

## 라이선스

[GPL-3.0](LICENSE). 비공식 프로그램이며, 사용에 따른 책임은 사용자에게 있습니다.

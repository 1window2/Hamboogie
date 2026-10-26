import {useState} from "react";
import {DEFAULT_MODELS, FREE_DAILY_LLM_REQUESTS, FREE_LLM_RPM, PROVIDER_LABELS, PROVIDERS} from "@shared/settings";
import type {DraftSetter} from "../App";
import {NumberInput} from "../components/NumberInput";
import type {AppState, LlmProviderId, Settings} from "@shared/types";
import {isDiscordWebhookUrl} from "@shared/text";
import {errorMessage} from "@shared/errors";

interface Props {
    draft: Settings;
    setDraft: DraftSetter;
    state: AppState;
    run(action: () => Promise<AppState>, keepDraft?: boolean): Promise<void>;
}

export function LlmTab({draft, setDraft, state, run}: Props) {
    const [webhookResult, setWebhookResult] = useState<{ok: boolean; message: string} | null>(null);
    const [showWebhook, setShowWebhook] = useState(false);
    const [testingWebhook, setTestingWebhook] = useState(false);
    const webhookSaved = draft.discordWebhookUrl === state.settings.discordWebhookUrl;

    return (
        <div className="stack">
            <section className="card">
                <h2>LLM</h2>
                <p className="muted">글 제목과 본문 텍스트만 보냅니다. 사용할 서비스 하나를 고르고 API 키를 입력하세요.</p>
                <p className="muted note">
                    확인할 때마다 새 글을 글 번호, 제목, 본문과 함께 묶어 LLM 요청 한 번으로 판단하고, 줄을 서야 하는 글만 따로 한 번 더 확인합니다.
                    무료 API 키는 요청 횟수 제한이 있습니다. 기본 모델(Gemini 3.5 Flash Lite)의 무료 등급은 분당 15회, 하루 500회이고, 앱은 여유를 두고 그보다 적게 보냅니다.
                </p>
                <div className="row">
                    {PROVIDERS.map((provider) => (
                        <label key={provider} className="check">
                            <input type="radio" name="provider" checked={draft.llm.provider === provider}
                                   onChange={() => setDraft({...draft, llm: {...draft.llm, provider}})}/>
                            {PROVIDER_LABELS[provider]}{provider === "gemini" && " (기본)"}
                        </label>
                    ))}
                </div>
                {PROVIDERS.map((provider) => (
                    <ProviderRow key={provider} provider={provider} draft={draft} setDraft={setDraft} state={state} run={run}/>
                ))}
                <div className="field">
                    <label className="check">
                        <input type="checkbox" checked={draft.llm.paidPlan}
                               onChange={(event) => setDraft({...draft, llm: {...draft.llm, paidPlan: event.target.checked}})}/>
                        유료 요금제 사용 중
                    </label>
                    {draft.llm.paidPlan ? (
                        <label className="field">
                            <span>분당 요청 상한</span>
                            <NumberInput value={draft.llm.requestsPerMinute} min={0}
                                         onChange={(requestsPerMinute) => setDraft({...draft, llm: {...draft.llm, requestsPerMinute}})}/>
                            <small className="muted">사용 중인 요금제의 분당 요청 한도에 맞추세요. 0이면 제한하지 않습니다.</small>
                        </label>
                    ) : (
                        <small className="muted">
                            무료 등급 한도에 맞춰 모든 갤러리를 합쳐 분당 {FREE_LLM_RPM}회, 하루 {FREE_DAILY_LLM_REQUESTS}회까지만 보냅니다.
                            하루 요청을 다 쓰면 한도가 초기화될 때까지 감시를 쉽니다. 감시 간격이 길수록 하루에 더 오래 감시합니다(1분 간격이면 약 8시간, 3분이면 하루 종일).
                            유료 요금제를 쓰면 하루 제한이 없습니다.
                        </small>
                    )}
                    <small className="muted">
                        오늘 쓴 LLM 요청: {state.llmUsage.count}회{state.llmUsage.limit > 0 ? ` / ${state.llmUsage.limit}회` : ""}
                        {" "}(한국 시간 {new Date(state.llmUsage.resetAt).toLocaleTimeString("ko-KR", {hour: "numeric", minute: "2-digit", timeZone: "Asia/Seoul"})}에 초기화)
                    </small>
                </div>
            </section>

            <section className="card">
                <h2>Discord 알림</h2>
                <p className="muted">줄 서기에 실패했거나 자동으로 판단할 수 없는 글이 있을 때 알림을 보냅니다.</p>
                <label className="check">
                    <input type="checkbox" checked={draft.notifyOnSuccess}
                           onChange={(event) => setDraft({...draft, notifyOnSuccess: event.target.checked})}/>
                    줄 서기에 성공했을 때도 알림 받기
                </label>
                <label className="field">
                    <span>웹훅 주소</span>
                    <div className="row">
                        {/* 웹훅 주소를 아는 사람은 누구나 알림을 보낼 수 있어서 기본으로 가립니다. */}
                        <input type={showWebhook ? "text" : "password"} value={draft.discordWebhookUrl} autoComplete="off"
                               placeholder="https://discord.com/api/webhooks/…"
                               onChange={(event) => {
                                   setDraft({...draft, discordWebhookUrl: event.target.value});
                                   setWebhookResult(null);
                               }}/>
                        <button className="button small" onClick={() => setShowWebhook(!showWebhook)}>{showWebhook ? "가리기" : "보기"}</button>
                    </div>
                    {draft.discordWebhookUrl.trim() && !isDiscordWebhookUrl(draft.discordWebhookUrl.trim()) && (
                        <small className="error-text">Discord 웹훅 주소가 아닙니다. Discord 채널 설정 → 연동 → 웹후크에서 복사한 https://discord.com/api/webhooks/… 주소를 넣으세요.</small>
                    )}
                </label>
                <div className="row">
                    <button className="button small" disabled={!webhookSaved || !draft.discordWebhookUrl || testingWebhook}
                            title={!webhookSaved ? "설정을 먼저 저장하세요" : undefined}
                            onClick={() => {
                                setTestingWebhook(true);
                                setWebhookResult(null);
                                void window.hamboogie.testWebhook()
                                    .then(setWebhookResult, (caught: unknown) => setWebhookResult({ok: false, message: errorMessage(caught)}))
                                    .finally(() => setTestingWebhook(false));
                            }}>
                        {testingWebhook ? "보내는 중…" : "테스트 알림 보내기"}
                    </button>
                    {webhookResult && <span className={webhookResult.ok ? "ok-text" : "error-text"}>{webhookResult.message}</span>}
                </div>
            </section>
        </div>
    );
}

function ProviderRow({provider, draft, setDraft, state, run}: Props & {provider: LlmProviderId}) {
    const [apiKey, setApiKey] = useState("");
    const hasKey = state.secretsSet[`llm:${provider}`] === true;
    return (
        <div className="provider-row">
            <strong>{PROVIDER_LABELS[provider]}</strong>
            <label className="field">
                <span>모델</span>
                <input value={draft.llm.models[provider]} placeholder={DEFAULT_MODELS[provider]}
                       onChange={(event) => setDraft({...draft, llm: {...draft.llm, models: {...draft.llm.models, [provider]: event.target.value}}})}/>
            </label>
            <label className="field">
                <span>API 키 {hasKey && <em className="ok-text">(저장됨)</em>}</span>
                <div className="row">
                    <input type="password" value={apiKey} autoComplete="off" placeholder={hasKey ? "바꾸려면 새로 입력" : ""}
                           onChange={(event) => setApiKey(event.target.value)}/>
                    <button className="button small" disabled={!apiKey}
                            onClick={() => run(() => window.hamboogie.setSecret(`llm:${provider}`, apiKey.trim()), true).then(() => setApiKey(""))}>
                        저장
                    </button>
                    {hasKey && (
                        <button className="button small" onClick={() => run(() => window.hamboogie.setSecret(`llm:${provider}`, ""), true)}>지우기</button>
                    )}
                </div>
            </label>
        </div>
    );
}

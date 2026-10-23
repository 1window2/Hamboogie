import {useState} from "react";
import {DEFAULT_MODELS, FREE_LLM_RPM, PROVIDER_LABELS} from "@shared/settings";
import {NumberInput} from "../components/NumberInput";
import type {AppState, LlmProviderId, Settings} from "@shared/types";

interface Props {
    draft: Settings;
    setDraft(settings: Settings): void;
    state: AppState;
    run(action: () => Promise<AppState>, keepDraft?: boolean): Promise<void>;
}

const PROVIDERS: LlmProviderId[] = ["gemini", "openai", "claude"];

export function LlmTab({draft, setDraft, state, run}: Props) {
    const [webhookResult, setWebhookResult] = useState<{ok: boolean; message: string} | null>(null);
    const [showWebhook, setShowWebhook] = useState(false);
    const webhookSaved = draft.discordWebhookUrl === state.settings.discordWebhookUrl;

    return (
        <div className="stack">
            <section className="card">
                <h2>LLM</h2>
                <p className="muted">글 제목과 본문 텍스트만 보냅니다. 사용할 서비스 하나를 고르고 API 키를 입력하세요.</p>
                <p className="muted note">
                    무료 API 키는 요청 횟수 제한이 있습니다(예: Gemini 무료 등급은 모델당 분당 약 5회).
                    감시하는 갤러리가 많거나 키워드가 비어 있으면 한도에 걸려 판단이 실패할 수 있습니다.
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
                        <small className="muted">무료 등급 한도에 맞춰 모든 갤러리를 합쳐 분당 {FREE_LLM_RPM}회까지만 보냅니다.</small>
                    )}
                    <small className="muted">
                        감시 간격이 1분 이상이면 한 번 확인할 때 이 한도를 다 쓰고, 1분보다 짧거나 갤러리가 여럿이면 1분 동안의 확인 횟수로 나눠 씁니다.
                        판단할 글이 쓸 수 있는 요청 수보다 많으면 여러 글을 한 요청에 묶어 보냅니다.
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
                               onChange={(event) => setDraft({...draft, discordWebhookUrl: event.target.value})}/>
                        <button className="button small" onClick={() => setShowWebhook(!showWebhook)}>{showWebhook ? "가리기" : "보기"}</button>
                    </div>
                </label>
                <div className="row">
                    <button className="button small" disabled={!webhookSaved || !draft.discordWebhookUrl}
                            title={!webhookSaved ? "설정을 먼저 저장하세요" : undefined}
                            onClick={() => window.hamboogie.testWebhook().then(setWebhookResult)}>
                        테스트 알림 보내기
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

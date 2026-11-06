import {useState} from "react";
import {DEFAULT_MODELS, FREE_DAILY_LLM_REQUESTS, FREE_LLM_RPM, LLM_RPM_MAX, MODEL_NAME_PATTERN, POST_IMAGES_MAX, PROVIDER_LABELS, PROVIDERS} from "@shared/settings";
import type {SettingsTabProps} from "../App";
import {NumberInput} from "../components/NumberInput";
import {SecretField} from "../components/SecretField";
import type {LlmConfig, LlmProviderId} from "@shared/types";
import {isDiscordWebhookUrl} from "@shared/text";
import {errorMessage} from "@shared/errors";
import {kstClockText} from "@shared/time";

type Props = SettingsTabProps;

export function LlmTab({draft, setDraft, state, run}: Props) {
    const [webhookResult, setWebhookResult] = useState<{ok: boolean; message: string} | null>(null);
    const [showWebhook, setShowWebhook] = useState(false);
    const [testingWebhook, setTestingWebhook] = useState(false);
    const webhookSaved = draft.discordWebhookUrl === state.settings.discordWebhookUrl;
    const updateLlm = (patch: Partial<LlmConfig>) => setDraft((prev) => ({...prev, llm: {...prev.llm, ...patch}}));

    return (
        <div className="stack">
            <section className="card">
                <h2>LLM</h2>
                <p className="muted">글 제목과 본문 텍스트를 보내고, 나눔으로 보인 글은 글에 올린 사진(앞의 최대 {POST_IMAGES_MAX}장)도 함께 보냅니다. 사용할 서비스 하나를 고르고 API 키를 입력하세요.</p>
                <p className="muted note">
                    확인할 때마다 새 글을 글 번호, 제목, 본문과 함께 묶어 LLM 요청 한 번으로 판단하고, 줄을 서야 하는 글만 따로(사진이 있으면 사진까지) 한 번 더 확인합니다.
                    무료 API 키는 요청 횟수 제한이 있습니다. 기본 모델(Gemini 3.5 Flash Lite)의 무료 등급은 분당 15회, 하루 500회이고, 앱은 여유를 두고 그보다 적게 보냅니다.
                </p>
                <div className="row">
                    {PROVIDERS.map((provider) => (
                        <label key={provider} className="check">
                            <input type="radio" name="provider" checked={draft.llm.provider === provider}
                                   onChange={() => updateLlm({provider})}/>
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
                               onChange={(event) => updateLlm({paidPlan: event.target.checked})}/>
                        유료 요금제 사용 중
                    </label>
                    {draft.llm.paidPlan ? (
                        <label className="field">
                            <span>분당 요청 상한</span>
                            <NumberInput className="short" value={draft.llm.requestsPerMinute} min={0} onChange={(requestsPerMinute) => updateLlm({requestsPerMinute})}/>
                            <small className={draft.llm.requestsPerMinute > LLM_RPM_MAX ? "error-text" : "muted"}>
                                사용 중인 요금제의 분당 요청 한도에 맞추세요. 0이면 제한하지 않습니다. 최대 {LLM_RPM_MAX}회이고, 넘으면 저장할 때 맞춰집니다.
                            </small>
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
                        {" "}(한국 시간 {kstClockText(state.llmUsage.resetAt)}에 초기화)
                    </small>
                </div>
            </section>

            <section className="card">
                <h2>Discord 알림</h2>
                <p className="muted">줄 서기에 실패했거나 자동으로 판단할 수 없는 글이 있을 때 알림을 보냅니다.</p>
                <label className="check">
                    <input type="checkbox" checked={draft.notifyOnSuccess}
                           onChange={(event) => {
                               const notifyOnSuccess = event.target.checked;
                               setDraft((prev) => ({...prev, notifyOnSuccess}));
                           }}/>
                    줄 서기에 성공했을 때도 알림 받기
                </label>
                <label className="field">
                    <span>웹훅 주소</span>
                    <div className="row">
                        {/* 웹훅 주소를 아는 사람은 누구나 알림을 보낼 수 있어서 기본으로 가립니다. */}
                        <input type={showWebhook ? "text" : "password"} value={draft.discordWebhookUrl} autoComplete="off"
                               placeholder="https://discord.com/api/webhooks/…"
                               onChange={(event) => {
                                   const discordWebhookUrl = event.target.value;
                                   setDraft((prev) => ({...prev, discordWebhookUrl}));
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
    const hasKey = state.secretsSet[`llm:${provider}`] === true;
    const model = draft.llm.models[provider].trim();
    // 저장할 때 형식이 맞지 않는 이름은 기본 모델로 바뀌므로 미리 알립니다.
    const badModel = model !== "" && !MODEL_NAME_PATTERN.test(model);
    return (
        <div className="provider-row">
            <strong>{PROVIDER_LABELS[provider]}</strong>
            <label className="field">
                <span>모델</span>
                <input value={draft.llm.models[provider]} placeholder={DEFAULT_MODELS[provider]} aria-invalid={badModel}
                       onChange={(event) => {
                           const value = event.target.value;
                           setDraft((prev) => ({...prev, llm: {...prev.llm, models: {...prev.llm.models, [provider]: value}}}));
                       }}/>
                {badModel && <small className="error-text">모델 이름에는 영문, 숫자, 점(.), 밑줄(_), 하이픈(-), 콜론(:)만 쓸 수 있습니다. 이대로 저장하면 기본 모델({DEFAULT_MODELS[provider]})을 씁니다.</small>}
            </label>
            <SecretField label="API 키" saved={hasKey} trim
                         onSave={(apiKey) => run(() => window.hamboogie.setSecret(`llm:${provider}`, apiKey), true)}
                         clear={{
                             confirm: {
                                 title: `${PROVIDER_LABELS[provider]} API 키를 지울까요?`,
                                 message: <p>이 컴퓨터에 저장된 키를 지웁니다. 다시 쓰려면 키를 새로 입력해야 합니다.</p>,
                                 confirmLabel: "지우기"
                             },
                             onClear: () => run(() => window.hamboogie.setSecret(`llm:${provider}`, ""), true)
                         }}/>
        </div>
    );
}

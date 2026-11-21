import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import {
  keyPageOf,
  MODEL_PROVIDER_PRESETS,
  ONBOARDING_ENV_KEYS,
  type ModelProviderPreset,
  type OnboardingConnectAnswer,
  type OnboardingDetectAnswer,
  type OnboardingVerifyResult,
} from "@tavi/contracts";

import { useLoaded } from "../../hooks/use-loaded.js";
import { delay } from "../../lib/delay.js";
import { hostOf } from "../../lib/format.js";
import { Icon } from "../../ui/Icon.js";
import {
  connectDetected,
  connectKey,
  detectProviders,
  loadStatus,
  setRole,
  signInStatus,
  startChatGptSignIn,
  startSignIn,
  verifyTarget,
} from "./onboarding-api.js";
import { type StepProps, useFocusOnEnter, Working } from "./WelcomeStepParts.js";
import { Failure, Notice } from "../../ui/Parts.js";
import { Button } from "../../ui/Button.js";
import { Field } from "../../ui/Field.js";
import { Select } from "../../ui/Select.js";
import { Command } from "../../ui/Command.js";

const preset = (id: string): ModelProviderPreset | undefined => MODEL_PROVIDER_PRESETS.find((candidate) => candidate.id === id);
/**
 * Sign in with ChatGPT as a tile: not a preset, since no key is
 * typed for it — the owner signs in and stores the token record — but shown
 * beside them, labelled a preview and naming what pays.
 */
const CHATGPT_TILE: ModelProviderPreset = {
  id: "chatgpt",
  name: "ChatGPT",
  kind: "openai-compatible",
  baseUrl: "https://api.openai.com/v1",
  requiresKey: true,
  localOnly: false,
  docsUrl: "https://developers.openai.com/siwc",
};
export function ModelStep(props: StepProps) {
  const { client, workspaceId } = props;
  const { data: detected } = useLoaded(() => detectProviders(client, workspaceId), [client, workspaceId]);
  const [chosen, setChosen] = useState<ModelProviderPreset>();
  const [more, setMore] = useState(false);
  const [connection, setConnection] = useState<OnboardingConnectAnswer>();
  const [working, setWorking] = useState<string>();
  const [problem, setProblem] = useState<string>();
  // The endpoint last typed, so *Change the key* asks for the key alone.
  const [lastBaseUrl, setLastBaseUrl] = useState<string>();
  const connected = (answer: OnboardingConnectAnswer): void => {
    setConnection(answer);
    setProblem(undefined);
  };
  const run = async (
    what: string,
    work: () => Promise<{ ok: true; value: OnboardingConnectAnswer } | { ok: false; message: string }>,
  ): Promise<void> => {
    setWorking(what);
    const answer = await work();
    setWorking(undefined);
    if (answer.ok) connected(answer.value);
    else setProblem(answer.message);
  };
  // A key typed for a preset can be typed again for it: the owner reuses the connection setup made.
  const rekey = chosen !== undefined && chosen.id !== CHATGPT_TILE.id && !chosen.localOnly;
  if (connection !== undefined && chosen !== undefined)
    return (
      <RolePicker
        {...props}
        preset={chosen}
        connection={connection}
        onAnother={() => {
          setConnection(undefined);
          setChosen(undefined);
        }}
        {...(rekey ? { onChangeKey: () => setConnection(undefined) } : {})}
      />
    );
  const featured = (props.step.featured ?? []).map(preset).filter((candidate): candidate is ModelProviderPreset => candidate !== undefined);
  const tiles = more ? MODEL_PROVIDER_PRESETS : featured.length > 0 ? featured : MODEL_PROVIDER_PRESETS;
  return (
    <div className="welcome-model">
      {/* What was found is a shortcut among the providers: once one is picked, its own form is the whole step. */}
      {detected === undefined || chosen !== undefined ? null : (
        <DetectedChoices
          detected={detected}
          onUse={(presetId, variable) => {
            setChosen(preset(presetId));
            void run(`Connecting ${preset(presetId)?.name ?? presetId}…`, () => connectDetected(client, workspaceId, presetId, variable));
          }}
        />
      )}
      {chosen === undefined ? (
        <>
          <ul className="provider-grid list-reset" aria-label="Model providers">
            {tiles.map((candidate) => (
              <li key={candidate.id}>
                <Button
                  className={props.step.recommended === candidate.id ? "provider-tile recommended" : "provider-tile"}
                  onClick={() => setChosen(candidate)}
                >
                  <span className="provider-tile-name">
                    {candidate.name}
                    {props.step.recommended === candidate.id ? <span className="badge">Recommended</span> : null}
                  </span>
                  <span className="provider-tile-meta">{candidate.baseUrl === "" ? "Your endpoint" : hostOf(candidate.baseUrl)}</span>
                  <span className="provider-tile-meta">
                    {candidate.localOnly
                      ? "On this computer: free and private; small models do agent work less well"
                      : candidate.id === "custom"
                        ? "Any OpenAI-compatible server"
                        : "Billed per use with your key"}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
          {props.status.chatGptSignIn === true ? (
            <ul className="provider-grid list-reset" aria-label="Sign in with a plan">
              <li>
                <Button className="provider-tile" onClick={() => setChosen(CHATGPT_TILE)}>
                  <span className="provider-tile-name">
                    ChatGPT<span className="badge">Preview</span>
                  </span>
                  <span className="provider-tile-meta">Sign in; uses your ChatGPT plan's allowance</span>
                </Button>
              </li>
            </ul>
          ) : null}
          {more ? null : (
            <Button variant="link" onClick={() => setMore(true)}>
              Show all providers
            </Button>
          )}
        </>
      ) : chosen.id === CHATGPT_TILE.id ? (
        <ChatGptSignIn {...props} onBack={() => setChosen(undefined)} onSignedIn={(answer) => connected(answer)} onProblem={setProblem} />
      ) : (
        <KeyForm
          {...props}
          preset={chosen}
          busy={working !== undefined}
          baseUrl={lastBaseUrl}
          onBack={() => setChosen(undefined)}
          onKey={(key, baseUrl) => {
            setLastBaseUrl(baseUrl);
            void run(`Connecting ${chosen.name}…`, () => connectKey(client, workspaceId, chosen.id, key, baseUrl));
          }}
          onSignedIn={(answer) => connected(answer)}
          onProblem={setProblem}
        />
      )}
      {working === undefined ? null : <Working>{working}</Working>}
      {problem === undefined ? null : <Failure>{problem}</Failure>}
    </div>
  );
}
function DetectedChoices({
  detected,
  onUse,
}: {
  readonly detected: OnboardingDetectAnswer;
  readonly onUse: (preset: string, variable?: (typeof detected.env)[number]) => void;
}) {
  const local = detected.local.filter((server) => server.models > 0);
  const empty = detected.local.filter((server) => server.toolCapableModels === 0);
  return (
    <div className="welcome-detected">
      {detected.env.map((variable) => {
        const presetId = Object.entries(ONBOARDING_ENV_KEYS).find(([, names]) => (names as readonly string[]).includes(variable))?.[0];
        return presetId === undefined ? null : (
          <Button size="sm" key={variable} onClick={() => onUse(presetId, variable)}>
            Use the {variable} found in the owner's environment
          </Button>
        );
      })}
      {local
        .filter((server) => server.toolCapableModels > 0)
        .map((server) => (
          <Button size="sm" key={server.preset} onClick={() => onUse(server.preset)}>
            {preset(server.preset)?.name ?? server.preset} is running with {server.models} model{server.models === 1 ? "" : "s"}
          </Button>
        ))}
      {empty.map((server) => (
        <Notice key={server.preset}>
          {preset(server.preset)?.name ?? server.preset} is running but has no model that can use tools: <code>ollama pull qwen3</code>
        </Notice>
      ))}
      {detected.service === true && detected.env.length === 0 ? (
        <Notice>
          Keys in your shell aren't visible to the service. Paste the key, or run <Command>tavi onboard</Command> in a terminal to import
          it.
        </Notice>
      ) : null}
    </div>
  );
}
/** Aborts when the step is left (Back, another step, away from Welcome), so a sign-in's wait stops with it. */
function useLeftSignal(): { readonly current: AbortSignal } {
  const left = useRef<AbortSignal>(new AbortController().signal);
  useEffect(() => {
    const controller = new AbortController();
    left.current = controller.signal;
    return () => controller.abort();
  }, []);
  return left;
}
function KeyForm(
  props: StepProps & {
    readonly preset: ModelProviderPreset;
    readonly busy: boolean;
    readonly baseUrl?: string | undefined;
    readonly onBack: () => void;
    readonly onKey: (key: string, baseUrl?: string) => void;
    readonly onSignedIn: (answer: OnboardingConnectAnswer) => void;
    readonly onProblem: (message: string | undefined) => void;
  },
) {
  const keyId = useId();
  const urlId = useId();
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(props.baseUrl ?? "");
  const [pasting, setPasting] = useState(props.preset.id !== "openrouter");
  const entered = useFocusOnEnter(pasting);
  const [signingIn, setSigningIn] = useState<string>();
  // Left (Back, another step, away from Welcome): the wait for OpenRouter stops.
  const left = useLeftSignal();
  const custom = props.preset.baseUrl === "";
  const keyless = props.preset.localOnly;
  const signIn = async (): Promise<void> => {
    props.onProblem(undefined);
    const started = await startSignIn(props.client, props.workspaceId, props.origin ?? window.location.origin);
    if (left.current.aborted) return;
    if (!started.ok) return props.onProblem(started.message);
    // Opened after an await, so a browser may block the tab: the address is also a link on the page.
    (props.openUrl ?? ((url: string) => void window.open(url, "_blank", "noopener")))(started.value.url);
    setSigningIn(started.value.url);
    for (let tries = 0; tries < 300; tries += 1) {
      await delay(2_000, left.current, { onAbort: "resolve" });
      if (left.current.aborted) return;
      const state = await signInStatus(props.client, props.workspaceId, started.value.state);
      if (left.current.aborted) return;
      if (!state.ok || state.value.state === "waiting") continue;
      setSigningIn(undefined);
      if (state.value.state === "done" && state.value.connection !== undefined) return props.onSignedIn(state.value.connection);
      return props.onProblem(state.value.message ?? "The sign-in did not finish.");
    }
    setSigningIn(undefined);
    props.onProblem("The sign-in took too long. Start it again.");
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!keyless && key.trim() === "") return props.onProblem("Paste the key.");
    props.onKey(keyless ? "local-no-key" : key.trim(), custom ? baseUrl.trim() : undefined);
  };
  return (
    <div className="welcome-key" ref={entered}>
      {props.preset.note === undefined ? null : <Notice>{props.preset.note}</Notice>}
      {props.preset.id === "openrouter" && !pasting ? (
        <div className="actions">
          <Button variant="ghost" onClick={props.onBack}>
            Back
          </Button>
          <Button variant="primary" disabled={signingIn !== undefined} onClick={() => void signIn()}>
            {signingIn !== undefined ? "Waiting for OpenRouter…" : "Sign in with OpenRouter"}
          </Button>
          <Button variant="ghost" onClick={() => setPasting(true)}>
            Paste a key instead
          </Button>
          {signingIn === undefined ? null : (
            <Working>
              Finish signing in in the tab that opened (
              <a href={signingIn} target="_blank" rel="noopener noreferrer">
                open OpenRouter
              </a>{" "}
              if none did); this page continues on its own.
            </Working>
          )}
        </div>
      ) : (
        <form onSubmit={submit}>
          {custom ? (
            <p>
              <Field id={urlId} label="Its OpenAI-compatible endpoint">
                <input
                  type="url"
                  required
                  value={baseUrl}
                  placeholder="https://example.com/v1"
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </Field>
            </p>
          ) : null}
          {keyless ? (
            <p>No key is needed: Tavi stores a placeholder the local server ignores.</p>
          ) : (
            <p>
              <Field
                id={keyId}
                label={`${props.preset.name} key`}
                hintAs="span"
                hintClassName="hint"
                hint={
                  <>
                    Never shown again once stored.{" "}
                    <a href={keyPageOf(props.preset)} target="_blank" rel="noreferrer">
                      Create a key
                    </a>
                  </>
                }
              >
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  maxLength={16_384}
                  onChange={(event) => setKey(event.target.value)}
                />
              </Field>
            </p>
          )}
          <div className="actions">
            <Button variant="ghost" onClick={props.onBack}>
              Back
            </Button>
            <Button variant="primary" type="submit" disabled={props.busy}>
              {props.busy ? "Connecting…" : "Connect"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
/**
 * Sign in with ChatGPT: *Continue with ChatGPT* (OpenAI's wording)
 * opens its sign-in in a new tab; the owner's own loopback takes the browser's
 * return, stores the token record, and the page reads how it stands. Left, the
 * wait stops; too long, it says so.
 */
function ChatGptSignIn(
  props: StepProps & {
    readonly onBack: () => void;
    readonly onSignedIn: (answer: OnboardingConnectAnswer) => void;
    readonly onProblem: (message: string | undefined) => void;
  },
) {
  const entered = useFocusOnEnter();
  const [waiting, setWaiting] = useState<string>();
  const left = useLeftSignal();
  const signIn = async (): Promise<void> => {
    props.onProblem(undefined);
    const started = await startChatGptSignIn(props.client, props.workspaceId);
    if (left.current.aborted) return;
    if (!started.ok) return props.onProblem(started.message);
    (props.openUrl ?? ((url: string) => void window.open(url, "_blank", "noopener")))(started.value.url);
    setWaiting(started.value.url);
    for (let tries = 0; tries < 300; tries += 1) {
      await delay(2_000, left.current, { onAbort: "resolve" });
      if (left.current.aborted) return;
      const state = await signInStatus(props.client, props.workspaceId, started.value.state);
      if (left.current.aborted) return;
      if (!state.ok || state.value.state === "waiting") continue;
      setWaiting(undefined);
      if (state.value.state === "done" && state.value.connection !== undefined) return props.onSignedIn(state.value.connection);
      return props.onProblem(state.value.message ?? "The sign-in did not finish.");
    }
    setWaiting(undefined);
    props.onProblem("The sign-in took too long. Start it again.");
  };
  return (
    <div className="welcome-key" ref={entered}>
      <Notice>
        A preview of OpenAI's: answers use your ChatGPT plan's allowance, which ChatGPT Settings → Usage shows and limits. This computer's
        browser must be the one that signs in.
      </Notice>
      <div className="actions">
        <Button variant="ghost" onClick={props.onBack}>
          Back
        </Button>
        <Button variant="primary" disabled={waiting !== undefined} onClick={() => void signIn()}>
          {waiting !== undefined ? "Waiting for ChatGPT…" : "Continue with ChatGPT"}
        </Button>
      </div>
      {waiting === undefined ? null : (
        <Working>
          Finish signing in in the tab that opened (
          <a href={waiting} target="_blank" rel="noopener noreferrer">
            open ChatGPT
          </a>{" "}
          if none did); this page continues on its own.
        </Working>
      )}
    </div>
  );
}
/**
 * The models for each role, verified before either is set. A key the provider
 * refused (`auth`) can be typed again for the same provider with *Change the
 * key*, beside Retry.
 */
function RolePicker(
  props: StepProps & {
    readonly preset: ModelProviderPreset;
    readonly connection: OnboardingConnectAnswer;
    readonly onAnother: () => void;
    readonly onChangeKey?: () => void;
  },
) {
  const entered = useFocusOnEnter();
  const mainId = useId();
  const fastId = useId();
  const models = props.connection.models;
  const [main, setMain] = useState(props.connection.suggested?.main ?? models[0] ?? "");
  const [fast, setFast] = useState(props.connection.suggested?.fast ?? "");
  const [working, setWorking] = useState<string>();
  const [results, setResults] = useState<readonly OnboardingVerifyResult[]>();
  const [problem, setProblem] = useState<string>();
  const verify = async (): Promise<void> => {
    setProblem(undefined);
    setResults(undefined);
    setWorking(`Checking ${main} with one short request…`);
    const done: OnboardingVerifyResult[] = [];
    const mainVerified = await verifyTarget(props.client, props.workspaceId, "main", props.connection.connectionId, main);
    if (!mainVerified.ok) {
      setWorking(undefined);
      return setProblem(mainVerified.message);
    }
    const mainResult = mainVerified.value.results[0];
    if (mainResult !== undefined) done.push(mainResult);
    // Made the default once it passed (a failed verify changes nothing configured).
    if (mainResult?.ok === true) {
      const set = await setRole(props.client, props.workspaceId, "main", props.connection.connectionId, main);
      if (!set.ok) {
        // It answered, but it is not the default: nothing to continue with.
        setWorking(undefined);
        return setProblem(`${main} answered, but it was not made the default: ${set.message}`);
      }
      if (fast !== "" && fast !== main) {
        const fastVerified = await verifyTarget(props.client, props.workspaceId, "fast", props.connection.connectionId, fast);
        const fastResult = fastVerified.ok ? fastVerified.value.results[0] : undefined;
        if (!fastVerified.ok) setProblem(`The fast model was not checked: ${fastVerified.message}`);
        if (fastResult?.ok === true) {
          const setFast = await setRole(props.client, props.workspaceId, "fast", props.connection.connectionId, fast);
          done.push(
            setFast.ok
              ? fastResult
              : { ...fastResult, ok: false, advice: `It answered, but it was not made the fast model: ${setFast.message}` },
          );
        } else if (fastResult !== undefined) done.push(fastResult);
      }
      props.onModelsChanged?.();
      const status = await loadStatus(props.client, props.workspaceId);
      if (status.ok) props.onStatus(status.value);
    }
    setWorking(undefined);
    setResults(done);
  };
  const mainResult = results?.find((result) => result.role === "main");
  const keyRefused = mainResult?.ok === false && mainResult.errorCode === "auth";
  return (
    <div className="welcome-roles" ref={entered}>
      <p>
        <Field id={mainId} label="Main model">
          <Select value={main} onChange={(event) => setMain(event.target.value)}>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </Select>
        </Field>
      </p>
      <p>
        <Field id={fastId} label="Fast model (summaries and ideas)">
          <Select value={fast} onChange={(event) => setFast(event.target.value)}>
            <option value="">The main model</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </Select>
        </Field>
      </p>
      <div className="actions">
        <Button variant="ghost" onClick={props.onAnother}>
          Choose another provider
        </Button>
        {keyRefused && props.onChangeKey !== undefined ? (
          <Button variant="ghost" onClick={props.onChangeKey}>
            Change the key
          </Button>
        ) : null}
        <Button variant="primary" disabled={working !== undefined || main === ""} onClick={() => void verify()}>
          {mainResult === undefined ? "Verify" : "Retry"}
        </Button>
      </div>
      {working === undefined ? null : <Working>{working}</Working>}
      {(results ?? []).map((result) => (
        <p key={result.role} className={result.ok ? "success" : "failure"} role={result.ok ? "status" : "alert"}>
          {result.ok ? (
            <>
              <Icon name="check" size="sm" /> {`${result.role === "main" ? "Inference ready" : "Fast model ready"}: ${result.model}`}
            </>
          ) : (
            <>
              <Icon name="close" size="sm" /> <span className="visually-hidden">Failed: </span>
              {`${result.model}: ${result.advice ?? result.errorCode ?? "it failed"}`}
            </>
          )}
          {result.ok && result.advice !== undefined ? ` — ${result.advice}` : ""}
        </p>
      ))}
      {problem === undefined ? null : <Failure>{problem}</Failure>}
    </div>
  );
}
